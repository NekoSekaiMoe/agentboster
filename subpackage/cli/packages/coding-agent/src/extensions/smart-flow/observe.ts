// Ported from pi-maestro-flow (MIT, Copyright (c) 2026 catlog22)
// Source: packages/pi-maestro-teammate/src/extension/index.ts (observe tool
// registration) + teammate-core.ts (OBSERVE_* constants) + schemas.ts
// (ObserveParams). Adapted: teammate provider references removed; smart-flow
// observes any provider registered via registerObservationProvider (bash_bg
// registers itself automatically).

import type { ExtensionAPI } from '../../core/extensions/index.ts';
import type { AgentToolResult } from '@agentboster-cli/agent';
import { Text } from '@agentboster-cli/tui';
import { Type } from 'typebox';
import {
  formatObserveResult,
  observeTargets,
  type ObserveParams as UnifiedObserveParams,
  type ObserveResult,
} from './observation.ts';
import {
  toolCallLine,
  toolResultLine,
  resultFirstLine,
} from './quiet-render.ts';

const OBSERVE_DESCRIPTION = `Observe background targets (e.g. bash_bg jobs) through one status/wait/watch interface.

- "status": one-shot snapshot of every target
- "wait": block on an all/any/count barrier with one request-level timeout; set until="completed" to block until targets fully terminate instead of first result
- "watch": poll every target until timeoutMs, returning the full status-transition timeline (richer than status, no barrier required)

Targets use { kind, id }, where kind identifies an observation provider ("bash_bg" is built in; other extensions may register additional kinds).`;

const OBSERVE_SNIPPET =
  'Observe, wait for, or watch background targets such as bash_bg jobs.';

const OBSERVE_GUIDELINES = [
  'Use observe for multi-target status and waits; use one bounded wait instead of polling status.',
  'Use action=watch to follow status transitions over time; use action=wait until=completed to block until targets fully terminate.',
  'Use detail=full only when recent output is required; summary is the compact default.',
];

const ObserveParams = Type.Object({
  action: Type.Unsafe<'status' | 'wait' | 'watch'>({
    type: 'string',
    enum: ['status', 'wait', 'watch'],
    description:
      '"status" takes a one-shot snapshot; "wait" blocks on a multi-target barrier; "watch" polls until timeoutMs and returns the full status-transition timeline.',
  }),
  targets: Type.Array(
    Type.Object(
      {
        kind: Type.String({
          minLength: 1,
          description: 'Observation provider kind, such as "bash_bg".',
        }),
        id: Type.String({
          minLength: 1,
          description: 'Provider-specific target name or id.',
        }),
      },
      { additionalProperties: false },
    ),
    {
      minItems: 1,
      maxItems: 15,
      description: 'Mixed targets to observe in the requested order.',
    },
  ),
  detail: Type.Optional(
    Type.Unsafe<'summary' | 'tail' | 'full'>({
      type: 'string',
      enum: ['summary', 'tail', 'full'],
      default: 'summary',
      description: 'Observation detail level.',
    }),
  ),
  lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      default: 20,
      description: 'Recent detail lines per target.',
    }),
  ),
  waitMode: Type.Optional(
    Type.Unsafe<'all' | 'any' | 'count'>({
      type: 'string',
      enum: ['all', 'any', 'count'],
      default: 'all',
      description: 'Barrier mode for wait.',
    }),
  ),
  waitCount: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 15,
      default: 1,
      description: 'Settled targets required when waitMode=count.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: 'Overall timeout in milliseconds (default 600000).',
    }),
  ),
  until: Type.Optional(
    Type.Unsafe<'result-ready' | 'completed'>({
      type: 'string',
      enum: ['result-ready', 'completed'],
      default: 'result-ready',
      description:
        'Wait boundary: "result-ready" settles at the first result; "completed" waits for terminal lifecycle.',
    }),
  ),
});

interface ObserveDetails {
  output: string[];
  result: ObserveResult;
}

export function registerObserve(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'observe',
    label: 'Observe',
    description: OBSERVE_DESCRIPTION,
    promptSnippet: OBSERVE_SNIPPET,
    promptGuidelines: OBSERVE_GUIDELINES,
    parameters: ObserveParams,
    async execute(
      _id: string,
      params: UnifiedObserveParams,
      signal: AbortSignal,
    ): Promise<AgentToolResult<ObserveDetails>> {
      const result = await observeTargets(params, signal);
      const output = formatObserveResult(result, params.detail === 'full');
      // NOTE: the failure reason (timeout/aborted/not-found) is stated in the
      // output text itself.
      return {
        content: [{ type: 'text', text: output.join('\n') }],
        details: { output, result },
      };
    },
    renderShell: 'self',
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text('', 0, 0);
      const action = String(args.action ?? 'status');
      const count = Array.isArray(args.targets) ? args.targets.length : 0;
      return toolCallLine(
        theme,
        'observe',
        `${action} ${count} target${count === 1 ? '' : 's'}`,
      );
    },
    renderResult(result, opts, theme) {
      if (opts.isPartial) return new Text('', 0, 0);
      const text =
        result.content[0] && 'text' in result.content[0]
          ? (result.content[0] as { text: string }).text
          : '';
      return toolResultLine(theme, {
        name: 'observe',
        ok: !text.match(/timeout|aborted|not-found/),
        summary: resultFirstLine(result),
        expanded: opts.expanded,
        detail: text,
      });
    },
  });
}
