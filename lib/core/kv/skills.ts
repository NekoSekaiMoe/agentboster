import {
  parseSkillManifest,
  persistManualSkillToBlob,
  removeSkillFilesFromBlob,
  updateSkillFileInBlob,
} from '@/lib/core/blob/skills';
import { del, get, set } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';
import type {
  ActiveImportJobSummary,
  SkillDetail,
  SkillFile,
  SkillIndex,
  SkillMeta,
} from '@/types/skills';
import {
  SKILLS_INDEX_KEY,
  clawhubManifestSchema,
  skillDetailListSchema,
  skillDetailSchema,
  skillIndexSchema,
  toRepoSkillNamesKey,
  toSkillDetailKey,
  toSkillMeta,
} from '@/types/skills';
import { z } from 'zod';

const logger = createLogger('kv.skills');

const repoSkillNamesSchema = z.array(z.string().min(1));

// ─── KV migration helpers ───

function coerceSourceType(v: unknown): 'git' | 'manual' | 'clawhub' {
  if (v === 'git' || v === 'manual' || v === 'clawhub') return v;
  return 'manual';
}

function normalizeRawIndex(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.skills)) return raw;
  return {
    ...obj,
    skills: obj.skills.map((skill: unknown) => {
      if (!skill || typeof skill !== 'object') return skill;
      const s = skill as Record<string, unknown>;
      return { ...s, sourceType: coerceSourceType(s.sourceType) };
    }),
  };
}

function normalizeRawDetail(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  return { ...obj, sourceType: coerceSourceType(obj.sourceType) };
}

// ─── Dedup helpers ───

function normalizeSkillDetails(details: SkillDetail[]): SkillDetail[] {
  const byName = new Map<string, SkillDetail>();
  for (const detail of details) {
    byName.set(detail.name, detail);
  }
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function normalizeNames(names: string[]): string[] {
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

// ─── Raw KV reads / writes ───

export async function readSkillIndexRaw(): Promise<SkillIndex> {
  const raw = await get(SKILLS_INDEX_KEY);
  if (!raw) {
    return { skills: [], updateTime: 0, activeImportJobs: [] };
  }
  try {
    return skillIndexSchema.parse(normalizeRawIndex(raw));
  } catch (error) {
    logger.warn('readSkillIndexRaw:invalid', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { skills: [], updateTime: 0, activeImportJobs: [] };
  }
}

export async function writeSkillIndexRaw(
  index: SkillIndex,
): Promise<SkillIndex> {
  const parsed = skillIndexSchema.parse(index);
  await set(SKILLS_INDEX_KEY, JSON.stringify(parsed));
  return parsed;
}

async function readSkillDetailRaw(name: string): Promise<SkillDetail | null> {
  const raw = await get(toSkillDetailKey(name));
  if (!raw) return null;
  try {
    return skillDetailSchema.parse(normalizeRawDetail(raw));
  } catch (error) {
    logger.warn('readSkillDetailRaw:invalid', {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function writeSkillDetailRaw(detail: SkillDetail): Promise<SkillDetail> {
  const parsed = skillDetailSchema.parse(detail);
  await set(toSkillDetailKey(parsed.name), JSON.stringify(parsed));
  return parsed;
}

async function readRepoSkillNamesRaw(gitURL: string): Promise<string[]> {
  const raw = await get(toRepoSkillNamesKey(gitURL));
  if (!raw) return [];
  try {
    return normalizeNames(repoSkillNamesSchema.parse(raw));
  } catch (error) {
    logger.warn('readRepoSkillNamesRaw:invalid', {
      gitURL,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function writeRepoSkillNamesRaw(
  gitURL: string,
  names: string[],
): Promise<string[]> {
  const normalized = normalizeNames(names);
  await set(toRepoSkillNamesKey(gitURL), JSON.stringify(normalized));
  return normalized;
}

// ─── Index rebuild from details ───

function buildIndexFromDetails(
  existing: SkillIndex,
  details: SkillDetail[],
  removedNames: string[] = [],
): SkillIndex {
  const byName = new Map<string, SkillMeta>(
    existing.skills.map((item) => [item.name, item]),
  );

  for (const removedName of removedNames) {
    byName.delete(removedName);
  }

  for (const detail of details) {
    byName.set(detail.name, toSkillMeta(detail));
  }

  return {
    skills: Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    updateTime: Date.now(),
    activeImportJobs: existing.activeImportJobs || [],
  };
}

// ─── Public reads ───

export async function getSkillIndex(): Promise<SkillIndex> {
  return await readSkillIndexRaw();
}

export async function listSkillMetas(): Promise<SkillMeta[]> {
  const index = await readSkillIndexRaw();
  return index.skills;
}

export async function listSkillDetails(): Promise<SkillDetail[]> {
  const index = await readSkillIndexRaw();
  const details: SkillDetail[] = [];
  for (const meta of index.skills) {
    const detail = await readSkillDetailRaw(meta.name);
    if (detail) details.push(detail);
  }
  return normalizeSkillDetails(details);
}

export async function getSkillDetail(
  name: string,
): Promise<SkillDetail | null> {
  const normalizedName = name.trim();
  if (!normalizedName) return null;
  return await readSkillDetailRaw(normalizedName);
}

/**
 * Check if a skill with the given name already exists
 */
export async function checkSkillNameExists(name: string): Promise<boolean> {
  const trimmedName = name.trim();
  if (!trimmedName) return false;
  const index = await readSkillIndexRaw();
  return index.skills.some((skill) => skill.name === trimmedName);
}

/**
 * Find skill names that conflict with existing skills
 * @param names - Names to check for conflicts
 * @param excludeGitURL - Exclude skills from this gitURL (for re-importing same repo)
 * @returns List of conflicting names
 */
export async function findConflictingSkillNames(
  names: string[],
  excludeGitURL?: string,
): Promise<string[]> {
  const index = await readSkillIndexRaw();
  const existingByName = new Map(
    index.skills.map((skill) => [skill.name, skill.gitURL]),
  );

  const conflicts: string[] = [];
  for (const name of names) {
    const existingGitURL = existingByName.get(name);
    if (existingGitURL !== undefined) {
      // Allow overwrite when re-importing from the same repo
      if (excludeGitURL && existingGitURL === excludeGitURL) {
        continue;
      }
      conflicts.push(name);
    }
  }

  return conflicts;
}

// ─── Public writes ───

export async function upsertSkillDetail(
  detail: SkillDetail,
): Promise<SkillDetail> {
  const parsed = skillDetailSchema.parse(detail);
  const existingIndex = await readSkillIndexRaw();
  await writeSkillDetailRaw(parsed);
  const nextIndex = buildIndexFromDetails(existingIndex, [parsed]);
  await writeSkillIndexRaw(nextIndex);
  return parsed;
}

export async function removeSkillDetail(name: string): Promise<boolean> {
  const normalizedName = name.trim();
  if (!normalizedName) return false;

  const existing = await readSkillDetailRaw(normalizedName);
  if (!existing) return false;

  await del(toSkillDetailKey(normalizedName));
  const existingIndex = await readSkillIndexRaw();
  const nextIndex = buildIndexFromDetails(existingIndex, [], [normalizedName]);
  await writeSkillIndexRaw(nextIndex);

  await removeSkillFilesFromBlob(normalizedName);

  return true;
}

// ─── Repo skill mapping ───

export async function getRepoSkillNames(gitURL: string): Promise<string[]> {
  const normalizedGitURL = gitURL.trim();
  if (!normalizedGitURL) return [];
  return await readRepoSkillNamesRaw(normalizedGitURL);
}

export async function syncRepoSkillDetails(
  gitURL: string,
  importedInput: unknown,
): Promise<{ imported: SkillDetail[]; removed: string[] }> {
  const normalizedGitURL = gitURL.trim();
  if (!normalizedGitURL) {
    throw new Error('gitURL is required');
  }

  const imported = normalizeSkillDetails(
    skillDetailListSchema.parse(importedInput),
  );

  const existingIndex = await readSkillIndexRaw();
  const previousNames = await readRepoSkillNamesRaw(normalizedGitURL);

  for (const detail of imported) {
    await writeSkillDetailRaw(detail);
  }

  const importedNames = imported.map((item) => item.name);
  const importedNameSet = new Set(importedNames);
  const removed = previousNames.filter((name) => !importedNameSet.has(name));

  if (removed.length > 0) {
    for (const name of removed) {
      await del(toSkillDetailKey(name));
      await removeSkillFilesFromBlob(name);
    }
  }

  const nextIndex = buildIndexFromDetails(existingIndex, imported, removed);
  await writeSkillIndexRaw(nextIndex);
  await writeRepoSkillNamesRaw(normalizedGitURL, importedNames);

  return { imported, removed };
}

// ─── Manual skill creation ───

export async function persistManualSkill(input: {
  name: string;
  description: string;
  files: SkillFile[];
}): Promise<SkillDetail> {
  const { name, description, files } = input;
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Skill name is required');

  const filePaths = await persistManualSkillToBlob(trimmedName, files);

  // Try to parse ClawHub metadata first, then fall back to SKILL.md frontmatter.
  const clawhubFile = files.find((f) => f.path === 'clawhub.json');
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  let parsedClawHub: ReturnType<typeof clawhubManifestSchema.safeParse> | null =
    null;
  if (clawhubFile) {
    try {
      parsedClawHub = clawhubManifestSchema.safeParse(
        JSON.parse(clawhubFile.content),
      );
    } catch {}
  }
  const { frontmatter, description: fmDescription } = parsedClawHub?.success
    ? {
        frontmatter: {
          author: parsedClawHub.data.author,
          clawhub: parsedClawHub.data,
          description: parsedClawHub.data.description,
          entrypoint: parsedClawHub.data.entrypoint,
          tags: parsedClawHub.data.tags,
          version: parsedClawHub.data.version,
        },
        description: parsedClawHub.data.description,
      }
    : skillMd
      ? await parseSkillManifest(skillMd.content)
      : { frontmatter: {}, description: '' };

  const now = Date.now();
  const detail: SkillDetail = {
    name: trimmedName,
    description: description || fmDescription,
    sourceType: 'manual',
    gitURL: '',
    repoId: '',
    updatedAt: now,
    frontmatter,
    files: filePaths.map((p) => ({ path: p })),
  };

  return await upsertSkillDetail(detail);
}

// ─── Single file update ───

export async function updateSkillFile(
  skillName: string,
  filePath: string,
  content: string,
): Promise<SkillDetail> {
  const trimmedName = skillName.trim();
  const trimmedPath = filePath.trim();
  if (!trimmedName || !trimmedPath) {
    throw new Error('Skill name and file path are required');
  }

  await updateSkillFileInBlob(trimmedName, trimmedPath, content);

  const existing = await readSkillDetailRaw(trimmedName);
  if (!existing) {
    throw new Error(`Skill "${trimmedName}" not found`);
  }

  // Add file to list if not present
  if (!existing.files.some((f) => f.path === trimmedPath)) {
    existing.files.push({ path: trimmedPath });
    existing.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  // Re-parse metadata if SKILL.md or clawhub.json was updated
  if (trimmedPath === 'clawhub.json') {
    const parsedClawHub = clawhubManifestSchema.parse(JSON.parse(content));
    existing.frontmatter = {
      author: parsedClawHub.author,
      clawhub: parsedClawHub,
      description: parsedClawHub.description,
      entrypoint: parsedClawHub.entrypoint,
      tags: parsedClawHub.tags,
      version: parsedClawHub.version,
    };
    existing.description = parsedClawHub.description;
  } else if (trimmedPath === 'SKILL.md') {
    const { frontmatter, description } = await parseSkillManifest(content);
    existing.frontmatter = frontmatter;
    if (description) {
      existing.description = description;
    }
  }

  existing.updatedAt = Date.now();
  await writeSkillDetailRaw(existing);

  // Update index meta
  const existingIndex = await readSkillIndexRaw();
  const nextIndex = buildIndexFromDetails(existingIndex, [existing]);
  await writeSkillIndexRaw(nextIndex);

  return existing;
}

// ─── Active import job management ───

export async function addActiveImportJob(
  job: ActiveImportJobSummary,
): Promise<void> {
  const index = await readSkillIndexRaw();
  // Prevent duplicate entries
  const exists = index.activeImportJobs?.some((j) => j.jobId === job.jobId);
  if (exists) return;

  const nextIndex: SkillIndex = {
    ...index,
    activeImportJobs: [...(index.activeImportJobs || []), job],
  };
  await writeSkillIndexRaw(nextIndex);
}

export async function updateActiveImportJobStatus(
  jobId: string,
  status: 'pending' | 'cloning' | 'syncing',
): Promise<void> {
  const index = await readSkillIndexRaw();
  const jobs = index.activeImportJobs || [];
  const updated = jobs.map((j) => (j.jobId === jobId ? { ...j, status } : j));

  const nextIndex: SkillIndex = {
    ...index,
    activeImportJobs: updated,
  };
  await writeSkillIndexRaw(nextIndex);
}

export async function removeActiveImportJob(jobId: string): Promise<void> {
  const index = await readSkillIndexRaw();
  const jobs = index.activeImportJobs || [];
  const filtered = jobs.filter((j) => j.jobId !== jobId);

  // Only write when there are changes
  if (filtered.length === jobs.length) return;

  const nextIndex: SkillIndex = {
    ...index,
    activeImportJobs: filtered,
  };
  await writeSkillIndexRaw(nextIndex);
}

export async function getActiveImportJobs(): Promise<ActiveImportJobSummary[]> {
  const index = await readSkillIndexRaw();
  return index.activeImportJobs || [];
}
