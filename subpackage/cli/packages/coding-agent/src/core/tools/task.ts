/**
 * task_progress / task_summary tools — CLI-side adapter for the Web's
 * task_summaries table. Lets the CLI agent loop maintain a shared todo
 * list with the IM/Web agent loop.
 */

import { getStoredAuth } from '@agentboster/adapter';
import {
  fetchTaskSummary,
  patchTaskSummary,
  type TaskSummary,
} from '@agentboster/adapter';
import { Text } from '@agentboster-cli/tui';
import { type Static, Type } from 'typebox';
import type { Theme } from '../../modes/interactive/theme/theme.ts';
import type { ToolDefinition } from '../extensions/types.ts';

// ============================================================================
// Schemas
// ============================================================================

const decisionSchema = Type.Object({
  description: Type.String({ description: 'What was decided' }),
  reason: Type.String({ description: 'Why it was decided' }),
  alternatives: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Other options considered',
    }),
  ),
});

const taskProgressSchema = Type.Object({
  progress: Type.Optional(
    Type.String({
      description: 'Free-text progress update (what just happened)',
    }),
  ),
  pending_add: Type.Optional(
    Type.Array(Type.String(), {
      description: 'New pending todo items to add',
    }),
  ),
  pending_done: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Pending items to mark done (matched by exact text)',
    }),
  ),
  known_issue_add: Type.Optional(
    Type.Array(Type.String(), {
      description: 'New known issues to track',
    }),
  ),
  known_issue_resolve: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Known issues to mark resolved (matched by exact text)',
    }),
  ),
  decision: Type.Optional(decisionSchema),
});

const taskSummaryReadSchema = Type.Object({});

export type TaskProgressInput = Static<typeof taskProgressSchema>;

// ============================================================================
// Result formatting
// ============================================================================

function formatSummaryText(summary: TaskSummary): string {
  const lines: string[] = [];
  if (summary.progress) lines.push(`Progress: ${summary.progress}`);
  if (summary.pending.length > 0) {
    lines.push(`Pending:`);
    for (const item of summary.pending) lines.push(`  - [ ] ${item}`);
  }
  if (summary.knownIssues.length > 0) {
    lines.push(`Known issues:`);
    for (const issue of summary.knownIssues) lines.push(`  - ! ${issue}`);
  }
  if (summary.decisions.length > 0) {
    lines.push(`Decisions:`);
    for (const d of summary.decisions) {
      lines.push(`  - ${d.description}: ${d.reason}`);
    }
  }
  return lines.join('\n');
}

function formatTaskResult(
  summary: TaskSummary | null,
  action: 'read' | 'update',
  theme: Theme,
): string {
  const title =
    action === 'read'
      ? theme.bold('task_summary')
      : theme.bold('task_progress');
  if (!summary) {
    return `${theme.fg('toolTitle', title)}\n${theme.fg('muted', '(no task summary yet)')}`;
  }
  const body = formatSummaryText(summary);
  return `${theme.fg('toolTitle', title)}\n${theme.fg('toolOutput', body)}`;
}

// ============================================================================
// Tool definitions
// ============================================================================

export interface TaskToolOptions {
  sessionId: string;
}

export function createTaskSummaryToolDefinition(
  options: TaskToolOptions,
): ToolDefinition<typeof taskSummaryReadSchema> {
  return {
    name: 'task_summary',
    label: 'task_summary',
    description:
      'Read the current task summary (todos, decisions, known issues, progress). ' +
      'Call this at the start of a session to see where you left off.',
    promptSnippet: 'Read task todos and progress',
    parameters: taskSummaryReadSchema,
    async execute(_toolCallId, _input, _signal) {
      const auth = getStoredAuth();
      if (!auth) {
        return {
          content: [{ type: 'text', text: '(not logged in)' }],
          details: undefined,
        };
      }
      const summary = await fetchTaskSummary(auth, options.sessionId);
      return {
        content: [
          {
            type: 'text',
            text: summary
              ? formatSummaryText(summary)
              : '(no task summary yet)',
          },
        ],
        details: { summary },
      };
    },
    renderResult(result, _opts, theme, context) {
      const details = result.details as { summary?: TaskSummary } | undefined;
      const text =
        (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);
      text.setText(formatTaskResult(details?.summary ?? null, 'read', theme));
      return text;
    },
  };
}

export function createTaskProgressToolDefinition(
  options: TaskToolOptions,
): ToolDefinition<typeof taskProgressSchema> {
  return {
    name: 'task_progress',
    label: 'task_progress',
    description:
      'Update the task summary when progress, decisions, pending items, or known issues change. ' +
      'Use pending_add/pending_done to maintain a todo list. ' +
      'Call this when you complete a milestone, hit a blocker, or make a significant decision.',
    promptSnippet: 'Update task todos, decisions, progress',
    parameters: taskProgressSchema,
    async execute(_toolCallId, input: TaskProgressInput, _signal) {
      const auth = getStoredAuth();
      if (!auth) {
        return {
          content: [{ type: 'text', text: '(not logged in)' }],
          details: undefined,
        };
      }
      const summary = await patchTaskSummary(auth, options.sessionId, {
        progress: input.progress,
        pendingAdd: input.pending_add,
        pendingDone: input.pending_done,
        knownIssueAdd: input.known_issue_add,
        knownIssueResolve: input.known_issue_resolve,
        decision: input.decision,
      });
      return {
        content: [
          {
            type: 'text',
            text: summary
              ? formatSummaryText(summary)
              : '(task summary unavailable)',
          },
        ],
        details: { summary },
      };
    },
    renderResult(result, _opts, theme, context) {
      const details = result.details as { summary?: TaskSummary } | undefined;
      const text =
        (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);
      text.setText(formatTaskResult(details?.summary ?? null, 'update', theme));
      return text;
    },
  };
}
