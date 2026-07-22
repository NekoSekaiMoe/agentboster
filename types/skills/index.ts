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
 * Runtimes a skill can declare in its SKILL.md frontmatter via
 * `runtime: <value>`. When declared, `runSkill` will execute the skill's
 * `entrypoint` on the active execution surface (Vercel Sandbox / agentd /
 * CLI host, depending on where the conversation originated). When absent,
 * all non-md files in the skill are treated as read-only reference
 * material and `runSkill` refuses to dispatch — closing the gray path
 * where the model could otherwise try to execute them via an unrelated
 * shell tool without knowing where the file actually lives.
 */
export const skillRuntimeSchema = z.enum(['python', 'bash']);
export type SkillRuntime = z.infer<typeof skillRuntimeSchema>;

export const SKILL_RUNTIMES: readonly SkillRuntime[] =
  skillRuntimeSchema.options;

// --- Lifecycle status ---

/**
 * Lifecycle status of a skill.
 *
 * - `active` — visible in the system prompt's skill index; the model can
 *   discover and invoke it. This is the default for any skill that was
 *   imported (git / ClawHub) or manually created by the user.
 * - `draft` — staged but not yet visible to the model. Used by the
 *   experimental skill-distillation loop: when the background reviewer
 *   proposes a new skill (either self-authored or a ClawHub suggestion),
 *   it lands here so the user can approve / install / discard it from
 *   the Skills page without it polluting the prompt until approved.
 * - `archived` — soft-deleted. Kept on disk (recoverable) but hidden from
 *   the prompt and from the default Skills listing. The curator promotes
 *   stale / low-signal skills here instead of hard-deleting them.
 *
 * Backward-compat: rows written before this field existed deserialize as
 * `active` via the `.default('active')` on the schema, so introducing the
 * field does not migrate or break existing skills.
 */
export const skillStatusSchema = z.enum(['draft', 'active', 'archived']);
export type SkillStatus = z.infer<typeof skillStatusSchema>;
export const SKILL_STATUS_VALUES: readonly SkillStatus[] =
  skillStatusSchema.options;

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
  status: skillStatusSchema.default('active'),
  /**
   * Free-form provenance for draft skills. Currently populated by the
   * skill-distillation loop to record how the draft was produced so the
   * Skills-page review UI can render the right actions ("install from
   * ClawHub" vs "review generated SKILL.md"). Omitted / empty for
   * user-created / imported skills.
   */
  draft: z
    .object({
      /** `'self_authored'` (we generated the SKILL.md) | `'clawhub_suggestion'` (install a remote skill). */
      origin: z.enum(['self_authored', 'clawhub_suggestion']).optional(),
      /** ClawHub slug when origin === 'clawhub_suggestion'. */
      clawhubSlug: z.string().optional(),
      /** Why the reviewer thought this was worth saving. */
      rationale: z.string().optional(),
      /** The session that produced the draft. */
      sourceSessionId: z.string().optional(),
      createdAt: z.number().int().nonnegative().optional(),
    })
    .optional(),
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
 * Returns the runtime literal only when the author has explicitly opted
 * in via `runtime: <value>`. Returns `null` otherwise — in which case
 * `runSkill` refuses to dispatch and callers must treat all non-md files
 * as read-only reference material. Unknown string values coerce to
 * `null` rather than throwing, so a typo in a third-party SKILL.md
 * degrades to "read-only" instead of breaking the skill loader.
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
 * Build the shell command a sandbox/host should run to launch the skill's
 * entrypoint for the given runtime. `entrypointPath` is always relative
 * to the skill's own directory (i.e. the path the caller passed to
 * `writeFile` / `local_write_file` when materializing the skill). The
 * caller is responsible for `cd`-ing into that directory before running
 * this command, so that relative imports / file reads inside the script
 * resolve correctly.
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
  status: skillStatusSchema.default('active'),
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
    status: detail.status ?? 'active',
  };
}

export { clawhubManifestSchema } from './clawhub';
export type { ClawHubManifest } from './clawhub';
