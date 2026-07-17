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

/**
 * Runtimes that a skill can declare in its SKILL.md frontmatter via
 * `runtime: <value>`. When declared, the skill's `entrypoint` becomes
 * executable on an agentd sandbox via the `runSkill` workflow tool
 * (lib/workflow/agent/tools/skills/local.ts). When absent, all non-md
 * files in the skill are treated as read-only reference material and
 * `runSkill` will refuse to dispatch.
 */
export const skillRuntimeSchema = z.enum(['python', 'bash']);
export type SkillRuntime = z.infer<typeof skillRuntimeSchema>;

export const SKILL_RUNTIMES: readonly SkillRuntime[] =
  skillRuntimeSchema.options;

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

/**
 * Resolve the declared runtime of a skill from its SKILL.md frontmatter.
 *
 * Returns the runtime literal (`'python' | 'bash'`) only when the author
 * has explicitly opted in via `runtime: <value>` in the frontmatter.
 * Returns `null` otherwise — in which case `runSkill` must refuse to
 * dispatch and callers should treat all non-md files as read-only
 * reference material (see lib/workflow/agent/tools/skills/local.ts).
 *
 * Unknown string values are coerced to `null` rather than thrown, so a
 * typo in a third-party SKILL.md degrades to "read-only" instead of
 * breaking the skill loader.
 */
export function getSkillRuntime(
  detail: Pick<SkillDetail, 'frontmatter'>,
): SkillRuntime | null {
  const raw = detail.frontmatter.runtime;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  const parsed = skillRuntimeSchema.safeParse(trimmed);
  return parsed.success ? parsed.data : null;
}

/**
 * Build the shell command an agentd sandbox should run to launch the
 * skill's entrypoint for the given runtime. The entrypoint path is
 * always relative to the sandbox workspace skill directory
 * (`workspace/skills/<name>/<entrypoint>`), which is how the `write`
 * + `exec` agentd tools lay it out.
 *
 * Returns `null` if the runtime is not executable (i.e. the skill did
 * not declare a supported runtime). Callers must treat `null` as
 * "read-only, do not execute".
 */
export function buildSkillExecCommand(
  runtime: SkillRuntime,
  entrypointPath: string,
): string {
  const quoted = `'${entrypointPath.replace(/'/g, `'\\''`)}'`;
  switch (runtime) {
    case 'python':
      return `python3 ${quoted}`;
    case 'bash':
      return `bash ${quoted}`;
  }
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
