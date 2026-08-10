/**
 * Post-run cleanup workflow — runs memory extraction, skill distillation,
 * and resource cleanup in an INDEPENDENT workflow run, fire-and-forget,
 * after the chat workflow has already closed its UI stream.
 *
 * Why a separate workflow (not inline steps inside chatWorkflow)?
 *   chatWorkflow calls writeStreamClose() immediately after
 *   finalizeRunStep('completed'). The cleanup trio below issues LLM
 *   calls (memory extraction + skill distillation) that can take
 *   seconds-to-minutes; running them as inline steps made the client
 *   block on finish until they completed. Spinning them off into their
 *   own workflow run lets the Queue Service schedule them independently
 *   while the client has already received `finish`.
 *
 * This restores the semantics the codebase had before the
 * fire-and-forget refactor, when cleanup ran in an afterResponse()
 * drain queue ("never blocks the reply"). afterResponse() was removed
 * because no host process reliably drains it under fire-and-forget
 * (POST /api/ai returns 202 immediately); a separate workflow run is
 * the durable replacement.
 *
 * Inputs are the same serializable values chatWorkflow already receives
 * (so they are known workflow-serializable): sessionId, userId, config,
 * user. source.type is passed as a string so the scheduled-session gate
 * can be re-evaluated here without re-serializing the full ChatSource.
 *
 * All three operations are best-effort: each is wrapped so a failure
 * cannot fail the run (and even if the run fails, it has no effect on
 * the already-completed chat run that spawned it).
 *
 * Nesting pattern mirrors `scheduledTaskWorkflow`, which is similarly
 * `start()`-ed from inside another workflow (see
 * lib/workflow/agent/tools/tasks/schedule.ts).
 */
import { extractMemoriesFromSession } from '@/lib/memory/extract';
import { maybeDistillSkillFromSession } from '@/lib/skills/distill';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { ChatSource } from '@/types/workflow';

const logger = createLogger('workflow.post-run-cleanup');

export interface PostRunCleanupInput {
  sessionId: string;
  /** Owning user; required for memory extraction + skill distillation.
   *  Omitted for scheduled sessions (which only run resource cleanup). */
  userId?: string;
  config: AppConfig;
  user?: { modelPreferences?: { model?: string } | null } | null;
  /** source.type at the time the chat run completed — used to re-evaluate
   *  the scheduled-session gate (scheduled runs skip memory + skills). */
  sourceType: ChatSource['type'];
  /** Workspace scope for memory extraction. Resolved at the host boundary
   *  (chatWorkflow) so the step body doesn't touch the DB directly.
   *  Null/undefined = global layer. */
  workspaceId?: string | null;
}

/**
 * Post-run cleanup workflow. Spawned via `start(postRunCleanupWorkflow,
 * [input])` from chatWorkflow after the UI stream is closed. The parent
 * run does NOT await this — it is fire-and-forget.
 *
 * Step bodies use dynamic `await import(...)` for any DB-touching
 * helper, per the repo rule that files in the workflow tree must not
 * have top-level `node:*` imports (and must not import `next/server`).
 */
export async function postRunCleanupWorkflow(input: PostRunCleanupInput) {
  'use workflow';

  const { sessionId, userId, config, user, sourceType, workspaceId } = input;

  // Session-kind gating (OpenClaw hygiene rule): only interactive
  // sessions (web / im / cli) produce durable memory OR staged skills.
  // Scheduled/cron runs are excluded explicitly from BOTH — they can
  // write task artifacts, but nothing they emit is eligible for
  // long-term memory or for review-queue skill drafts.
  if (sourceType !== 'scheduled' && userId) {
    await extractMemoriesStep({
      sessionId,
      userId,
      config,
      user,
      workspaceId,
    });
    await distillSkillStep({
      sessionId,
      userId,
      config,
      user,
    });
  }

  // Resource cleanup always runs (regardless of session kind).
  // stopSandbox:false keeps the sandbox warm for the next message in
  // this session (faster startup); it only logs and touches metadata.
  await cleanupResourcesStep({ sessionId, stopSandbox: false });
}

async function extractMemoriesStep(input: {
  sessionId: string;
  userId: string;
  config: AppConfig;
  user?: { modelPreferences?: { model?: string } | null } | null;
  /** Workspace scope, resolved at the host boundary (chatWorkflow reads it
   *  off the session row / lock handle and passes it in). Null/undefined =
   *  global layer. Step bodies must not touch the DB directly. */
  workspaceId?: string | null;
}) {
  'use step';

  try {
    await extractMemoriesFromSession({
      sessionId: input.sessionId,
      userId: input.userId,
      config: input.config,
      user: input.user,
      workspaceId: input.workspaceId ?? null,
    });
  } catch (err) {
    // Best-effort: log and swallow. A failure here must not fail the
    // cleanup run (and even if it did, the parent chat run is already
    // completed and unaffected).
    logger.warn('memory:extract_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function distillSkillStep(input: {
  sessionId: string;
  userId: string;
  config: AppConfig;
  user?: { modelPreferences?: { model?: string } | null } | null;
}) {
  'use step';

  try {
    await maybeDistillSkillFromSession({
      sessionId: input.sessionId,
      userId: input.userId,
      config: input.config,
      user: input.user,
    });
  } catch (err) {
    logger.warn('skills:distill_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function cleanupResourcesStep(input: {
  sessionId: string;
  stopSandbox: boolean;
}) {
  'use step';

  try {
    const { cleanupWorkflowResources } = await import('./cleanup');
    await cleanupWorkflowResources({
      sessionId: input.sessionId,
      stopSandbox: input.stopSandbox,
    });
  } catch (err) {
    logger.warn('cleanup:failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
