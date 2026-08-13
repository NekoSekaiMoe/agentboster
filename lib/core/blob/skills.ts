import { ofetch } from 'ofetch';
import { z } from 'zod';
import { del, getBlob, list, put } from './';

import { createLogger } from '@/lib/utils/logger';
import { enforceScan, type SkillScanHint } from '@/lib/skills/security-scan';
import type {
  ClawHubManifest,
  SkillDetail,
  SkillFile,
  SkillFileEntry,
  SkillFrontmatter,
} from '@/types/skills';
import { clawhubManifestSchema } from '@/types/skills';

// Workflow-bundle safety: this file is transitively reachable from the
// workflow body (lib/workflow/agent/tools/skills/local.ts -> here). Per
// AGENTS.md, no top-level node:* imports — all Node primitives are loaded
// lazily via these cached helpers so the workflow DevKit static bundler
// does not pull them into the vm sandbox (where `require` is undefined).
let _nodeFs: typeof import('node:fs') | undefined;
let _nodeFsPromises: typeof import('node:fs/promises') | undefined;
let _nodePath: typeof import('node:path') | undefined;
let _nodeOs: typeof import('node:os') | undefined;
let _isoGitHttpNode: typeof import('isomorphic-git/http/node') | undefined;

async function nodeFs() {
  if (!_nodeFs) _nodeFs = await import('node:fs');
  return _nodeFs;
}
async function nodeFsPromises() {
  if (!_nodeFsPromises) _nodeFsPromises = await import('node:fs/promises');
  return _nodeFsPromises;
}
async function nodePath() {
  if (!_nodePath) _nodePath = await import('node:path');
  return _nodePath;
}
async function nodeOs() {
  if (!_nodeOs) _nodeOs = await import('node:os');
  return _nodeOs;
}
async function isoGitHttpNode() {
  if (!_isoGitHttpNode)
    _isoGitHttpNode = await import('isomorphic-git/http/node');
  return _isoGitHttpNode;
}

/** Max total size (in bytes) for manually added skill files */
export const MANUAL_SKILL_MAX_TOTAL_BYTES = 2 * 1024 * 1024; // 2 MB
export const GIT_IMPORT_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB
export const GIT_IMPORT_MAX_FILE_COUNT = 500;

const logger = createLogger('blob.skills');

const SKILLS_REPO_DIR = 'skills';
const SKILLS_BLOB_ROOT = 'skills';
const SKILL_MANIFEST = 'SKILL.md';
const CLAWHUB_MANIFEST = 'clawhub.json';
const CLAWHUB_API_BASE_URL = 'https://clawhub.ai';

interface ClonedRepo {
  tempDir: string;
  repoDir: string;
}

interface ScannedSkill {
  detail: SkillDetail;
  localDir: string;
  filePaths: string[];
}

export type SkillArchiveFile = {
  path: string;
  content: string;
};

const clawhubSkillApiSchema = z.object({
  latestVersion: z
    .object({
      version: z.string().min(1),
    })
    .passthrough()
    .optional(),
  skill: z
    .object({
      displayName: z.string().optional(),
      slug: z.string().min(1),
      summary: z.string().optional(),
      tags: z
        .object({
          latest: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});

const clawhubVersionApiSchema = z.object({
  skill: z
    .object({
      displayName: z.string().optional(),
      slug: z.string().min(1),
    })
    .passthrough(),
  version: z
    .object({
      files: z.array(
        z
          .object({
            contentType: z.string().nullable().optional(),
            path: z.string().min(1),
            sha256: z.string().optional(),
            size: z.number().int().nonnegative(),
          })
          .passthrough(),
      ),
      version: z.string().min(1),
    })
    .passthrough(),
});

// ─── URL helpers ───

export function normalizeGitURL(input: string): string {
  const parsed = new URL(input);
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS git URLs are supported');
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('Invalid git repository URL');
  }

  const owner = parts[0] || '';
  const repo = (parts[1] || '').replace(/\.git$/i, '');
  if (!owner || !repo) {
    throw new Error('Invalid git repository URL');
  }

  return `https://${parsed.hostname}/${owner}/${repo}`;
}

export function normalizeClawHubSlug(input: string): string {
  const slug = input.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error('Invalid ClawHub skill slug');
  }
  return slug;
}

function deriveRepoId(gitURL: string): string {
  const parsed = new URL(gitURL);
  const parts = parsed.pathname.split('/').filter(Boolean);
  return `${parsed.hostname}/${parts[0]}/${(parts[1] || '').replace(/\.git$/i, '')}`;
}

function deriveRepoName(gitURL: string): string {
  const parsed = new URL(gitURL);
  const parts = parsed.pathname.split('/').filter(Boolean);
  return (parts[1] || 'skill').replace(/\.git$/i, '');
}

// ─── Path helpers ───

function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeSkillPath(pathname: string): string {
  const trimmed = pathname.trim().replace(/^\/+|\/+$/g, '');
  const normalized = trimmed.split('/').filter(Boolean).join('/');

  if (!normalized) throw new Error('Skill path is required');

  for (const segment of normalized.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error('Invalid skill path');
    }
  }

  return normalized;
}

function toSkillBlobPrefix(skillName: string): string {
  return `${SKILLS_BLOB_ROOT}/${skillName}/`;
}

function toSkillBlobPath(skillName: string, relativePath: string): string {
  return `${SKILLS_BLOB_ROOT}/${skillName}/${relativePath}`;
}

// ─── Frontmatter parsing ───

function extractFirstParagraph(markdown: string): string {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim());
  const paragraph: string[] = [];

  for (const line of lines) {
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (paragraph.length === 0 && line.startsWith('#')) continue;
    paragraph.push(line.replace(/\s+/g, ' '));
  }

  return (
    paragraph
      .join(' ')
      .trim()
      // Limit to first 300 characters to prevent excessively long descriptions
      .slice(0, 300)
  );
}

interface ParsedSkillManifest {
  frontmatter: SkillFrontmatter;
  description: string;
}

export async function parseSkillManifest(
  markdown: string,
): Promise<ParsedSkillManifest> {
  try {
    // gray-matter is loaded lazily so that this file stays free of
    // top-level third-party imports that depend on node:* — the
    // workflow DevKit bundler statically walks any module reached from
    // a workflow body, and skills.ts is reached via the runSkill tool
    // (lib/workflow/agent/tools/skills/local.ts). Top-level `import
    // matter from 'gray-matter'` would trip the workflow-node-module-
    // error build plugin. Same pattern as nodeFs/nodePath/nodeOs below.
    const { default: matter } = await import('gray-matter');
    const { data, content } = matter(markdown);
    const fm: SkillFrontmatter =
      data && typeof data === 'object' ? (data as SkillFrontmatter) : {};

    const description =
      (typeof fm.description === 'string' && fm.description) ||
      extractFirstParagraph(content);

    return { frontmatter: fm, description };
  } catch {
    return { frontmatter: {}, description: extractFirstParagraph(markdown) };
  }
}

// ─── File scanning ───

async function listSkillFilesRecursive(
  skillDir: string,
  currentDir = skillDir,
): Promise<string[]> {
  const { readdir } = await nodeFsPromises();
  const path = await nodePath();
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git') continue;

    const absolutePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listSkillFilesRecursive(skillDir, absolutePath)));
      continue;
    }

    if (!entry.isFile()) continue;

    const relativePath = normalizeFilePath(
      path.relative(skillDir, absolutePath),
    );
    if (relativePath) files.push(relativePath);
  }

  return files;
}

function toFileEntries(paths: string[]): SkillFileEntry[] {
  return paths.map((p) => ({ path: p }));
}

async function assertRepoSkillLimits(rootDir: string, filePaths: string[]) {
  const { stat } = await nodeFsPromises();
  const path = await nodePath();
  if (filePaths.length > GIT_IMPORT_MAX_FILE_COUNT) {
    throw new Error(
      `Repository exceeds the ${GIT_IMPORT_MAX_FILE_COUNT} file limit for skill imports`,
    );
  }

  let totalBytes = 0;
  for (const relativePath of filePaths) {
    const fileStat = await stat(path.join(rootDir, relativePath));
    totalBytes += fileStat.size;
    if (totalBytes > GIT_IMPORT_MAX_TOTAL_BYTES) {
      throw new Error(
        `Repository exceeds the ${Math.round(GIT_IMPORT_MAX_TOTAL_BYTES / 1024 / 1024)} MB size limit for skill imports`,
      );
    }
  }

  return totalBytes;
}

function clawhubManifestToFrontmatter(
  manifest: ClawHubManifest,
): SkillFrontmatter {
  return {
    author: manifest.author,
    clawhub: manifest,
    description: manifest.description,
    entrypoint: manifest.entrypoint,
    tags: manifest.tags,
    version: manifest.version,
  };
}

/**
 * Build a security-scan hint from parsed frontmatter so the scanner
 * classifies the declared entrypoint by its declared runtime (bash /
 * python) even when the file has no extension or shebang. Mirrors what
 * runSkill will actually execute. Returns undefined when the frontmatter
 * declares neither, so callers can spread it unconditionally.
 */
function scanHintFromFrontmatter(
  frontmatter: SkillFrontmatter,
): SkillScanHint | undefined {
  const runtime =
    typeof frontmatter.runtime === 'string' ? frontmatter.runtime : null;
  const entrypoint =
    typeof frontmatter.entrypoint === 'string' ? frontmatter.entrypoint : null;
  if (!runtime && !entrypoint) return undefined;
  return { runtime, entrypoint };
}

/**
 * Read a repo manifest file (SKILL.md / clawhub.json) only when it is a
 * regular file that truly lives inside the checkout. A cloned repo can
 * ship its manifest as a symlink pointing at an arbitrary host path;
 * stat() would follow it and readFile() would happily parse host-file
 * content into skill metadata (an info-leak channel into KV). lstat
 * rejects the symlink itself and realpath confirms the resolved target
 * stays within repoDir; either failure throws BEFORE any readFile.
 */
async function readRepoManifestFile(
  repoDir: string,
  manifestPath: string,
): Promise<string> {
  const { lstat, readFile, realpath } = await nodeFsPromises();
  const path = await nodePath();
  const lst = await lstat(manifestPath);
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw new Error(
      `Refusing to read non-regular manifest file: ${manifestPath}`,
    );
  }
  const [resolvedManifest, resolvedRepo] = await Promise.all([
    realpath(manifestPath),
    realpath(repoDir),
  ]);
  const relative = path.relative(resolvedRepo, resolvedManifest);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing to read manifest that resolves outside the repository: ${manifestPath}`,
    );
  }
  return readFile(manifestPath, 'utf8');
}

// ─── Blob list / delete ───

async function listBlobPathnamesByPrefix(prefix: string): Promise<string[]> {
  const pathnames: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await list({ prefix, limit: 1000, cursor });
    for (const item of result.blobs) {
      pathnames.push(item.pathname);
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  return pathnames;
}

export async function removeSkillFilesFromBlob(
  skillName: string,
): Promise<void> {
  const prefix = toSkillBlobPrefix(skillName);
  const pathnames = await listBlobPathnamesByPrefix(prefix);
  if (pathnames.length === 0) {
    logger.info('removeSkillFilesFromBlob:empty', { skillName });
    return;
  }
  await del(pathnames);
  logger.info('removeSkillFilesFromBlob:deleted', {
    skillName,
    fileCount: pathnames.length,
    paths: pathnames,
  });
}

// ─── Git clone ───

export async function cloneRepoToTmp(gitURL: string): Promise<ClonedRepo> {
  const { mkdtemp, rm } = await nodeFsPromises();
  const path = await nodePath();
  const { tmpdir } = await nodeOs();
  const fs = await nodeFs();
  const http = await isoGitHttpNode();

  const normalizedGitURL = normalizeGitURL(gitURL);
  const parsed = new URL(normalizedGitURL);
  const repoName = (
    parsed.pathname.split('/').filter(Boolean)[1] || 'repo'
  ).replace(/\.git$/i, '');

  const tempDir = await mkdtemp(path.join(tmpdir(), 'skill-repo-'));
  const repoDir = path.join(tempDir, repoName);

  try {
    // isomorphic-git is loaded lazily for the same reason as gray-matter
    // above: it transitively depends on node:* builtins and would trip
    // the workflow-node-module-error bundler plugin if imported at the
    // top of this file.
    const git = (await import('isomorphic-git')).default;
    await git.clone({
      fs,
      http,
      dir: repoDir,
      url: normalizedGitURL,
      singleBranch: true,
      depth: 1,
    });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    logger.error('cloneRepoToTmp:failed', {
      gitURL: normalizedGitURL,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Failed to clone repository: ${normalizedGitURL}`);
  }

  return { tempDir, repoDir };
}

// ─── Repo scanning ───

export async function scanSkillsFromRepo(
  repoDir: string,
  gitURL: string,
): Promise<ScannedSkill[]> {
  const { stat, readdir } = await nodeFsPromises();
  const path = await nodePath();
  const clawhubSkill = await scanClawHubSkillFromRepo(repoDir, gitURL);
  if (clawhubSkill) {
    return [clawhubSkill];
  }

  const rootSkill = await scanRootSkillFromRepo(repoDir, gitURL);
  if (rootSkill) {
    return [rootSkill];
  }

  const skillsDir = path.join(repoDir, SKILLS_REPO_DIR);
  const skillsDirStat = await stat(skillsDir).catch(() => null);
  if (!skillsDirStat?.isDirectory()) {
    throw new Error(
      `Repository does not contain /${SKILLS_REPO_DIR} directory, root ${SKILL_MANIFEST}, or ${CLAWHUB_MANIFEST}`,
    );
  }

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const now = Date.now();
  const repoId = deriveRepoId(normalizeGitURL(gitURL));
  const scanned: ScannedSkill[] = [];
  let totalFileCount = 0;
  let totalBytes = 0;

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const skillName = entry.name;
    const skillDir = path.join(skillsDir, skillName);
    const manifestPath = path.join(skillDir, SKILL_MANIFEST);
    const manifestStat = await stat(manifestPath).catch(() => null);

    if (!manifestStat?.isFile()) continue;

    // Guarded read: reject symlinked SKILL.md before parsing it (see
    // readRepoManifestFile).
    const manifestContent = await readRepoManifestFile(repoDir, manifestPath);
    const { frontmatter, description } =
      await parseSkillManifest(manifestContent);
    const filePaths = await listSkillFilesRecursive(skillDir);

    totalFileCount += filePaths.length;
    if (totalFileCount > GIT_IMPORT_MAX_FILE_COUNT) {
      throw new Error(
        `Repository exceeds the ${GIT_IMPORT_MAX_FILE_COUNT} file limit for skill imports`,
      );
    }

    totalBytes += await assertRepoSkillLimits(skillDir, filePaths);
    if (totalBytes > GIT_IMPORT_MAX_TOTAL_BYTES) {
      throw new Error(
        `Repository exceeds the ${Math.round(GIT_IMPORT_MAX_TOTAL_BYTES / 1024 / 1024)} MB size limit for skill imports`,
      );
    }

    scanned.push({
      detail: {
        name: skillName,
        description,
        sourceType: 'git',
        gitURL: normalizeGitURL(gitURL),
        repoId,
        updatedAt: now,
        frontmatter,
        files: toFileEntries(filePaths),
        status: 'active',
      },
      localDir: skillDir,
      filePaths,
    });
  }

  if (scanned.length === 0) {
    throw new Error(
      'No valid skills were found in repository /skills directory',
    );
  }

  return scanned;
}

async function scanRootSkillFromRepo(
  repoDir: string,
  gitURL: string,
): Promise<ScannedSkill | null> {
  const { stat } = await nodeFsPromises();
  const path = await nodePath();
  const manifestPath = path.join(repoDir, SKILL_MANIFEST);
  const manifestStat = await stat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile()) {
    return null;
  }

  const manifestContent = await readRepoManifestFile(repoDir, manifestPath);
  const { frontmatter, description } =
    await parseSkillManifest(manifestContent);
  const frontmatterName =
    typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const filePaths = await listSkillFilesRecursive(repoDir);
  await assertRepoSkillLimits(repoDir, filePaths);

  return {
    detail: {
      name: frontmatterName || deriveRepoName(normalizeGitURL(gitURL)),
      description,
      sourceType: 'git',
      gitURL: normalizeGitURL(gitURL),
      repoId: deriveRepoId(normalizeGitURL(gitURL)),
      updatedAt: Date.now(),
      frontmatter,
      files: toFileEntries(filePaths),
      status: 'active',
    },
    localDir: repoDir,
    filePaths,
  };
}

async function scanClawHubSkillFromRepo(
  repoDir: string,
  gitURL: string,
): Promise<ScannedSkill | null> {
  const { stat } = await nodeFsPromises();
  const path = await nodePath();
  const manifestPath = path.join(repoDir, CLAWHUB_MANIFEST);
  const manifestStat = await stat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile()) {
    return null;
  }

  const rawManifest = JSON.parse(
    await readRepoManifestFile(repoDir, manifestPath),
  );
  const manifest = clawhubManifestSchema.parse(rawManifest);
  const entrypoint = normalizeSkillPath(manifest.entrypoint);
  const entrypointPath = path.join(repoDir, entrypoint);
  const entrypointStat = await stat(entrypointPath).catch(() => null);
  if (!entrypointStat?.isFile()) {
    throw new Error(`ClawHub entrypoint "${entrypoint}" was not found`);
  }

  const filePaths = await listSkillFilesRecursive(repoDir);
  await assertRepoSkillLimits(repoDir, filePaths);

  return {
    detail: {
      name: manifest.name,
      description: manifest.description,
      sourceType: 'git',
      gitURL: normalizeGitURL(gitURL),
      repoId: deriveRepoId(normalizeGitURL(gitURL)),
      updatedAt: Date.now(),
      frontmatter: clawhubManifestToFrontmatter(manifest),
      files: toFileEntries(filePaths),
      status: 'active',
    },
    localDir: repoDir,
    filePaths,
  };
}

// ─── Blob sync ───

export async function syncSkillFilesToBlob(
  skillName: string,
  localDir: string,
  filePaths: string[],
  scanHint?: SkillScanHint,
): Promise<void> {
  const { readFile } = await nodeFsPromises();
  const path = await nodePath();
  logger.info('syncSkillFilesToBlob:start', {
    skillName,
    fileCount: filePaths.length,
  });

  const existingPathnames = await listBlobPathnamesByPrefix(
    toSkillBlobPrefix(skillName),
  );
  const nextPathnames = new Set(
    filePaths.map((relativePath) => toSkillBlobPath(skillName, relativePath)),
  );

  let totalBytes = 0;
  const scannedFiles: { path: string; content: Uint8Array }[] = [];
  for (const relativePath of filePaths) {
    const absolutePath = path.join(localDir, relativePath);
    const content = await readFile(absolutePath);
    scannedFiles.push({ path: relativePath, content: new Uint8Array(content) });
    totalBytes += content.byteLength;
  }
  // Phase-1 security scan: block CRITICAL findings (private keys, shell
  // exec, reverse shells, executable binaries, path traversal, exfil
  // chains) BEFORE any file reaches blob. Runs on the in-memory bytes
  // we just read, so no extra I/O. See lib/skills/security-scan.ts.
  // `scanHint` carries the frontmatter-declared runtime/entrypoint so an
  // extensionless declared entrypoint is still classified as bash/python.
  enforceScan(scannedFiles, scanHint);
  for (const { path: relativePath, content } of scannedFiles) {
    await put(
      toSkillBlobPath(skillName, relativePath),
      new Blob([content.slice().buffer]),
      {
        addRandomSuffix: false,
        allowOverwrite: true,
      },
    );
    logger.info('syncSkillFilesToBlob:upload', {
      skillName,
      path: relativePath,
      bytes: content.byteLength,
    });
  }

  const stalePathnames = existingPathnames.filter(
    (pathname) => !nextPathnames.has(pathname),
  );
  if (stalePathnames.length > 0) {
    await del(stalePathnames);
  }

  logger.info('syncSkillFilesToBlob:complete', {
    skillName,
    uploadedFiles: filePaths.length,
    deletedStale: stalePathnames.length,
    totalBytes,
  });
}

// ─── Public API: Git import ───

export async function downloadAndSyncSkillsFromGit(
  gitURL: string,
): Promise<SkillDetail[]> {
  const { rm } = await nodeFsPromises();
  const normalizedGitURL = normalizeGitURL(gitURL);
  const cloned = await cloneRepoToTmp(normalizedGitURL);

  try {
    const scannedSkills = await scanSkillsFromRepo(
      cloned.repoDir,
      normalizedGitURL,
    );
    for (const skill of scannedSkills) {
      await syncSkillFilesToBlob(
        skill.detail.name,
        skill.localDir,
        skill.filePaths,
        scanHintFromFrontmatter(skill.detail.frontmatter),
      );
    }
    return scannedSkills.map((item) => item.detail);
  } finally {
    await rm(cloned.tempDir, { recursive: true, force: true });
  }
}

async function fetchClawHubJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'AgentBoster-ClawHubImporter/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(
      `ClawHub API request failed with HTTP ${response.status}: ${url.pathname}`,
    );
  }

  return response.json();
}

// ─── Skill search (for the distillation loop) ───

/**
 * A single ClawHub skill-search hit. `score` is the hub's own relevance
 * score (roughly TF-IDF-ish, unbounded but empirically <1 is weak).
 */
export interface ClawHubSearchHit {
  slug: string;
  displayName: string;
  summary: string;
  score: number;
  /** Epoch ms of the skill's latest version, when the hub reports one. */
  updatedAt?: number;
}

const clawhubSearchHitSchema = z.object({
  slug: z.string().min(1),
  displayName: z.string().optional().default(''),
  summary: z.string().optional().default(''),
  score: z.number().default(0),
  updatedAt: z.number().optional(),
});

const clawhubSearchResponseSchema = z.object({
  results: z.array(clawhubSearchHitSchema).default([]),
});

/**
 * Search the ClawHub skill hub for skills matching a natural-language
 * query. Used by the skill-distillation loop to prefer reusing an
 * existing community skill over self-authoring one from scratch.
 *
 * Best-effort: any network / parse / shape failure returns an empty
 * array. The caller treats "no hits" as "proceed to self-author".
 *
 * The endpoint returns relevance-scored hits; we do no client-side
 * ranking beyond preserving the hub's ordering. The caller decides
 * whether the top hit clears its own acceptance threshold (see
 * `experiments.skillDistillation.clawhubMinScore`).
 */
export async function searchClawHubSkills(input: {
  query: string;
  limit?: number;
}): Promise<ClawHubSearchHit[]> {
  const query = input.query.trim();
  if (!query) return [];
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);

  try {
    const url = new URL('/api/search', CLAWHUB_API_BASE_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));

    const raw = await fetchClawHubJson(url);
    const parsed = clawhubSearchResponseSchema.parse(raw);
    return parsed.results.map((r) => ({
      slug: r.slug,
      displayName: r.displayName ?? '',
      summary: r.summary ?? '',
      score: r.score,
      updatedAt: r.updatedAt,
    }));
  } catch {
    // Swallow — search is advisory; failures mean "no suggestion".
    return [];
  }
}

async function fetchClawHubFile(input: {
  filePath: string;
  slug: string;
  version: string;
}): Promise<string> {
  const url = new URL(
    `/api/v1/skills/${encodeURIComponent(input.slug)}/file`,
    CLAWHUB_API_BASE_URL,
  );
  url.searchParams.set('path', input.filePath);
  url.searchParams.set('version', input.version);

  const response = await fetch(url, {
    headers: {
      Accept: 'text/plain,text/markdown,text/*,*/*;q=0.5',
      'User-Agent': 'AgentBoster-ClawHubImporter/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ClawHub file "${input.filePath}" with HTTP ${response.status}`,
    );
  }

  return response.text();
}

export async function downloadAndSyncSkillFromClawHub(input: {
  slug: string;
  version?: string;
}): Promise<SkillDetail> {
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await nodeFsPromises();
  const path = await nodePath();
  const { tmpdir } = await nodeOs();
  const slug = normalizeClawHubSlug(input.slug);
  const skillUrl = new URL(
    `/api/v1/skills/${encodeURIComponent(slug)}`,
    CLAWHUB_API_BASE_URL,
  );
  const skillPayload = clawhubSkillApiSchema.parse(
    await fetchClawHubJson(skillUrl),
  );
  const version =
    input.version?.trim() ||
    skillPayload.latestVersion?.version ||
    skillPayload.skill.tags?.latest;

  if (!version) {
    throw new Error(`ClawHub skill "${slug}" does not expose a version`);
  }

  const versionUrl = new URL(
    `/api/v1/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`,
    CLAWHUB_API_BASE_URL,
  );
  const versionPayload = clawhubVersionApiSchema.parse(
    await fetchClawHubJson(versionUrl),
  );
  const fileMetas = versionPayload.version.files;

  if (fileMetas.length === 0) {
    throw new Error(`ClawHub skill "${slug}" has no files`);
  }
  if (fileMetas.length > GIT_IMPORT_MAX_FILE_COUNT) {
    throw new Error(
      `ClawHub skill exceeds the ${GIT_IMPORT_MAX_FILE_COUNT} file limit`,
    );
  }

  const totalBytes = fileMetas.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > GIT_IMPORT_MAX_TOTAL_BYTES) {
    throw new Error(
      `ClawHub skill exceeds the ${Math.round(GIT_IMPORT_MAX_TOTAL_BYTES / 1024 / 1024)} MB size limit`,
    );
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'clawhub-skill-'));
  try {
    const filePaths: string[] = [];
    for (const file of fileMetas.sort((a, b) => a.path.localeCompare(b.path))) {
      const normalizedPath = normalizeSkillPath(file.path);
      const content = await fetchClawHubFile({
        filePath: normalizedPath,
        slug,
        version: versionPayload.version.version,
      });
      const absolutePath = path.join(tempDir, normalizedPath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, 'utf8');
      filePaths.push(normalizedPath);
    }

    const skillMdPath = path.join(tempDir, SKILL_MANIFEST);
    const skillMd = await readFile(skillMdPath, 'utf8').catch(() => '');
    const parsedSkillMd = skillMd
      ? await parseSkillManifest(skillMd)
      : { description: '', frontmatter: {} };
    const description =
      parsedSkillMd.description || skillPayload.skill.summary || '';

    const detail: SkillDetail = {
      name: slug,
      description,
      sourceType: 'clawhub',
      gitURL: `${CLAWHUB_API_BASE_URL}/skills/${slug}`,
      repoId: `clawhub/${slug}`,
      updatedAt: Date.now(),
      frontmatter: {
        ...parsedSkillMd.frontmatter,
        clawhub: {
          files: fileMetas,
          registry: CLAWHUB_API_BASE_URL,
          skill: skillPayload.skill,
          slug,
          sourceType: 'registry',
          version: versionPayload.version.version,
        },
        version:
          parsedSkillMd.frontmatter.version ?? versionPayload.version.version,
      },
      files: toFileEntries(filePaths),
      status: 'active',
    };

    await syncSkillFilesToBlob(
      detail.name,
      tempDir,
      filePaths,
      scanHintFromFrontmatter(detail.frontmatter),
    );
    return detail;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ─── Public API: Single file read ───

export async function getSkillFileContentFromBlob(
  skillName: string,
  filePath: string,
): Promise<string | null> {
  const normalizedPath = normalizeSkillPath(`${skillName}/${filePath}`);
  const pathname = `${SKILLS_BLOB_ROOT}/${normalizedPath}`;

  const result = await list({ prefix: pathname, limit: 1 });
  const blob = result.blobs[0];
  if (!blob) return null;

  const response = await getBlob(blob.pathname);
  if (response?.statusCode !== 200) {
    const publicResponse = await ofetch.raw(blob.url, { responseType: 'text' });
    return typeof publicResponse._data === 'string'
      ? publicResponse._data
      : null;
  }

  return new Response(response.stream).text();
}

export async function listSkillFilesWithContentFromBlob(
  skillName: string,
): Promise<SkillArchiveFile[]> {
  const prefix = toSkillBlobPrefix(skillName);
  const pathnames = (await listBlobPathnamesByPrefix(prefix)).sort((a, b) =>
    a.localeCompare(b),
  );

  const files: SkillArchiveFile[] = [];

  for (const pathname of pathnames) {
    const relativePath = pathname.slice(prefix.length);
    if (!relativePath) {
      continue;
    }

    const content = await getSkillFileContentFromBlob(skillName, relativePath);
    if (content === null) {
      continue;
    }

    files.push({
      path: relativePath,
      content,
    });
  }

  return files;
}

function writeTarString(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
) {
  target.write(value.slice(0, length), offset, length, 'utf8');
}

function writeTarOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  target.write(encoded, offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

function createTarHeader(pathname: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const nowSeconds = Math.floor(Date.now() / 1000);

  writeTarString(header, 0, 100, pathname);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, nowSeconds);
  header.fill(32, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }

  const checksumText = checksum.toString(8).padStart(6, '0');
  header.write(checksumText, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 32;

  return header;
}

export function createSkillArchiveTar(
  skillName: string,
  files: SkillArchiveFile[],
): Buffer {
  const chunks: Buffer[] = [];

  for (const file of files) {
    const pathname = normalizeSkillPath(`${skillName}/${file.path}`);
    const content = Buffer.from(file.content, 'utf8');
    const padding = (512 - (content.length % 512)) % 512;

    chunks.push(createTarHeader(pathname, content.length));
    chunks.push(content);
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding, 0));
    }
  }

  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

// ─── Public API: Single file update ───

export async function updateSkillFileInBlob(
  skillName: string,
  filePath: string,
  content: string,
): Promise<void> {
  const normalizedFilePath = normalizeSkillPath(`${skillName}/${filePath}`);
  const pathname = `${SKILLS_BLOB_ROOT}/${normalizedFilePath}`;
  await put(pathname, content, {
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

// ─── Public API: Manual skill persist ───

export async function persistManualSkillToBlob(
  skillName: string,
  files: SkillFile[],
): Promise<string[]> {
  logger.info('persistManualSkillToBlob:start', {
    skillName,
    fileCount: files.length,
  });

  const encoder = new TextEncoder();
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += encoder.encode(file.content).byteLength;
    if (totalBytes > MANUAL_SKILL_MAX_TOTAL_BYTES) {
      throw new Error(
        `Total file size exceeds the ${Math.round(MANUAL_SKILL_MAX_TOTAL_BYTES / 1024)} KB limit for manually added skills`,
      );
    }
  }

  // Phase-1 security scan on the inline file contents BEFORE any upload
  // — and BEFORE removing the previous version's files. The old order
  // (remove, then scan) meant a rejected scan left the skill with KV
  // metadata but zero blob files. Manual skills come from the admin UI /
  // agent upsertSkill tool; both are untrusted-author paths (the model
  // itself can call upsertSkill), so the gate is mandatory here too.
  // Text content → bytes for the scanner's magic + regex passes.
  enforceScan(
    files.map((f) => ({
      path: f.path,
      content: new TextEncoder().encode(f.content),
    })),
  );

  await removeSkillFilesFromBlob(skillName);

  const filePaths: string[] = [];
  let uploadedBytes = 0;
  for (const file of files) {
    const normalized = normalizeSkillPath(`${skillName}/${file.path}`);
    const fileBytes = encoder.encode(file.content).byteLength;
    await put(`${SKILLS_BLOB_ROOT}/${normalized}`, file.content, {
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    uploadedBytes += fileBytes;
    logger.info('persistManualSkillToBlob:upload', {
      skillName,
      path: file.path,
      bytes: fileBytes,
    });
    filePaths.push(file.path);
  }

  logger.info('persistManualSkillToBlob:complete', {
    skillName,
    uploadedFiles: filePaths.length,
    totalBytes: uploadedBytes,
  });

  return filePaths;
}
