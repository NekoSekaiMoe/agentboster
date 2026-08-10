import { resolveLanguageModel } from '@/lib/ai';
import {
  getMemories,
  getTaskSummary,
  upsertTaskSummary,
  writeMemories,
} from '@/lib/core/db/agentd';
import { getConfig } from '@/lib/core/kv/config';
import { createLogger } from '@/lib/utils/logger';
import { generateText } from 'ai';

const logger = createLogger('task-memory');

// NOTE(M2.5): this module writes to the legacy `agent_memories` table (KV
// pairs keyed by agentId/sessionId). It is the ONLY remaining writer; the
// modern long_term_memories system has replaced it for chat/extract paths.
// Do NOT add new callers.
//
// TODO(tech-debt, separate epic): migrate to long_term_memories.workspace_id.
//   The current getMemories/writeMemories calls key only on (agentId,
//   taskId, sessionId) with NO workspace boundary, so the same agent reused
//   across two workspaces can read/overwrite each other's task memory. The
//   caller has task.workspaceId available (via getTask) but the legacy table
//   has no workspace_id column.
//
//   Until that migration lands, workspace-scoped tasks are REFUSED at the
//   extractTaskMemory boundary (see the workspaceId guard below) instead of
//   performing unscoped reads/writes. Non-workspace tasks keep the legacy
//   behavior.
//
//   This is a non-trivial migration. The agent_memories table was also
//   written by the agentd daemon via the /api/agentd/v1/memories webhook,
//   but that route now writes long_term_memories directly (see
//   app/api/agentd/v1/memories/route.ts), so this module is the only
//   remaining legacy writer. Full migration requires, in lockstep:
//     1. add workspace_id to agent_memories (schema) + data backfill
//     2. extend AgentdResourceScope + resolveResourceScope with workspaceId
//     3. thread task.workspaceId through extractTaskMemory → getMemories/
//        writeMemories
//     4. extend the daemon-side ToolExecRequest contract so the daemon
//        sends workspace_id on memory writes
//     5. update the SDK (subpackage/sdk regen)
//   The long_term_memories keyed upsert/delete paths (used by chat
//   extraction) DO honor workspaceId correctly after the
//   workspace-boundary fix.

type ExtractedFact = {
  key: string;
  value: string;
};

const MEMORY_EXTRACT_PROMPT = `You are a Personal Information Organizer. Given the completed task and result, extract key facts that should be remembered for future tasks.

Categories to extract only if present:
- Project Configuration: project structure, build tools, dependencies, environment setup
- Technical Decisions: chosen frameworks, libraries, patterns, and reasons
- File Paths & Artifacts: important file paths, generated outputs, modified files
- Errors & Solutions: errors encountered and how they were resolved
- User Preferences: coding style, naming conventions, workflow preferences
- Recurring Patterns: conventions, repeated commands, standard procedures
- Pending Items: TODOs, blocked tasks, follow-up actions mentioned

Rules:
- Do not extract greetings, pleasantries, or trivial exchanges.
- Do not extract general knowledge.
- Do not extract temporary context only relevant to the current session.
- Record all facts in English regardless of the task language.
- Return an empty array if no meaningful facts exist.
- Return JSON only.

Output format:
[
  {"key": "<category.short_name>", "value": "<fact description>"}
]`;

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function extractJsonArray(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) {
    throw new Error('LLM response did not contain a JSON array');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeFacts(value: unknown): ExtractedFact[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
    )
    .flatMap((item) => {
      if (typeof item.key !== 'string' || typeof item.value !== 'string') {
        return [];
      }

      const key = item.key.trim();
      const value = item.value.trim();
      return key && value ? [{ key, value }] : [];
    });
}

async function extractFacts(input: {
  command: string;
  result: string;
}): Promise<ExtractedFact[]> {
  if (input.result.trim().length === 0) {
    return [];
  }

  const config = await getConfig();
  const modelId = config.models?.model;
  if (!modelId) {
    throw new Error('Model is not configured');
  }

  const response = await generateText({
    model: resolveLanguageModel(modelId, config),
    system: MEMORY_EXTRACT_PROMPT,
    prompt: `Task:\n${input.command}\n\nResult:\n${truncate(input.result, 4000)}`,
    temperature: 0,
    maxOutputTokens: 1024,
  });

  return normalizeFacts(extractJsonArray(response.text));
}

function isDuplicateFact(
  fact: ExtractedFact,
  existing: Array<{ key: string; value: string }>,
) {
  return existing.some(
    (memory) =>
      memory.key === fact.key &&
      memory.value.trim().toLowerCase() === fact.value.trim().toLowerCase(),
  );
}

export async function extractTaskMemory(input: {
  taskId: string;
  agentId: string;
  sessionId?: string;
  /** Workspace the task belongs to (agent_tasks.workspace_id). When set,
   *  the legacy agent_memories path below is REFUSED — it keys only on
   *  (agentId, taskId, sessionId) and would leak/overwrite memory across
   *  workspaces sharing one agent. See the TODO at the top of this file. */
  workspaceId?: string | null;
  command: string;
  result: string;
  status: string;
}) {
  const summary = await getTaskSummary(input.taskId);

  if (summary) {
    const updated = await upsertTaskSummary({
      taskId: input.taskId,
      agentId: summary.agentId,
      sessionId: summary.sessionId ?? input.sessionId,
      status: input.status === 'completed' ? summary.status : 'paused',
      progress: `${input.status}: ${truncate(input.result, 200)}`,
      decisions: summary.decisions ?? undefined,
      pending: summary.pending ?? undefined,
      knownIssues: summary.knownIssues ?? undefined,
    });

    return {
      mode: 'task_summary' as const,
      summary: updated,
      facts: [],
      memories: [],
    };
  }

  if (input.workspaceId) {
    // Workspace-scoped task: the legacy agent_memories KV path has no
    // workspace boundary, so extracting here would read/overwrite another
    // workspace's task memory for the same agent. Refuse the path (the
    // task_summary branch above is keyed by taskId and stays safe).
    logger.info('extract:workspace_scope_skipped', {
      taskId: input.taskId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    });
    return {
      mode: 'workspace_scope_skipped' as const,
      facts: [],
      memories: [],
    };
  }

  const facts = await extractFacts({
    command: input.command,
    result: input.result,
  });
  if (facts.length === 0) {
    return { mode: 'memory' as const, facts, memories: [] };
  }

  const existing = await getMemories(input.agentId, [], 1000, {
    taskId: input.taskId,
    sessionId: input.sessionId,
  });
  const newFacts = facts.filter((fact) => !isDuplicateFact(fact, existing));
  const memories =
    newFacts.length > 0
      ? await writeMemories(
          newFacts.map((fact) => ({
            agentId: input.agentId,
            key: fact.key,
            value: fact.value,
            source: input.sessionId,
          })),
          { taskId: input.taskId, sessionId: input.sessionId },
        )
      : [];

  return {
    mode: 'memory' as const,
    facts,
    memories,
  };
}
