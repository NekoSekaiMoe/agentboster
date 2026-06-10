import { z } from 'zod';

// --- Source type ---

export const skillSourceTypeSchema = z.enum(['git', 'manual', 'clawhub']);
export type SkillSourceType = z.infer<typeof skillSourceTypeSchema>;

// --- Structured file entry ---

export const skillFileEntrySchema = z.object({
  path: z.string().min(1, 'File path is required'),
});

export type SkillFileEntry = z.infer<typeof skillFileEntrySchema>;

// --- Frontmatter (loosely typed, parsed from SKILL.md YAML) ---

export const skillFrontmatterSchema = z
  .record(z.string(), z.unknown())
  .default({});
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

// --- Skill detail (directory-level model) ---

export const skillDetailSchema = z.object({
  name: z.string().min(1, 'Skill name is required'),
  description: z.string().default(''),
  sourceType: skillSourceTypeSchema,
  gitURL: z.string().default(''),
  repoId: z.string().default(''),
  updatedAt: z.number().int().nonnegative().default(0),
  frontmatter: skillFrontmatterSchema,
  files: z.array(skillFileEntrySchema).default([]),
});

export type SkillDetail = z.infer<typeof skillDetailSchema>;
export const skillDetailListSchema = z.array(skillDetailSchema);
export type SkillDetailList = z.infer<typeof skillDetailListSchema>;

export function isClawHubSkillDetail(
  detail: Pick<SkillDetail, 'files' | 'frontmatter'>,
): boolean {
  return (
    detail.files.some((file) => file.path === 'clawhub.json') ||
    Boolean(detail.frontmatter.clawhub)
  );
}

export function getSkillFamilyLabel(input: {
  isClawHub?: boolean;
  sourceType: SkillSourceType;
}): string {
  if (input.sourceType === 'clawhub' || input.isClawHub) {
    return 'ClawHub skill';
  }

  return 'Agent skill';
}

export function getSkillSourceLabel(input: {
  isClawHub?: boolean;
  sourceType: SkillSourceType;
}): string {
  if (input.sourceType === 'clawhub') {
    return 'ClawHub registry';
  }

  if (input.isClawHub) {
    return 'ClawHub-compatible Git';
  }

  if (input.sourceType === 'git') {
    return 'Git agent skill';
  }

  return 'Manual agent skill';
}

export function getSkillEntrypointPath(
  detail: Pick<SkillDetail, 'files' | 'frontmatter'>,
): string | null {
  const frontmatterEntrypoint = detail.frontmatter.entrypoint;
  if (
    typeof frontmatterEntrypoint === 'string' &&
    frontmatterEntrypoint.trim()
  ) {
    return frontmatterEntrypoint.trim();
  }

  if (detail.files.some((file) => file.path === 'SKILL.md')) {
    return 'SKILL.md';
  }

  return detail.files[0]?.path ?? null;
}

// --- Skill meta (lightweight list projection) ---

export const skillMetaSchema = z.object({
  name: z.string().min(1, 'Skill name is required'),
  description: z.string().default(''),
  sourceType: skillSourceTypeSchema,
  gitURL: z.string().default(''),
  isClawHub: z.boolean().default(false),
  updatedAt: z.number().int().nonnegative().default(0),
  fileCount: z.number().int().nonnegative().default(0),
});

export type SkillMeta = z.infer<typeof skillMetaSchema>;

// --- Active import job summary (for tracking in-progress imports) ---

export const activeImportJobSummarySchema = z.object({
  jobId: z.string(),
  gitURL: z.string(),
  status: z.enum(['pending', 'cloning', 'syncing']),
  startedAt: z.number().int().nonnegative(),
});

export type ActiveImportJobSummary = z.infer<
  typeof activeImportJobSummarySchema
>;

// --- Skill index (KV top-level list) ---

export const skillIndexSchema = z.object({
  skills: z.array(skillMetaSchema).default([]),
  updateTime: z.number().int().nonnegative().default(0),
  activeImportJobs: z.array(activeImportJobSummarySchema).default([]),
});

export type SkillIndex = z.infer<typeof skillIndexSchema>;

// --- Skill file (path + content pair, used for uploads) ---

export const skillFileSchema = z.object({
  path: z.string().min(1, 'File path is required'),
  content: z.string(),
});

export type SkillFile = z.infer<typeof skillFileSchema>;

// --- KV key helpers ---

export const SKILLS_INDEX_KEY = 'skills' as const;

export function toSkillDetailKey(name: string): string {
  return `skills:${name}`;
}

export function toRepoSkillNamesKey(gitURL: string): string {
  return `skills:repo:${encodeURIComponent(gitURL)}`;
}

// --- Projection helper ---

export function toSkillMeta(detail: SkillDetail): SkillMeta {
  return {
    name: detail.name,
    description: detail.description,
    sourceType: detail.sourceType,
    gitURL: detail.gitURL,
    isClawHub: detail.sourceType === 'clawhub' || isClawHubSkillDetail(detail),
    updatedAt: detail.updatedAt,
    fileCount: detail.files.length,
  };
}

export { clawhubManifestSchema } from './clawhub';
export type { ClawHubManifest } from './clawhub';
