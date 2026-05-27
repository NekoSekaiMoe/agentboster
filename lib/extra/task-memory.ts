import { resolveLanguageModel } from '@/lib/ai';
import {
  getMemories,
  getTaskSummary,
  upsertTaskSummary,
  writeMemories,
} from '@/lib/core/db/agentd';
import { getConfig } from '@/lib/core/kv/config';
import { generateText } from 'ai';

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

  const facts = await extractFacts({
    command: input.command,
    result: input.result,
  });
  if (facts.length === 0) {
    return { mode: 'memory' as const, facts, memories: [] };
  }

  const existing = await getMemories(input.agentId, [], 1000);
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
        )
      : [];

  return {
    mode: 'memory' as const,
    facts,
    memories,
  };
}
