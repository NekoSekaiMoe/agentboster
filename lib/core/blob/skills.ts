import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import matter from 'gray-matter';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { ofetch } from 'ofetch';
import { del, getBlob, list, put } from './';

import { createLogger } from '@/lib/utils/logger';
import type {
  SkillDetail,
  SkillFile,
  SkillFileEntry,
  SkillFrontmatter,
} from '@/types/skills';

/** Max total size (in bytes) for manually added skill files */
export const MANUAL_SKILL_MAX_TOTAL_BYTES = 2 * 1024 * 1024; // 2 MB
export const GIT_IMPORT_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB
export const GIT_IMPORT_MAX_FILE_COUNT = 500;

const logger = createLogger('blob.skills');

const SKILLS_REPO_DIR = 'skills';
const SKILLS_BLOB_ROOT = 'skills';
const SKILL_MANIFEST = 'SKILL.md';

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

function deriveRepoId(gitURL: string): string {
  const parsed = new URL(gitURL);
  const parts = parsed.pathname.split('/').filter(Boolean);
  return `${parsed.hostname}/${parts[0]}/${(parts[1] || '').replace(/\.git$/i, '')}`;
}

// ─── Path helpers ───

function normalizeFilePath(value: string): string {
  return value.split(path.sep).join('/');
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

export function parseSkillManifest(markdown: string): ParsedSkillManifest {
  try {
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
  const normalizedGitURL = normalizeGitURL(gitURL);
  const parsed = new URL(normalizedGitURL);
  const repoName = (
    parsed.pathname.split('/').filter(Boolean)[1] || 'repo'
  ).replace(/\.git$/i, '');

  const tempDir = await mkdtemp(path.join(tmpdir(), 'skill-repo-'));
  const repoDir = path.join(tempDir, repoName);

  try {
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
  const skillsDir = path.join(repoDir, SKILLS_REPO_DIR);
  const skillsDirStat = await stat(skillsDir).catch(() => null);
  if (!skillsDirStat || !skillsDirStat.isDirectory()) {
    throw new Error(
      `Repository does not contain /${SKILLS_REPO_DIR} directory`,
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

    if (!manifestStat || !manifestStat.isFile()) continue;

    const manifestContent = await readFile(manifestPath, 'utf8');
    const { frontmatter, description } = parseSkillManifest(manifestContent);
    const filePaths = await listSkillFilesRecursive(skillDir);

    totalFileCount += filePaths.length;
    if (totalFileCount > GIT_IMPORT_MAX_FILE_COUNT) {
      throw new Error(
        `Repository exceeds the ${GIT_IMPORT_MAX_FILE_COUNT} file limit for skill imports`,
      );
    }

    for (const relativePath of filePaths) {
      const fileStat = await stat(path.join(skillDir, relativePath));
      totalBytes += fileStat.size;
      if (totalBytes > GIT_IMPORT_MAX_TOTAL_BYTES) {
        throw new Error(
          `Repository exceeds the ${Math.round(GIT_IMPORT_MAX_TOTAL_BYTES / 1024 / 1024)} MB size limit for skill imports`,
        );
      }
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

// ─── Blob sync ───

export async function syncSkillFilesToBlob(
  skillName: string,
  localDir: string,
  filePaths: string[],
): Promise<void> {
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
  for (const relativePath of filePaths) {
    const absolutePath = path.join(localDir, relativePath);
    const content = await readFile(absolutePath);
    await put(toSkillBlobPath(skillName, relativePath), new Blob([content]), {
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    totalBytes += content.byteLength;
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
      );
    }
    return scannedSkills.map((item) => item.detail);
  } finally {
    await rm(cloned.tempDir, { recursive: true, force: true });
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
