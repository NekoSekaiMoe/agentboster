import { tool } from 'ai';
import { z } from 'zod';

import {
  downloadAndSyncSkillsFromGit,
  downloadAndSyncSkillFromClawHub,
  getSkillFileContentFromBlob,
  listSkillFilesWithContentFromBlob,
} from '@/lib/core/blob/skills';
import {
  getSkillDetail,
  listSkillMetas,
  persistManualSkill,
  removeSkillDetail,
  syncRepoSkillDetails,
  upsertSkillDetail,
  updateSkillFile,
} from '@/lib/core/kv/skills';
import {
  buildSkillExecCommand,
  getSkillEntrypointPath,
  getSkillRuntime,
  SKILL_RUNTIMES,
} from '@/types/skills';
import type { TranslationKey, TranslationValues } from '@/lib/i18n';
import type { ChatSource } from '@/types/workflow';
import { defineBuildInTool } from '../define';

/**
 * Hard ceiling on the number of files we push onto an execution surface
 * in a single runSkill call. Matches the skill-import pipeline cap
 * (GIT_IMPORT_MAX_FILE_COUNT = 500 in lib/core/blob/skills.ts) so a
 * freshly imported skill can always be synced end-to-end.
 */
const RUN_SKILL_MAX_FILES = 500;

/**
 * Per-call wall-clock budget for the entrypoint. Matches the agentd
 * `exec` tool's default and the Vercel Sandbox wait timeout.
 */
const RUN_SKILL_EXEC_TIMEOUT_SECONDS = 120;

/**
 * Bounds how long a skill-mutation approval wait can suspend a run.
 * Human-in-the-loop waits are unbounded by nature; without a ceiling a
 * never-answered /approve leaves the durable run (and its hook)
 * pending forever. On expiry the wait resolves as approved=false — the
 * same downstream deny path as an explicit /reject. 24h matches the
 * human-response expectation for admin approvals.
 */
const SKILL_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SKILL_APPROVAL_TIMEOUT_HOURS = 24;

/** POSIX single-quote escape for shell argument lists. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve which execution surface runSkill should target for the given
 * chat source. Mirrors the dispatch baked into sanbox.ts (sandbox) and
 * local/index.ts (local-cli):
 *
 *   - `cli` source → user's own machine via local_exec IPC.
 *   - `im` source with `remoteIm` → attached CLI host (L2-gated).
 *   - `web` / `im` / `scheduled` → sandbox surface (agentd first,
 *     Vercel Sandbox fallback).
 *
 * `null` means "no compatible surface" — runSkill refuses to dispatch
 * rather than guessing.
 */
function resolveExecutionSurface(
  source: ChatSource | undefined,
): { kind: 'cli-host'; isRemoteControl: boolean } | { kind: 'sandbox' } | null {
  if (!source) return null;
  switch (source.type) {
    case 'cli':
      return { kind: 'cli-host', isRemoteControl: false };
    case 'im':
      if (source.remoteIm) {
        return { kind: 'cli-host', isRemoteControl: true };
      }
      return { kind: 'sandbox' };
    case 'web':
    case 'scheduled':
      return { kind: 'sandbox' };
    default:
      return null;
  }
}

/**
 * Step-marked helper for the agentd backend. The `'use step'` directive
 * is critical: it tells the workflow DevKit bundler to treat this
 * function as a step boundary and NOT inline its body into the host
 * tool module. Without it, the `await import` calls below would be
 * statically walked during build and pull lib/core/blob/skills into
 * the steps bundle, failing with workflow-node-module-error.
 *
 * (lib/core/blob/skills itself was made safe in this PR by lazy-loading
 * gray-matter and isomorphic-git, but we still keep the step boundary
 * here because the file also imports lib/extra/agent/agentd-tools-
 * client, which itself transitively reaches third-party packages.)
 *
 * Node pinning (review fix): when the caller does not supply an
 * explicit nodeId, we resolve the best node ONCE via selectBestNode
 * and reuse that id for the cleanup, every write, and the final exec.
 * Previously each call re-ran selectBestNode, so a multi-node install
 * could probe A, write B/C, then exec on D. When the caller supplies
 * an explicit nodeId, that id is honored for every call (still subject
 * to the allowedNodes allowlist enforced inside execToolOnAgentd).
 *
 * Cleanup (review fix): the destination `skills/<name>` directory is
 * wiped before any new file is written, so files removed/renamed in a
 * skill update cannot linger and be loaded by the entrypoint.
 *
 * Error capture (review fix): execToolOnAgentd throws on HTTP/transport
 * failure; those throws are converted into structured syncErrors /
 * execResult instead of bubbling out of the step, matching the
 * Vercel-Sandbox variant's behavior.
 */
async function materializeAndRunOnAgentd(input: {
  sessionId: string;
  nodeId?: string;
  allowedNodes?: readonly string[];
  /** Lock state for this run; forwarded verbatim to execToolOnAgentd so
   *  the busy-fallback path suppresses workspace_id (ephemeral
   *  container) instead of silently binding the workspace container. */
  workspaceLockAcquired: boolean;
  skillName: string;
  entrypoint: string;
  runtime: 'python' | 'bash';
  fullCommand: string;
  execTimeoutSeconds: number;
}): Promise<{
  syncErrors: Array<{ path: string; error: string }>;
  execResult: {
    success: boolean;
    data?: string;
    error?: string;
    node?: { id: string; name?: string; ip: string };
  } | null;
  execError: string | null;
}> {
  'use step';

  const { execToolOnAgentd } = await import(
    '@/lib/extra/agent/agentd-tools-client'
  );
  const { selectBestNode } = await import('@/lib/workflow/agent/dispatch');

  // Resolve the node id ONCE so cleanup + every write + the final
  // exec all land on the same daemon. An explicit nodeId wins; the
  // allowedNodes allowlist is enforced later inside execToolOnAgentd.
  let pinnedNodeId = input.nodeId;
  if (!pinnedNodeId) {
    const picked = await selectBestNode(undefined, input.allowedNodes);
    if (!picked) {
      return {
        syncErrors: [],
        execResult: null,
        execError: 'No Agent Daemon nodes available',
      };
    }
    pinnedNodeId = picked.nodeID;
  }

  const files = await listSkillFilesWithContentFromBlob(input.skillName);
  const syncErrors: Array<{ path: string; error: string }> = [];

  // Wipe the destination directory so stale files from a previous
  // version of this skill cannot be picked up by the entrypoint. We
  // ignore failures here — if the dir does not exist yet, `rm -rf`
  // is a no-op; a real failure will surface on the subsequent write.
  try {
    await execToolOnAgentd(
      input.sessionId,
      'exec',
      {
        command: `rm -rf ${shellQuote(`skills/${input.skillName}`)}`,
        timeout: 30,
        working_dir: '.',
      },
      pinnedNodeId,
      input.allowedNodes,
      input.workspaceLockAcquired,
    );
  } catch (err) {
    syncErrors.push({
      path: '.',
      error: `failed to clean skills/${input.skillName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  for (const file of files) {
    const relPath = file.path.replace(/^\/+/, '');
    try {
      const writeResult = await execToolOnAgentd(
        input.sessionId,
        'write',
        {
          path: `skills/${input.skillName}/${relPath}`,
          content: file.content,
        },
        pinnedNodeId,
        input.allowedNodes,
        input.workspaceLockAcquired,
      );
      if (!writeResult.success) {
        syncErrors.push({
          path: relPath,
          error: writeResult.error ?? 'unknown write error',
        });
      }
    } catch (err) {
      syncErrors.push({
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (syncErrors.length > 0) {
    return { syncErrors, execResult: null, execError: null };
  }

  try {
    const execResult = await execToolOnAgentd(
      input.sessionId,
      'exec',
      {
        command: input.fullCommand,
        timeout: input.execTimeoutSeconds,
        working_dir: '.',
      },
      pinnedNodeId,
      input.allowedNodes,
      input.workspaceLockAcquired,
    );
    return { syncErrors, execResult, execError: null };
  } catch (err) {
    return {
      syncErrors,
      execResult: null,
      execError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Step-marked helper for the Vercel Sandbox fallback. Same step-
 * boundary rationale as materializeAndRunOnAgentd.
 */
async function materializeAndRunOnVercelSandbox(input: {
  sessionId: string;
  skillName: string;
  entrypoint: string;
  runtime: 'python' | 'bash';
  fullCommand: string;
}): Promise<{
  syncErrors: Array<{ path: string; error: string }>;
  execResult:
    | {
        kind: 'completed';
        exitCode: number;
        stdout: string;
        stderr: string;
      }
    | {
        kind: 'running';
        cmdId: string;
        message: string;
      }
    | null;
  execError: string | null;
}> {
  'use step';

  // Loaded through the barrel (`@/lib/core/sandbox`) to match how
  // sanbox.ts loads these — bundler treats that path as host-only.
  const { writeSandboxFileAction, runSandboxCommandAction } = await import(
    '@/lib/core/sandbox'
  );

  const files = await listSkillFilesWithContentFromBlob(input.skillName);
  const syncErrors: Array<{ path: string; error: string }> = [];

  // Wipe the destination directory so stale files from a previous
  // version of this skill cannot be picked up by the entrypoint.
  try {
    await runSandboxCommandAction({
      sessionId: input.sessionId,
      command: `rm -rf ${shellQuote(`skills/${input.skillName}`)}`,
    });
  } catch (err) {
    syncErrors.push({
      path: '.',
      error: `failed to clean skills/${input.skillName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  for (const file of files) {
    const relPath = file.path.replace(/^\/+/, '');
    try {
      await writeSandboxFileAction({
        sessionId: input.sessionId,
        path: `skills/${input.skillName}/${relPath}`,
        content: file.content,
      });
    } catch (err) {
      syncErrors.push({
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (syncErrors.length > 0) {
    return { syncErrors, execResult: null, execError: null };
  }

  try {
    const result = await runSandboxCommandAction({
      sessionId: input.sessionId,
      command: input.fullCommand,
    });
    if (result.kind === 'running') {
      return {
        syncErrors,
        execResult: {
          kind: 'running',
          cmdId: result.cmdId,
          message: result.message,
        },
        execError: null,
      };
    }
    return {
      syncErrors,
      execResult: {
        kind: 'completed',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      execError: null,
    };
  } catch (err) {
    return {
      syncErrors,
      execResult: null,
      execError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * L2 human-approval gate for skill write operations.
 *
 * Skill files are privileged admin state: they persist across
 * conversations and are loaded as instructions/runtimes by future
 * runs, so a prompt-injection-induced "looks-legitimate" write is
 * far more dangerous than a transient sandbox exec. enforceScan
 * (the second gate) only blocks known-malicious regexes and cannot
 * catch an injected benign-looking payload. This helper is the FIRST
 * gate: every `updateSkillFile` / `upsertSkill` call must wait for
 * an explicit human approve/reject before the DAL write.
 *
 * Mirrors `waitForSandboxApproval` in
 * `lib/workflow/agent/tools/execute/sanbox.ts` but differs in two
 * deliberate ways, called out so a future reader doesn't "normalize"
 * them back together:
 *
 *   1. Unconditional. sanbox.ts gates on
 *      `appConfig.autonomy?.level === 'supervised'`; skill writes
 *      require approval in every autonomy mode because the whole
 *      point is that the model must never edit its own skill files
 *      (and thereby future prompt/instruction surfaces) without an
 *      admin's consent — even in autonomous mode. This gate now covers
 *      every skill-mutation tool: upsertSkill, updateSkillFile,
 *      deleteSkill, importSkillRepo and importSkillFromClawHub.
 *   2. The reminder text is a skill-specific, i18n-localized message
 *      describing exactly what is being mutated (`name`/`path`),
 *      instead of sanbox.ts's generic "A tool action is waiting for
 *      your approval". The approver needs to see the target skill +
 *      path inline in IM channels where the tool-input card may not
 *      be rendered. Locale resolves from the session user's recorded
 *      preference (resolveUserLocale), falling back to the project
 *      default locale.
 *
 * The wait is bounded by SKILL_APPROVAL_TIMEOUT_MS: a durable run must
 * not stay suspended on the hook forever when no /approve ever
 * arrives. Timeout resolves as approved=false (same deny path as an
 * explicit /reject) and notifies the originating channel.
 *
 * All host-only modules are dynamic-imported inside the body (rather
 * than the top-level imports sanbox.ts uses) to keep this file's
 * static import graph unchanged — this module sits inside
 * `lib/workflow/**` and the workflow DevKit bundler statically walks
 * every top-level import; the hook/writers/bot-steps modules are
 * themselves safe, but dynamic import here matches the rule in
 * AGENTS.md and keeps the blast radius of this change to one file.
 */
async function waitForSkillApproval(input: {
  source: ChatSource | undefined;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  /** Session user, used to resolve the reminder locale. */
  userId: string | undefined;
  /** i18n key of the human-readable mutation description, shown in the
   *  chat channel alongside the /approve /reject commands. */
  promptKey: TranslationKey;
  /** Interpolation values for promptKey (gitURL / name / filePath…). */
  promptValues?: TranslationValues;
}): Promise<{ approved: boolean; comment?: string }> {
  'use step';

  const { approvalHookBuilder } = await import('@/lib/workflow/agent/hooks');
  const { sendSourceReplyStep } = await import(
    '@/lib/workflow/agent/sender/bot-steps'
  );
  const { writeToolApprovalRequest, writeToolOutputDenied } = await import(
    '@/lib/workflow/agent/sender/writers'
  );
  const { t } = await import('@/lib/i18n/server');
  const { defaultLocale } = await import('@/lib/i18n');
  const { resolveUserLocale } = await import('@/lib/chat/user-locale');

  const locale =
    (input.userId ? await resolveUserLocale(input.userId) : null) ??
    defaultLocale;
  const promptText = t(locale, input.promptKey, input.promptValues);

  // Register the approval hook FIRST. Writing the approval request /
  // reminder before registration opened a race: a fast /approve could
  // arrive while no hook existed yet and fail with "Hook not found"
  // (resumeToolApproval in app/(chat)/actions.ts). Registration is
  // synchronous and non-blocking — the actual wait happens in the
  // for-await below, after the request + reminder have gone out.
  using hook = approvalHookBuilder.create({ token: input.toolCallId });

  // Emit the tool-input card + approval-request chunk so the Web UI
  // renders the pending approval inline (same writers sanbox.ts uses).
  await writeToolApprovalRequest({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    toolInput: input.toolInput,
  });

  // Push a descriptive reminder to whatever channel the conversation
  // originated from. Falling back to `{ type: 'web' }` matches
  // sanbox.ts; scheduled sources are routed through their own reply
  // path by sendRoutedSourceReply.
  const reminder = [
    promptText,
    '',
    `Approve: /approve ${input.toolCallId}`,
    `Reject: /reject ${input.toolCallId}`,
  ].join('\n');
  await sendSourceReplyStep({
    source: input.source ?? { type: 'web' },
    text: reminder,
  });

  // Race the hook against the timeout. Whichever settles first wins:
  // an approval payload keeps the existing result; the timeout stops
  // the wait and falls through as approved=false so the durable run is
  // not retained forever on an unanswered hook. Steps run host-side, so
  // a plain timer is available here (the workflow-level sleep() primitive
  // is not callable inside a 'use step' boundary).
  let approval: { approved: boolean; comment?: string } = {
    approved: false,
  };
  let timedOut = false;
  const firstPayload: Promise<{
    approved: boolean;
    comment?: string;
  } | null> = (async () => {
    for await (const payload of hook) {
      return payload as { approved: boolean; comment?: string };
    }
    return null;
  })();
  // Attach a no-op rejection handler so an abandoned loser of the race
  // never surfaces as an unhandled rejection.
  void firstPayload.catch(() => undefined);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), SKILL_APPROVAL_TIMEOUT_MS);
  });
  const winner = await Promise.race([firstPayload, timeoutPromise]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  if (winner === 'timeout') {
    timedOut = true;
  } else if (winner) {
    approval = winner;
  }

  if (!approval.approved) {
    await writeToolOutputDenied({ toolCallId: input.toolCallId });
    if (timedOut) {
      await sendSourceReplyStep({
        source: input.source ?? { type: 'web' },
        text: t(locale, 'skill.approval.timeout', {
          hours: SKILL_APPROVAL_TIMEOUT_HOURS,
        }),
      });
    }
  }

  return approval;
}

/**
 * Non-step helper for the CLI host backend. Deliberately NOT marked
 * `'use step'` because waitForLocalToolResult relies on defineHook()
 * which can only run outside a step boundary (see comment on
 * waitForLocalToolResult in ../local/index.ts).
 */
async function materializeOnCliHost(input: {
  skillName: string;
  sessionId?: string;
  runId?: string;
  isRemoteControl: boolean;
}): Promise<{
  syncErrors: Array<{ path: string; error: string }>;
}> {
  const { waitForLocalToolResult } = await import('../local/index');
  const { randomUUID } = await import('node:crypto');

  const files = await listSkillFilesWithContentFromBlob(input.skillName);
  const skillDir = `skills/${input.skillName}`;
  const syncErrors: Array<{ path: string; error: string }> = [];

  // Wipe the destination directory so stale files from a previous
  // version of this skill cannot be picked up by the entrypoint.
  // Routed through the same local_exec IPC the rest of this helper
  // uses, so the attached CLI host honors it consistently.
  const cleanCallId = `runSkill:${input.skillName}:clean:${randomUUID()}`;
  const cleanResult = await waitForLocalToolResult({
    toolCallId: cleanCallId,
    toolName: 'local_exec',
    toolInput: { command: `rm -rf ${shellQuote(skillDir)}` },
    sessionId: input.sessionId,
    runId: input.runId,
    isRemoteControl: input.isRemoteControl,
  });
  if (!cleanResult.ok) {
    syncErrors.push({
      path: '.',
      error: `failed to clean ${skillDir}: ${
        cleanResult.error ?? 'unknown clean error'
      }`,
    });
  }

  for (const file of files) {
    const relPath = file.path.replace(/^\/+/, '');
    const callId = `runSkill:${input.skillName}:write:${relPath}:${randomUUID()}`;
    const result = await waitForLocalToolResult({
      toolCallId: callId,
      toolName: 'local_write_file',
      toolInput: {
        path: `${skillDir}/${relPath}`,
        content: file.content,
      },
      sessionId: input.sessionId,
      runId: input.runId,
      isRemoteControl: input.isRemoteControl,
    });
    if (!result.ok) {
      syncErrors.push({
        path: relPath,
        error: result.error ?? 'unknown write error',
      });
    }
  }
  return { syncErrors };
}

export default defineBuildInTool({
  id: 'skills',
  description: `Manage local skills stored in KV and Blob.`,
  factory: async (_config, ctx) => {
    const sessionId = ctx?.sessionId ?? '';
    const runId = ctx?.runId ?? '';
    const source = ctx?.source;
    const userId = ctx?.userId;
    // P3.1: surface the current agent's allowed_nodes (if any) so
    // runSkill can pass it down to execToolOnAgentd. Without this,
    // a model-supplied nodeId could route to any registered daemon
    // node and bypass per-agent node authorization.
    const allowedNodes =
      ctx?.appConfig && ctx.agentName
        ? (ctx.appConfig.agents?.[ctx.agentName]?.allowed_nodes ?? undefined)
        : undefined;
    // Fail-closed when the context doesn't carry lock state: false
    // suppresses workspace_id (ephemeral container) rather than
    // silently binding the long-lived workspace container.
    const workspaceLockAcquired = ctx?.workspaceLockAcquired ?? false;
    return {
      listSkills: tool({
        title: 'List Skills',
        description: `List all skills.`,
        inputSchema: z.object({}),
        execute: async (_value) => {
          'use step';

          return { items: await listSkillMetas() };
        },
      }),

      getSkill: tool({
        title: 'Get Skill',
        description: `Get skill detail by name and get all files tree.`,
        inputSchema: z.object({
          name: z.string().min(1),
        }),
        execute: async ({ name }) => {
          'use step';

          const detail = await getSkillDetail(name);
          if (!detail) throw new Error(`Skill "${name}" not found`);
          return detail;
        },
      }),

      getSkillFile: tool({
        title: 'Get Skill File',
        description: [
          'Get file content from a skill by path as read-only text. Supports startLine/endLine for line-range slicing.',
          '',
          'IMPORTANT: the returned content is reference material only. Do NOT attempt to execute `.py` / `.sh` / `.js` / other code files you fetch here by passing them to `sandbox.exec` / `local_exec` — they are stored in blob storage and are NOT on a runtime path.',
          'To run a skill whose entrypoint you discovered here, the skill must declare `runtime: python|bash` in its frontmatter and you must call `runSkill`, which materializes the skill onto the active execution surface and launches the declared entrypoint there.',
        ].join('\n'),
        inputSchema: z.object({
          /** Skill name */
          name: z.string().min(1),
          /** File path relative to skill dir */
          path: z.string().min(1),
          /** Optional start line (1-based) */
          startLine: z.number().int().positive().optional(),
          /** Optional end line (1-based, inclusive) */
          endLine: z.number().int().positive().optional(),
        }),
        execute: async ({ name, path: filePath, startLine, endLine }) => {
          'use step';

          let content = await getSkillFileContentFromBlob(name, filePath);
          if (content === null) {
            throw new Error(`File "${filePath}" not found in skill "${name}"`);
          }

          if (startLine || endLine) {
            const lines = content.split('\n');
            const start = Math.max(1, startLine ?? 1) - 1;
            const end = Math.min(lines.length, endLine ?? lines.length);
            content = lines.slice(start, end).join('\n');
            return {
              name,
              path: filePath,
              content,
              startLine: start + 1,
              endLine: end,
              totalLines: lines.length,
            };
          }

          return { name, path: filePath, content };
        },
      }),

      getSkillEntrypoint: tool({
        title: 'Get Skill Entrypoint',
        description: `Get the primary instruction/entrypoint file for a skill. Supports ClawHub clawhub.json entrypoint metadata and falls back to SKILL.md.`,
        inputSchema: z.object({
          name: z.string().min(1),
          startLine: z.number().int().positive().optional(),
          endLine: z.number().int().positive().optional(),
        }),
        execute: async ({ name, startLine, endLine }) => {
          'use step';

          const detail = await getSkillDetail(name);
          if (!detail) throw new Error(`Skill "${name}" not found`);

          const entrypoint = getSkillEntrypointPath(detail);
          if (!entrypoint) {
            throw new Error(`Skill "${name}" does not have any files`);
          }

          let content = await getSkillFileContentFromBlob(name, entrypoint);
          if (content === null) {
            throw new Error(
              `Entrypoint "${entrypoint}" not found in skill "${name}"`,
            );
          }

          if (startLine || endLine) {
            const lines = content.split('\n');
            const start = Math.max(1, startLine ?? 1) - 1;
            const end = Math.min(lines.length, endLine ?? lines.length);
            content = lines.slice(start, end).join('\n');
            return {
              name,
              path: entrypoint,
              content,
              startLine: start + 1,
              endLine: end,
              totalLines: lines.length,
            };
          }

          return { name, path: entrypoint, content };
        },
      }),

      importSkillRepo: tool({
        title: 'Import Skill Repo',
        description: `Clone a git repo and import skills. Supports OpenClaw/ClawHub single-skill repositories with root SKILL.md, compatible root clawhub.json manifests, and AgentBoster /skills repositories.`,
        inputSchema: z.object({
          /** Git URL of the repository */
          gitURL: z.string().min(1),
        }),
        execute: async ({ gitURL }, { toolCallId }) => {
          'use step';

          // L2 approval gate (FIRST gate), matching upsertSkill /
          // updateSkillFile. The Phase-1 scan still runs inside
          // syncSkillFilesToBlob, but a regex scan cannot judge a
          // benign-looking malicious repo — a human must approve the
          // source URL before anything is downloaded or written.
          const approval = await waitForSkillApproval({
            source,
            toolCallId,
            userId,
            toolName: 'importSkillRepo',
            toolInput: { gitURL },
            promptKey: 'skill.approval.importSkillRepo',
            promptValues: { gitURL },
          });
          if (!approval.approved) {
            return {
              error:
                approval.comment ||
                `Skill import denied by admin: importSkillRepo(${gitURL})`,
            };
          }

          const imported = await downloadAndSyncSkillsFromGit(gitURL);
          const result = await syncRepoSkillDetails(gitURL, imported);
          return { gitURL, imported: result.imported, removed: result.removed };
        },
      }),

      importSkillFromClawHub: tool({
        title: 'Import Skill From ClawHub',
        description: `Import a public OpenClaw/ClawHub skill by slug from the ClawHub registry. Uses the latest version unless version is provided.`,
        inputSchema: z.object({
          slug: z.string().min(1),
          version: z.string().optional(),
        }),
        execute: async ({ slug, version }, { toolCallId }) => {
          'use step';

          // L2 approval gate (FIRST gate), matching upsertSkill /
          // updateSkillFile. Registry content is still untrusted author
          // input; the human approves slug + version before download.
          const approval = await waitForSkillApproval({
            source,
            toolCallId,
            userId,
            toolName: 'importSkillFromClawHub',
            toolInput: { slug, version },
            promptKey: 'skill.approval.importSkillFromClawHub',
            promptValues: { slug, version: version ?? 'latest' },
          });
          if (!approval.approved) {
            return {
              error:
                approval.comment ||
                `Skill import denied by admin: importSkillFromClawHub(${slug}@${version ?? 'latest'})`,
            };
          }

          const detail = await downloadAndSyncSkillFromClawHub({
            slug,
            version,
          });
          return { detail: await upsertSkillDetail(detail) };
        },
      }),

      upsertSkill: tool({
        title: 'Upsert Skill',
        description: `Create or update a skill with inline files.`,
        inputSchema: z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          files: z
            .array(z.object({ path: z.string(), content: z.string() }))
            .optional(),
        }),
        execute: async (input, { toolCallId }) => {
          'use step';

          const { name, description, files } = input;

          // L2 approval gate (FIRST gate). The approval prompt lists
          // the skill name + file paths so the human can sanity-check
          // the target before the DAL write runs. Deny returns a
          // structured error (no throw), matching sanbox.ts.
          const fileCount = files?.length ?? 0;
          const fileList =
            files && files.length > 0
              ? files.map((f) => f.path).join(', ')
              : '(no files)';
          const approval = await waitForSkillApproval({
            source,
            toolCallId,
            userId,
            toolName: 'upsertSkill',
            toolInput: input,
            promptKey: 'skill.approval.upsertSkill',
            promptValues: { name, fileCount, fileList },
          });
          if (!approval.approved) {
            return {
              error:
                approval.comment ||
                `Skill write denied by admin: upsertSkill(${name})`,
            };
          }

          const detail = await persistManualSkill({
            name,
            description: description || '',
            files: files || [],
          });
          return { detail };
        },
      }),

      updateSkillFile: tool({
        title: 'Update Skill File',
        description: `Update a single file in an existing skill.`,
        inputSchema: z.object({
          name: z.string().min(1),
          path: z.string().min(1),
          content: z.string(),
        }),
        execute: async (input, { toolCallId }) => {
          'use step';

          const { name, path: filePath, content } = input;

          // L2 approval gate (FIRST gate). The approval prompt names
          // the skill + file path and previews how large the change
          // is, so the human can spot a prompt-injected payload that
          // rewrites e.g. SKILL.md / frontmatter. Deny returns a
          // structured error (no throw), matching sanbox.ts.
          const approval = await waitForSkillApproval({
            source,
            toolCallId,
            userId,
            toolName: 'updateSkillFile',
            toolInput: input,
            promptKey: 'skill.approval.updateSkillFile',
            promptValues: { name, filePath, contentLength: content.length },
          });
          if (!approval.approved) {
            return {
              error:
                approval.comment ||
                `Skill write denied by admin: updateSkillFile(${name}/${filePath})`,
            };
          }

          const updated = await updateSkillFile(name, filePath, content);
          return { detail: updated, path: filePath };
        },
      }),

      deleteSkill: tool({
        title: 'Delete Skill',
        description: `Delete a single skill by name. Removes all its files from Blob and metadata from KV.`,
        inputSchema: z.object({
          name: z.string().min(1, 'Skill name is required'),
        }),
        execute: async ({ name }, { toolCallId }) => {
          'use step';

          // L2 approval gate (FIRST gate), matching the other
          // skill-mutation tools. Deletion is the most destructive
          // mutation — it removes the skill's blob files AND its KV
          // metadata — so it takes the same unconditional human
          // approve/reject gate before anything is removed.
          const approval = await waitForSkillApproval({
            source,
            toolCallId,
            userId,
            toolName: 'deleteSkill',
            toolInput: { name },
            promptKey: 'skill.approval.deleteSkill',
            promptValues: { name },
          });
          if (!approval.approved) {
            return {
              error:
                approval.comment ||
                `Skill delete denied by admin: deleteSkill(${name})`,
            };
          }

          const removed = await removeSkillDetail(name);
          return { action: 'delete', name, removed };
        },
      }),

      runSkill: tool({
        title: 'Run Skill Entrypoint',
        description: [
          'Execute a skill whose SKILL.md frontmatter declares `runtime: python|bash`.',
          '',
          'The skill must declare a supported `runtime` AND a valid `entrypoint` in its frontmatter; otherwise this tool refuses to dispatch and the caller must treat all non-md files as read-only reference material (use `getSkillFile` to read them as text).',
          '',
          'Routing: runSkill automatically targets the execution surface that matches where the conversation originated:',
          '  - Web / IM / scheduled → sandbox surface (agentd node if reachable, else Vercel Sandbox).',
          "  - CLI → the user's own machine via the CLI process (same channel as `local_exec`).",
          '  - IM with /attach to a CLI → the attached CLI host (subject to L2 approval if the entrypoint is risky).',
          'Pass `nodeId` to force a specific agentd node when the conversation has access to multiple.',
          '',
          'What it does end-to-end:',
          "  1. Validates runtime + entrypoint against the skill's frontmatter.",
          '  2. Pulls every file of the skill from blob storage.',
          '  3. Materializes them under `<workspace>/skills/<name>/...` on the resolved surface.',
          '  4. Runs the entrypoint with the declared runtime from inside the skill dir, with a 120s timeout.',
          '  5. Returns stdout / stderr / exit code to the caller.',
          '',
          'Do NOT attempt to execute skill files yourself via `sandbox.exec` / `local_exec` — they are not on a runtime path until runSkill places them there.',
        ].join('\n'),
        inputSchema: z.object({
          name: z.string().min(1).describe('Skill name'),
          args: z
            .array(z.string())
            .optional()
            .describe(
              'CLI args forwarded to the entrypoint after the script path',
            ),
          nodeId: z
            .string()
            .optional()
            .describe(
              'Specific agentd node id (only meaningful for sandbox surface with multi-node). Must be in the current agent allowed_nodes allowlist when one is configured.',
            ),
        }),
        execute: async ({ name, args, nodeId }) => {
          const detail = await getSkillDetail(name);
          if (!detail) {
            throw new Error(`Skill "${name}" not found`);
          }

          const runtime = getSkillRuntime(detail);
          if (!runtime) {
            throw new Error(
              `Skill "${name}" does not declare a supported \`runtime\` (expected one of: ${SKILL_RUNTIMES.join(', ')}). Files are reference-only and cannot be executed.`,
            );
          }

          // Use the frontmatter-declared entrypoint. runSkill rejects
          // SKILL.md as the entrypoint because that is documentation,
          // not runnable code — closing a footgun where a skill with
          // no explicit `entrypoint` would silently dispatch `python3
          // SKILL.md`.
          const frontmatterEntrypoint = detail.frontmatter.entrypoint;
          const entrypoint =
            typeof frontmatterEntrypoint === 'string' &&
            frontmatterEntrypoint.trim()
              ? frontmatterEntrypoint.trim()
              : null;
          if (!entrypoint) {
            throw new Error(
              `Skill "${name}" has no \`entrypoint\` in its frontmatter. runSkill requires an explicit entrypoint path (relative to the skill root).`,
            );
          }
          if (entrypoint === 'SKILL.md') {
            throw new Error(
              `Skill "${name}" entrypoint resolves to SKILL.md, which is documentation, not an executable. Set \`entrypoint\` in the frontmatter to the actual script path.`,
            );
          }
          if (!detail.files.some((f) => f.path === entrypoint)) {
            throw new Error(
              `Entrypoint "${entrypoint}" is not present in skill "${name}" files.`,
            );
          }
          if (detail.files.length > RUN_SKILL_MAX_FILES) {
            throw new Error(
              `Skill "${name}" has ${detail.files.length} files, exceeding the ${RUN_SKILL_MAX_FILES}-file sync limit for runSkill.`,
            );
          }

          const surface = resolveExecutionSurface(source);
          if (!surface) {
            throw new Error(
              `Cannot determine execution surface for this conversation source. runSkill supports cli / web / im / scheduled sources.`,
            );
          }

          const baseCommand = buildSkillExecCommand(runtime, entrypoint);
          const argString = (args ?? []).map(shellQuote).join(' ');
          const skillDirQuoted = shellQuote(`skills/${name}`);
          const fullCommand =
            argString.length > 0
              ? `cd ${skillDirQuoted} && ${baseCommand} ${argString}`
              : `cd ${skillDirQuoted} && ${baseCommand}`;

          if (surface.kind === 'cli-host') {
            const { syncErrors } = await materializeOnCliHost({
              skillName: name,
              sessionId: sessionId || undefined,
              runId: runId || undefined,
              isRemoteControl: surface.isRemoteControl,
            });
            if (syncErrors.length > 0) {
              return {
                ok: false as const,
                phase: 'sync' as const,
                surface: 'cli-host' as const,
                runtime,
                entrypoint,
                errors: syncErrors,
              };
            }
            // Re-use the same IPC loop for exec.
            const { waitForLocalToolResult } = await import('../local/index');
            const { randomUUID } = await import('node:crypto');
            const execCallId = `runSkill:${name}:exec:${randomUUID()}`;
            const execResult = await waitForLocalToolResult({
              toolCallId: execCallId,
              toolName: 'local_exec',
              toolInput: { command: fullCommand },
              sessionId: sessionId || undefined,
              runId: runId || undefined,
              isRemoteControl: surface.isRemoteControl,
            });
            return {
              ok: execResult.ok as boolean,
              phase: 'exec' as const,
              surface: 'cli-host' as const,
              runtime,
              entrypoint,
              command: fullCommand,
              stdout:
                typeof execResult.output === 'string'
                  ? execResult.output
                  : JSON.stringify(execResult.output ?? null),
              error: execResult.error,
            };
          }

          // Sandbox surface: agentd first, Vercel Sandbox fallback.
          const { isAgentdAvailable } = await import(
            '@/lib/workflow/agent/dispatch'
          );
          const agentdReachable = await isAgentdAvailable();

          if (agentdReachable) {
            const {
              syncErrors,
              execResult,
              execError: agentdExecError,
            } = await materializeAndRunOnAgentd({
              sessionId,
              nodeId,
              allowedNodes,
              workspaceLockAcquired,
              skillName: name,
              entrypoint,
              runtime,
              fullCommand,
              execTimeoutSeconds: RUN_SKILL_EXEC_TIMEOUT_SECONDS,
            });
            if (syncErrors.length > 0) {
              return {
                ok: false as const,
                phase: 'sync' as const,
                surface: 'agentd' as const,
                runtime,
                entrypoint,
                errors: syncErrors,
              };
            }
            if (agentdExecError) {
              return {
                ok: false as const,
                phase: 'exec' as const,
                surface: 'agentd' as const,
                runtime,
                entrypoint,
                command: fullCommand,
                error: agentdExecError,
              };
            }
            // materializeAndRunOnAgentd guarantees execResult is
            // non-null when syncErrors and execError are both empty.
            if (!execResult) {
              return {
                ok: false as const,
                phase: 'exec' as const,
                surface: 'agentd' as const,
                runtime,
                entrypoint,
                command: fullCommand,
                error: 'agentd dispatch returned no result',
              };
            }
            const r = execResult;
            return {
              ok: r.success as boolean,
              phase: 'exec' as const,
              surface: 'agentd' as const,
              runtime,
              entrypoint,
              command: fullCommand,
              stdout: r.data,
              error: r.error,
              node: r.node,
            };
          }

          const { syncErrors, execResult, execError } =
            await materializeAndRunOnVercelSandbox({
              sessionId,
              skillName: name,
              entrypoint,
              runtime,
              fullCommand,
            });
          if (syncErrors.length > 0) {
            return {
              ok: false as const,
              phase: 'sync' as const,
              surface: 'vercel-sandbox' as const,
              runtime,
              entrypoint,
              errors: syncErrors,
            };
          }
          if (execError) {
            return {
              ok: false as const,
              phase: 'exec' as const,
              surface: 'vercel-sandbox' as const,
              runtime,
              entrypoint,
              command: fullCommand,
              error: execError,
            };
          }
          // materializeAndRunOnVercelSandbox guarantees execResult is
          // non-null when syncErrors and execError are both empty.
          if (!execResult) {
            return {
              ok: false as const,
              phase: 'exec' as const,
              surface: 'vercel-sandbox' as const,
              runtime,
              entrypoint,
              command: fullCommand,
              error: 'sandbox dispatch returned no result',
            };
          }
          const r = execResult;
          if (r.kind === 'running') {
            return {
              ok: false as const,
              phase: 'exec' as const,
              surface: 'vercel-sandbox' as const,
              runtime,
              entrypoint,
              command: fullCommand,
              error: r.message,
              cmdId: r.cmdId,
            };
          }
          return {
            ok: r.exitCode === 0,
            phase: 'exec' as const,
            surface: 'vercel-sandbox' as const,
            runtime,
            entrypoint,
            command: fullCommand,
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
          };
        },
      }),
    };
  },
});
