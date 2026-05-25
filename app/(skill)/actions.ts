'use server';

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { readAuthSessionFromCookies } from '@/lib/auth';
import {
  cloneRepoToTmp,
  createSkillArchiveTar,
  getSkillFileContentFromBlob,
  listSkillFilesWithContentFromBlob,
  normalizeGitURL,
  scanSkillsFromRepo,
  syncSkillFilesToBlob,
} from '@/lib/core/blob/skills';
import {
  createImportJob,
  getActiveImportJobForRepo,
  getImportJob,
  updateImportJob,
} from '@/lib/core/kv/import-jobs';
import type { ImportJob } from '@/lib/core/kv/import-jobs';
import { withKvLock } from '@/lib/core/kv/lock';
import {
  checkSkillNameExists,
  findConflictingSkillNames,
  getActiveImportJobs,
  getSkillDetail,
  listSkillMetas,
  persistManualSkill,
  removeSkillDetail,
  syncRepoSkillDetails,
  updateSkillFile,
} from '@/lib/core/kv/skills';
import type {
  ActiveImportJobSummary,
  SkillDetail,
  SkillMeta,
} from '@/types/skills';
import { cookies } from 'next/headers';
import { after } from 'next/server';
import { z } from 'zod';

const IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

const skillFileSchema = z.object({
  path: z.string().min(1, 'File path is required'),
  content: z.string(),
});

const manualInputSchema = z.object({
  name: z.string().min(1, 'Skill name is required'),
  description: z.string().default(''),
  files: z.array(skillFileSchema).min(1, 'At least one file is required'),
});

const fileContentInputSchema = z.object({
  skillName: z.string().min(1, 'Skill name is required'),
  filePath: z.string().min(1, 'File path is required'),
});

const updateFileInputSchema = fileContentInputSchema.extend({
  content: z.string(),
});

const importInputSchema = z.object({
  gitURL: z.string().url('A valid HTTPS git URL is required'),
});

async function requireAuth() {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);

  if (!authSession) {
    throw new Error('Unauthorized');
  }

  return authSession;
}

export async function listSkillsAction(): Promise<SkillMeta[]> {
  await requireAuth();
  return listSkillMetas();
}

export async function createSkillAction(input: unknown): Promise<SkillDetail> {
  await requireAuth();

  const parsed = manualInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  const exists = await checkSkillNameExists(parsed.data.name);
  if (exists) {
    throw new Error(
      `Skill "${parsed.data.name.trim()}" already exists. Please choose a different name or delete the existing skill first.`,
    );
  }

  return persistManualSkill({
    name: parsed.data.name,
    description: parsed.data.description,
    files: parsed.data.files,
  });
}

export async function deleteSkillAction(name: string) {
  await requireAuth();

  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Skill name is required');
  }

  const removed = await removeSkillDetail(trimmed);
  if (!removed) {
    throw new Error(`Skill "${trimmed}" not found`);
  }

  return { ok: true as const, name: trimmed };
}

export async function getSkillDetailAction(name: string): Promise<SkillDetail> {
  await requireAuth();

  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Skill name is required');
  }

  const detail = await getSkillDetail(trimmed);
  if (!detail) {
    throw new Error(`Skill "${trimmed}" not found`);
  }

  return detail;
}

export async function getSkillFileContentAction(input: unknown): Promise<{
  path: string;
  content: string;
}> {
  await requireAuth();

  const parsed = fileContentInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  const skillName = parsed.data.skillName.trim();
  const filePath = parsed.data.filePath.trim();
  const detail = await getSkillDetail(skillName);

  if (!detail) {
    throw new Error(`Skill "${skillName}" not found`);
  }

  const content = await getSkillFileContentFromBlob(skillName, filePath);
  if (content === null) {
    throw new Error(`File "${filePath}" not found in skill "${skillName}"`);
  }

  return {
    path: filePath,
    content,
  };
}

export async function updateSkillFileAction(input: unknown): Promise<{
  skill: SkillDetail;
  path: string;
}> {
  await requireAuth();

  const parsed = updateFileInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  const skillName = parsed.data.skillName.trim();
  const filePath = parsed.data.filePath.trim();
  const skill = await updateSkillFile(skillName, filePath, parsed.data.content);

  return {
    skill,
    path: filePath,
  };
}

export async function listActiveSkillImportJobsAction(): Promise<
  ActiveImportJobSummary[]
> {
  await requireAuth();
  return getActiveImportJobs();
}

export async function getSkillImportJobAction(
  jobId: string,
): Promise<ImportJob> {
  await requireAuth();

  const id = jobId.trim();
  if (!id) {
    throw new Error('Job id is required');
  }

  const job = await getImportJob(id);
  if (!job) {
    throw new Error('Job not found');
  }

  return job;
}

export async function startSkillImportAction(input: unknown): Promise<{
  jobId: string;
  status: 'pending';
  gitURL: string;
}> {
  await requireAuth();

  const parsed = importInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  const gitURL = normalizeGitURL(parsed.data.gitURL);
  const existingJob = await getActiveImportJobForRepo(gitURL);
  if (existingJob) {
    return {
      jobId: existingJob.jobId,
      status: 'pending',
      gitURL: existingJob.gitURL,
    };
  }

  const jobId = randomUUID();
  await createImportJob(jobId, gitURL, gitURL);

  after(async () => {
    try {
      await withKvLock(
        `skills-import:${gitURL}`,
        async () => {
          await updateImportJob(jobId, { status: 'cloning', error: '' });

          const cloned = await Promise.race([
            cloneRepoToTmp(gitURL),
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new Error('Skill import timed out during clone.'));
              }, IMPORT_TIMEOUT_MS);
            }),
          ]);

          try {
            const scannedSkills = await scanSkillsFromRepo(
              cloned.repoDir,
              gitURL,
            );
            const skillNames = scannedSkills.map((item) => item.detail.name);

            const conflicts = await findConflictingSkillNames(
              skillNames,
              gitURL,
            );
            if (conflicts.length > 0) {
              throw new Error(
                `Cannot import: skill(s) "${conflicts.join('", "')}" already exist from a different source. Please delete them first or rename the skills in the repository.`,
              );
            }

            await updateImportJob(jobId, { status: 'syncing' });

            for (const skill of scannedSkills) {
              await syncSkillFilesToBlob(
                skill.detail.name,
                skill.localDir,
                skill.filePaths,
              );
            }

            const synced = await syncRepoSkillDetails(
              gitURL,
              scannedSkills.map((item) => item.detail),
            );

            await updateImportJob(jobId, {
              status: 'done',
              importedNames: synced.imported.map((skill) => skill.name),
              removedNames: synced.removed,
              fileCount: synced.imported.reduce(
                (sum, skill) => sum + skill.files.length,
                0,
              ),
              finishedAt: Date.now(),
            });
          } finally {
            await rm(cloned.tempDir, { recursive: true, force: true });
          }
        },
        {
          ttlMs: IMPORT_TIMEOUT_MS,
          acquireTimeoutMs: 2_000,
        },
      );
    } catch (error) {
      await updateImportJob(jobId, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
    }
  });

  return {
    jobId,
    status: 'pending',
    gitURL,
  };
}

export async function buildSkillArchiveAction(name: string): Promise<{
  fileName: string;
  mimeType: 'application/x-tar';
  contentBase64: string;
}> {
  await requireAuth();

  const skillName = decodeURIComponent(name).trim();
  if (!skillName) {
    throw new Error('Skill name is required');
  }

  const detail = await getSkillDetail(skillName);
  if (!detail) {
    throw new Error(`Skill "${skillName}" not found`);
  }

  const files = await listSkillFilesWithContentFromBlob(skillName);
  const archive = createSkillArchiveTar(skillName, files);

  return {
    fileName: `${skillName}.tar`,
    mimeType: 'application/x-tar',
    contentBase64: archive.toString('base64'),
  };
}
