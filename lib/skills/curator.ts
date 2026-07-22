/**
 * Skill curator — background maintenance for the skill library.
 *
 * Mirrors the lazy-trigger discipline of `reapStaleNodes`
 * (lib/extra/agent/node-liveness.ts): there is no long-running scheduler
 * on serverless, so the curator piggybacks on the skill-distillation
 * trigger. Each time `maybeCurateSkills` is called (from the distill
 * path, which itself runs afterResponse), it checks whether enough time
 * has passed since the last curation; if so, it runs one pass and
 * stamps a new last-run timestamp. Otherwise it returns immediately —
 * no KV write, no LLM call.
 *
 * What a pass does:
 *   - Loads all draft skills (the only artifacts the distillation loop
 *     produces). Archived / active skills are left alone — the user
 *     already made a decision about those.
 *   - If there are no drafts, returns. Nothing to review.
 *   - Otherwise: one generateObject call over the draft set. For each
 *     draft the model picks `keep` (leave for the user) or `archive`
 *     (low-signal / duplicate / stale — auto-archive so the review
 *     queue doesn't grow without bound).
 *
 * What it deliberately does NOT do:
 *   - Touch active skills. The user promoted them; the curator never
 *     second-guesses that. (Hermes' curator archives active skills too,
 *     but Hermes has a single user and local files. In a multi-tenant
 *     web app, auto-demoting a skill the user explicitly enabled would
 *     be surprising and hard to notice.)
 *   - Hard-delete. Archiving is recoverable; the user can still find
 *     archived skills via the existing UI and restore them.
 *   - Run concurrently with itself. The KV timestamp is the guard; with
 *     a 6h interval and a best-effort single LLM call, the cost of a
 *     racy double-run is negligible (two archive decisions instead of
 *     one), so we don't bother with a distributed lock.
 *
 * Inspiration: Hermes Agent's curator (agent/curator.py), adapted for a
 * serverless, multi-tenant, web-authoritative deployment.
 */

import { generateObject } from 'ai';
import { z } from 'zod';

import { get, set } from '@/lib/core/kv';
import { archiveSkill, listSkillDetails } from '@/lib/core/kv/skills';
import { resolveLanguageModel } from '@/lib/ai';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { SkillDetail } from '@/types/skills';

const logger = createLogger('skills.curator');

const CURATOR_LAST_RUN_KEY = 'skills:curator:last_run';

/**
 * Hard cap on how many drafts the curator reviews in one pass. Each
 * draft adds tokens to the review prompt; beyond ~25 the context starts
 * to crowd out the reasoning and the model starts rubber-stamping. We
 * take the OLDEST drafts first (they've had the longest to age out of
 * relevance).
 */
const MAX_DRAFTS_PER_PASS = 25;

const reviewSchema = z.object({
  decisions: z
    .array(
      z.object({
        name: z
          .string()
          .describe('The skill name, exactly as given in the input.'),
        verdict: z
          .enum(['keep', 'archive'])
          .describe(
            'keep = the draft looks plausible and the user should still see it in the review queue. archive = low-signal, duplicate, or stale — auto-archive so the queue stays manageable.',
          ),
        reason: z
          .string()
          .max(200)
          .describe('One short sentence justifying the verdict.'),
      }),
    )
    .describe('One entry per draft in the input, using its exact name.'),
});

const REVIEW_PROMPT = `You are a skill librarian reviewing the queue of draft skills staged for the user's review. The drafts were auto-generated from past conversations (either self-authored or ClawHub install suggestions).

For each draft, decide:
- **keep**: the draft describes a plausible, reusable capability the user might genuinely want. The user should still see it in the review queue to make the final call.
- **archive**: the draft is low-signal, a duplicate of something obvious, or so vague / instance-specific that it's noise. Auto-archiving keeps the review queue focused — the user can still recover archived skills later.

Be conservative about archiving: when in doubt, keep. The user made zero effort to produce these drafts (the system did), so discarding a borderline-good one costs them nothing, but archiving a genuinely useful draft silently buries it. Lean toward \`keep\` unless the draft is clearly junk.

Return one decision per draft, using the exact \`name\` given.`;

export interface CuratorResult {
  /** Whether a curation pass actually ran this call. */
  ran: boolean;
  /** Why it didn't run, when ran === false. */
  reason?: string;
  reviewed: number;
  archived: number;
  kept: number;
}

/**
 * Entry point. Call from the distill path (afterResponse). Best-effort:
 * any failure is logged and swallowed.
 *
 * Returns the outcome for logging / tests. Production callers ignore it.
 */
export async function maybeCurateSkills(input: {
  config: AppConfig;
  user?: { modelPreferences?: { model?: string } | null } | null;
}): Promise<CuratorResult> {
  const intervalHours =
    input.config.experiments?.skillDistillation?.curatorIntervalHours ?? 6;
  // 0 = explicitly disabled. Keep the queue as-is; never run.
  if (intervalHours <= 0) {
    return {
      ran: false,
      reason: 'disabled',
      reviewed: 0,
      archived: 0,
      kept: 0,
    };
  }
  const intervalMs = intervalHours * 60 * 60 * 1000;

  const lastRunRaw = await get(CURATOR_LAST_RUN_KEY);
  const lastRun = parseTimestamp(lastRunRaw);
  const now = Date.now();

  if (lastRun !== null && now - lastRun < intervalMs) {
    return {
      ran: false,
      reason: 'interval_not_elapsed',
      reviewed: 0,
      archived: 0,
      kept: 0,
    };
  }

  const drafts = await listSkillDetails({ status: 'draft' });
  if (drafts.length === 0) {
    // Nothing to review. Still stamp the run time so we don't re-query
    // the KV store on every subsequent trigger — the interval gate is
    // the cheap path.
    await set(CURATOR_LAST_RUN_KEY, JSON.stringify(now));
    return {
      ran: true,
      reason: 'no_drafts',
      reviewed: 0,
      archived: 0,
      kept: 0,
    };
  }

  // Oldest first: these have had the most time to age out of relevance,
  // and we cap the batch to keep the review prompt focused.
  const sorted = [...drafts].sort((a, b) => a.updatedAt - b.updatedAt);
  const batch = sorted.slice(0, MAX_DRAFTS_PER_PASS);

  const modelId =
    input.user?.modelPreferences?.model ?? input.config.models?.model;
  if (!modelId) {
    logger.warn('curate:no_model');
    return {
      ran: false,
      reason: 'no_model',
      reviewed: 0,
      archived: 0,
      kept: 0,
    };
  }

  const payload = batch.map(summarizeDraftForReview);

  let review: z.infer<typeof reviewSchema>;
  try {
    const result = await generateObject({
      model: resolveLanguageModel(modelId, input.config),
      schema: reviewSchema,
      schemaName: 'SkillCuratorReview',
      system: REVIEW_PROMPT,
      prompt: `Draft skills pending review (names must be echoed exactly in the output):\n${JSON.stringify(payload, null, 2)}`,
    });
    review = result.object;
  } catch (err) {
    logger.warn('curate:review_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ran: false,
      reason: 'review_llm_failed',
      reviewed: 0,
      archived: 0,
      kept: 0,
    };
  }

  // Index decisions by name for a stable lookup. The model is instructed
  // to echo names exactly; we skip any decision whose name we don't
  // recognize (defensive against hallucinated names).
  const decisionByName = new Map(review.decisions.map((d) => [d.name, d]));

  let archived = 0;
  let kept = 0;
  for (const draft of batch) {
    const decision = decisionByName.get(draft.name);
    if (decision?.verdict !== 'archive') {
      kept += 1;
      continue;
    }
    try {
      await archiveSkill(draft.name);
      archived += 1;
      logger.info('curate:archived', {
        name: draft.name,
        reason: decision.reason,
      });
    } catch (err) {
      // A single archive failure shouldn't abort the loop — record it
      // and move on. The draft just stays in the queue for next pass.
      logger.warn('curate:archive_failed', {
        name: draft.name,
        error: err instanceof Error ? err.message : String(err),
      });
      kept += 1;
    }
  }

  await set(CURATOR_LAST_RUN_KEY, JSON.stringify(now));

  logger.info('curate:done', {
    reviewed: batch.length,
    archived,
    kept,
  });

  return {
    ran: true,
    reviewed: batch.length,
    archived,
    kept,
  };
}

// ─── Helpers ───

function parseTimestamp(raw: unknown): number | null {
  if (raw == null) return null;
  // The KV layer may return a number, a numeric string, or a JSON-encoded
  // number (we always write via JSON.stringify). Accept all three.
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'number' && Number.isFinite(parsed)
      ? parsed
      : null;
  }
  return null;
}

/**
 * Render a draft into a compact object for the review prompt. We include
 * the provenance (self-authored vs ClawHub suggestion) and rationale
 * because they carry a lot of signal for the keep/archive decision — a
 * self-authored draft with a vague rationale is a much weaker candidate
 * than a ClawHub suggestion with a high search score.
 */
function summarizeDraftForReview(draft: SkillDetail): {
  name: string;
  description: string;
  origin: string;
  rationale: string;
  age_hours: number;
  file_count: number;
} {
  const ageHours = draft.updatedAt
    ? Math.round((Date.now() - draft.updatedAt) / (60 * 60 * 1000))
    : 0;
  return {
    name: draft.name,
    description: draft.description,
    origin: draft.draft?.origin ?? 'unknown',
    rationale: draft.draft?.rationale ?? '',
    age_hours: ageHours,
    file_count: draft.files.length,
  };
}
