/**
 * Skill distillation loop — the "self-improving" half of the skills system.
 *
 * After a conversation with enough tool-call density closes, this module
 * runs a single background LLM call over the transcript to decide whether
 * the workflow just executed is worth turning into a reusable skill. It
 * runs as an `afterResponse` callback (same best-effort channel as memory
 * extraction in lib/memory/extract.ts) and stages any proposal as a
 * **draft** skill — never auto-activated, never injected into the system
 * prompt until the user approves it on the Skills page.
 *
 * Two-stage proposal:
 *   1. The reviewer LLM looks at the transcript and decides:
 *        - is this a reusable capability at all? (chit-chat → skip)
 *        - if yes, what's a good name / description / search query?
 *   2. If `preferClawHub` is on, we first search the ClawHub skill hub
 *      with that query. A high-scoring hit becomes an "install suggestion"
 *      draft (reusing a community skill is usually better than a model's
 *      first guess). Otherwise we self-author a SKILL.md and stage that.
 *
 * What this deliberately does NOT do:
 *   - Auto-activate drafts. The model never sees them until the user
 *     approves (drafts are filtered out of buildSystemPrompt).
 *   - Run synchronously. Always afterResponse — never blocks the reply.
 *   - Hard-delete anything. Discarded drafts go through removeSkillDetail,
 *     but the archive path (setSkillStatus → 'archived') is the
 *     recoverable alternative exposed by the curator.
 *
 * Inspiration: Hermes Agent's `_skill_nudge_interval` + background review.
 * Implementation is from scratch — data models and runtimes differ too
 * much to port directly. The "review on a separate model call, never
 * touch the main prompt cache" discipline is the borrowed idea.
 */

import { generateObject } from 'ai';
import { z } from 'zod';

import {
  downloadAndSyncSkillFromClawHub,
  searchClawHubSkills,
} from '@/lib/core/blob/skills';
import {
  checkSkillNameExists,
  persistManualSkill,
  upsertSkillDetail,
} from '@/lib/core/kv/skills';
import { getVisibleSessionMessages } from '@/lib/core/db/chat';
import { buildConversationContext } from '@/lib/memory/extract';
import { resolveLanguageModel } from '@/lib/ai';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { SkillDetail } from '@/types/skills';

import { maybeCurateSkills } from './curator';

const logger = createLogger('skills.distill');

/**
 * Minimum tool-call count to even consider running the reviewer. This is a
 * hard floor independent of the user-configured threshold — it exists so a
 * misconfigured `toolCallThreshold: 3` still can't fire on near-empty
 * sessions where there's nothing to distill.
 */
const MIN_REAL_TOOL_CALLS = 3;

const MAX_CONTEXT_CHARS = 12000;

const reviewSchema = z.object({
  shouldDistill: z
    .boolean()
    .describe(
      'True only when the conversation executed a reusable multi-step procedure worth saving as a skill. False for chit-chat, one-shot Q&A, trivial lookups, or debugging sessions that did not converge on a repeatable workflow.',
    ),
  /** Dotted skill name, e.g. "deploy-vercel-preview". Empty if not distilling. */
  skillName: z
    .string()
    .min(1)
    .describe(
      'lowercase-hyphenated skill name, <=64 chars, no spaces. Empty string if shouldDistill is false.',
    )
    .optional()
    .default(''),
  /** One-sentence capability description, <=100 chars. Empty if not distilling. */
  description: z.string().max(200).optional().default(''),
  /** Natural-language query for the ClawHub skill hub search. Empty if not distilling. */
  clawhubQuery: z
    .string()
    .describe(
      'A short natural-language query (a few keywords) describing the capability, suitable for searching the ClawHub skill hub. Empty string if shouldDistill is false.',
    )
    .optional()
    .default(''),
  /** Short rationale shown to the user on the Skills review page. */
  rationale: z
    .string()
    .max(400)
    .describe(
      'One or two sentences explaining why this workflow is worth saving as a skill, written for the user reading the Skills review page. Empty string if shouldDistill is false.',
    )
    .optional()
    .default(''),
});

const REVIEW_PROMPT = `You are a skill curator. After a conversation ends, you scan the transcript and decide whether the workflow the agent just executed is worth turning into a reusable skill.

Distill a skill ONLY when ALL of these hold:
- The conversation executed a concrete, repeatable procedure (a deploy step, a data pipeline, a debugging recipe that converged, an analysis workflow, etc.).
- The procedure is general enough to be useful again on a different target (not "fix THIS specific bug in THIS specific file").
- The procedure was multi-step (used several tools), not a single command or a single file read.

Do NOT distill for:
- Chit-chat, greetings, one-shot factual Q&A.
- Sessions that only read/explained without converging on a workflow.
- Tasks so specific they would never recur (debugging one transient flake).
- Things already covered by a standard tool the agent has (git, npm, grep).

When you DO distill:
- skillName: lowercase-hyphenated, describes the CAPABILITY not the instance (good: "deploy-vercel-preview"; bad: "fix-tuesday-deploy").
- description: one sentence stating the capability. No marketing words.
- clawhubQuery: 2-5 keywords someone would type into a skill search to find this. Think "what would I search for?".
- rationale: why is this worth saving? What about this session made it click?

Return shouldDistill=false with empty fields if it's not worth saving. It is FINE and EXPECTED to return false for most sessions.`;

export interface DistillResult {
  /** Whether a draft was staged. */
  distilled: boolean;
  /** 'self_authored' (we wrote a SKILL.md) | 'clawhub_suggestion' (install prompt) | 'skipped' (nothing worth saving). */
  origin: 'self_authored' | 'clawhub_suggestion' | 'skipped';
  /** Name of the staged draft skill, when distilled. */
  skillName?: string;
  /** ClawHub slug we suggested installing, when origin === 'clawhub_suggestion'. */
  clawhubSlug?: string;
  reason?: string;
}

/**
 * Main entry point. Called from the workflow's afterResponse drain — same
 * channel as extractMemoriesFromSession. Best-effort: any failure is
 * logged and swallowed so it can never break the host response.
 *
 * Returns the outcome for logging / tests. Production callers ignore it.
 */
export async function maybeDistillSkillFromSession(input: {
  sessionId: string;
  userId: string;
  config: AppConfig;
  user?: { modelPreferences?: { model?: string } | null } | null;
}): Promise<DistillResult> {
  const settings = input.config.experiments?.skillDistillation;
  if (!settings?.enabled) {
    return { distilled: false, origin: 'skipped', reason: 'disabled' };
  }

  const rows = await getVisibleSessionMessages(input.sessionId);

  // Count tool calls (rows with role 'tool'). This is the density signal:
  // a session that used 8+ tools executed real work; one that used 2 is
  // almost certainly chit-chat. Mirrors Hermes' iteration-count gate.
  const toolCallCount = rows.filter((r) => r.role === 'tool').length;
  if (
    toolCallCount < Math.max(settings.toolCallThreshold, MIN_REAL_TOOL_CALLS)
  ) {
    return {
      distilled: false,
      origin: 'skipped',
      reason: `tool_call_count_${toolCallCount}_below_threshold`,
    };
  }

  const conversationText = buildConversationContext(rows);
  if (!conversationText.trim()) {
    return { distilled: false, origin: 'skipped', reason: 'empty_context' };
  }

  const truncated =
    conversationText.length > MAX_CONTEXT_CHARS
      ? `${conversationText.slice(0, MAX_CONTEXT_CHARS)}\n…[truncated]`
      : conversationText;

  const modelId =
    input.user?.modelPreferences?.model ?? input.config.models?.model;
  if (!modelId) {
    logger.warn('distill:no_model', { sessionId: input.sessionId });
    return { distilled: false, origin: 'skipped', reason: 'no_model' };
  }

  // ── Lazy curator sweep ──
  // Piggybacked on the distill trigger (same afterResponse channel).
  // Runs at most once per CURATOR_INTERVAL_MS; when the interval hasn't
  // elapsed it returns immediately with no KV write. Runs BEFORE the
  // distill review so any new draft we're about to stage isn't reviewed
  // in the same pass (that would be self-defeating — a brand-new draft
  // hasn't had time to prove useful). Best-effort; failures are logged
  // inside and never block distill.
  try {
    await maybeCurateSkills({ config: input.config, user: input.user });
  } catch (err) {
    logger.warn('distill:curator_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Stage 1: review ──
  let review: z.infer<typeof reviewSchema>;
  try {
    const result = await generateObject({
      model: resolveLanguageModel(modelId, input.config),
      schema: reviewSchema,
      schemaName: 'SkillDistillationReview',
      system: REVIEW_PROMPT,
      prompt: `Conversation (tool calls = ${toolCallCount}):\n${truncated}`,
    });
    review = result.object;
  } catch (err) {
    logger.warn('distill:review_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      distilled: false,
      origin: 'skipped',
      reason: 'review_llm_failed',
    };
  }

  if (!review.shouldDistill || !review.skillName) {
    return { distilled: false, origin: 'skipped', reason: 'review_declined' };
  }

  const skillName = sanitizeSkillName(review.skillName);
  if (!skillName) {
    return { distilled: false, origin: 'skipped', reason: 'invalid_name' };
  }

  // ── Stage 2: prefer ClawHub ──
  if (settings.preferClawHub && review.clawhubQuery) {
    const hits = await searchClawHubSkills({
      query: review.clawhubQuery,
      limit: 3,
    });
    const top = hits[0];
    if (top && top.score >= settings.clawhubMinScore) {
      try {
        return await stageClawHubSuggestion({
          slug: top.slug,
          skillName,
          description: review.description || top.summary.slice(0, 100),
          rationale: review.rationale,
          query: review.clawhubQuery,
          score: top.score,
          sessionId: input.sessionId,
        });
      } catch (err) {
        // Fall through to self-authoring if the ClawHub path breaks — a
        // self-authored draft is strictly better than dropping the review.
        logger.warn('distill:clawhub_stage_failed', {
          sessionId: input.sessionId,
          slug: top.slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Stage 3: self-author ──
  try {
    return await stageSelfAuthored({
      skillName,
      description: review.description,
      rationale: review.rationale,
      conversationText: truncated,
      sessionId: input.sessionId,
      modelId,
      config: input.config,
    });
  } catch (err) {
    logger.warn('distill:self_author_failed', {
      sessionId: input.sessionId,
      skillName,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      distilled: false,
      origin: 'skipped',
      reason: 'self_author_failed',
    };
  }
}

// ─── Staging helpers ───

async function stageClawHubSuggestion(input: {
  slug: string;
  skillName: string;
  description: string;
  rationale: string;
  query: string;
  score: number;
  sessionId: string;
}): Promise<DistillResult> {
  const finalName = await resolveUniqueName(input.skillName);

  // Fetch the real skill manifest from ClawHub so the draft carries the
  // actual file list / frontmatter (not just the search hit summary). If
  // the fetch fails we bail entirely — we never want to stage a
  // "suggestion" with fake contents, the user would have nothing real to
  // install.
  const detail = await downloadAndSyncSkillFromClawHub({
    slug: input.slug,
  });

  const draftDetail: SkillDetail = {
    ...detail,
    // Override the name: ClawHub slugs can clash with existing local
    // skills, and the review may have picked a friendlier name.
    name: finalName,
    status: 'draft',
    draft: {
      origin: 'clawhub_suggestion',
      clawhubSlug: input.slug,
      rationale: input.rationale,
      sourceSessionId: input.sessionId,
      createdAt: Date.now(),
    },
  };

  await upsertSkillDetail(draftDetail);

  logger.info('distill:staged_clawhub', {
    sessionId: input.sessionId,
    slug: input.slug,
    name: finalName,
    score: input.score,
    query: input.query,
  });

  return {
    distilled: true,
    origin: 'clawhub_suggestion',
    skillName: finalName,
    clawhubSlug: input.slug,
  };
}

async function stageSelfAuthored(input: {
  skillName: string;
  description: string;
  rationale: string;
  conversationText: string;
  sessionId: string;
  modelId: string;
  config: AppConfig;
}): Promise<DistillResult> {
  const finalName = await resolveUniqueName(input.skillName);

  // Author a SKILL.md body from the transcript. We use a second LLM call
  // rather than dumping the transcript verbatim: a curated procedure is
  // far more reusable than a raw log, and keeps the draft reviewable.
  const body = await authorSkillBody({
    skillName: finalName,
    description: input.description,
    conversationText: input.conversationText,
    modelId: input.modelId,
    config: input.config,
  });

  const skillMd = renderSkillMarkdown({
    name: finalName,
    description: input.description,
    body,
  });

  const detail = await persistManualSkill({
    name: finalName,
    description: input.description,
    files: [{ path: 'SKILL.md', content: skillMd }],
    status: 'draft',
    draft: {
      origin: 'self_authored',
      rationale: input.rationale,
      sourceSessionId: input.sessionId,
      createdAt: Date.now(),
    },
  });

  logger.info('distill:staged_self_authored', {
    sessionId: input.sessionId,
    name: finalName,
  });

  return {
    distilled: true,
    origin: 'self_authored',
    skillName: detail.name,
  };
}

// ─── Skill body authoring ───

async function authorSkillBody(input: {
  skillName: string;
  description: string;
  conversationText: string;
  modelId: string;
  config: AppConfig;
}): Promise<string> {
  const result = await generateObject({
    model: resolveLanguageModel(input.modelId, input.config),
    schemaName: 'SkillBody',
    schema: z.object({
      whenToUse: z
        .array(z.string())
        .describe(
          'Concrete trigger phrases / situations when this skill applies.',
        ),
      procedure: z
        .array(z.string())
        .describe(
          'Numbered-step procedure. Each step is one actionable instruction referencing AgentBoster tools by name (sandbox.exec, sandbox.readFile, runSkill, etc.). Extracted and generalized from the conversation, NOT a verbatim log.',
        ),
      pitfalls: z
        .array(z.string())
        .describe(
          "Known gotchas, rate limits, things that look broken but aren't. Empty array if none.",
        ),
    }),
    system: `You are writing the body of a SKILL.md for the AgentBoster skill "${input.skillName}" (${input.description}).

Distill the procedure from the conversation below into a clean, GENERALIZED procedure — the next person running this skill will not have this exact conversation, they will have a structurally similar one. Drop instance-specific paths/values and describe the step generically unless a value is a true constant (an API endpoint, a config key name).

Reference AgentBoster tools by name in backticks: \`sandbox.exec\`, \`sandbox.readFile\`, \`sandbox.writeFile\`, \`local_exec\`, \`local_read_file\`, \`runSkill\`, \`getSkillFile\`, \`memory\`, \`web_fetch\`. Do NOT reference raw shell utilities (cat, grep, curl) when an AgentBoster tool covers them.

Be terse. The skill body is reference material, not prose.`,
    prompt: `Conversation transcript:\n${input.conversationText}`,
  });

  const { whenToUse, procedure, pitfalls } = result.object;
  const lines: string[] = [];

  lines.push('## When to Use');
  for (const item of whenToUse) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Procedure');
  procedure.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });
  if (pitfalls.length > 0) {
    lines.push('');
    lines.push('## Pitfalls');
    for (const item of pitfalls) lines.push(`- ${item}`);
  }

  return lines.join('\n');
}

function renderSkillMarkdown(input: {
  name: string;
  description: string;
  body: string;
}): string {
  return [
    '---',
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description)}`,
    'version: 0.1.0',
    '---',
    '',
    `# ${input.name}`,
    '',
    input.description,
    '',
    input.body,
    '',
  ].join('\n');
}

// ─── Utilities ───

function sanitizeSkillName(raw: string): string {
  // lowercase-hyphenated, drop anything else, collapse runs of separators.
  const cleaned = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Enforce a reasonable length; the schema min is 1 but we want useful names.
  return cleaned.slice(0, 64);
}

/**
 * Resolve name collisions against existing skills (any status — including
 * drafts and archived) by appending `-2`, `-3`, ... until free. We check
 * across ALL statuses because reusing an archived skill's name would
 * resurrect it confusingly in the index.
 */
async function resolveUniqueName(base: string): Promise<string> {
  if (!(await checkSkillNameExists(base))) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!(await checkSkillNameExists(candidate))) return candidate;
  }
  // Extremely unlikely fallback — append a timestamp slug.
  return `${base}-${Date.now().toString(36)}`;
}
