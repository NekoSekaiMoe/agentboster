/**
 * extra-cmd — /context command
 *
 * Registers a `/context` command that shows the current context-window usage
 * together with a per-category token composition breakdown (system prompt,
 * user messages, assistant text, thinking, tool calls, tool results, ...).
 *
 * The headline number comes from `ctx.getContextUsage()` — the same value the
 * footer shows, derived from the last assistant response's real token usage.
 * The composition breakdown is a chars/4 estimate applied to the messages
 * `buildSessionContext()` would send to the LLM, so it mirrors what actually
 * occupies the context window, including compaction and branch summaries.
 *
 * The report is persisted as a custom session entry (`pi.appendEntry`), which
 * does NOT participate in LLM context, and rendered in the TUI via
 * `pi.registerEntryRenderer`.
 */

import { Box, Text } from '@agentboster-cli/tui';
import { estimateTokens } from '../../core/compaction/index.ts';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '../../core/extensions/index.ts';

const ENTRY_TYPE = 'extra-cmd:context';

interface ContextCategory {
  label: string;
  tokens: number;
}

interface ContextReport {
  /** Real context tokens from the last assistant usage; null right after compaction. */
  measuredTokens: number | null;
  contextWindow: number;
  /** Measured usage as a percentage of the context window; null when unknown. */
  percent: number | null;
  /** Estimated tokens for the system prompt (chars/4). */
  systemPromptTokens: number;
  /** Estimated tokens per message category, sorted descending. */
  categories: ContextCategory[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function collectReport(ctx: ExtensionCommandContext): ContextReport {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

  const systemPromptTokens = Math.ceil(ctx.getSystemPrompt().length / 4);

  const buckets = new Map<string, number>();
  const add = (label: string, tokens: number) => {
    if (tokens > 0) {
      buckets.set(label, (buckets.get(label) ?? 0) + tokens);
    }
  };

  // Replay exactly what the next LLM call would carry, then bucket per role.
  const { messages } = ctx.sessionManager.buildSessionContext();
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        add('User messages', estimateTokens(message));
        break;
      case 'assistant': {
        // Split assistant messages so thinking and tool calls are visible.
        let text = 0;
        let thinking = 0;
        let toolCalls = 0;
        for (const block of message.content) {
          if (block.type === 'text') {
            text += block.text.length;
          } else if (block.type === 'thinking') {
            thinking += block.thinking.length;
          } else if (block.type === 'toolCall') {
            toolCalls +=
              block.name.length + JSON.stringify(block.arguments).length;
          }
        }
        add('Assistant text', Math.ceil(text / 4));
        add('Thinking', Math.ceil(thinking / 4));
        add('Tool calls', Math.ceil(toolCalls / 4));
        break;
      }
      case 'toolResult':
        add('Tool results', estimateTokens(message));
        break;
      case 'bashExecution':
        add('Bash executions', estimateTokens(message));
        break;
      case 'branchSummary':
      case 'compactionSummary':
        add('Summaries', estimateTokens(message));
        break;
      case 'custom':
        add('Extension messages', estimateTokens(message));
        break;
      default:
        add('Other', estimateTokens(message));
        break;
    }
  }

  const categories = [...buckets.entries()]
    .map(([label, tokens]) => ({ label, tokens }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    measuredTokens: usage?.tokens ?? null,
    contextWindow,
    percent: usage?.percent ?? null,
    systemPromptTokens,
    categories,
  };
}

export function registerContextCommand(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<ContextReport>(
    ENTRY_TYPE,
    (entry, _options, theme) => {
      const data = entry.data;
      if (!data) return undefined;

      const box = new Box(1, 1, (t) => theme.bg('customMessageBg', t));

      const measured =
        data.measuredTokens !== null ? formatTokens(data.measuredTokens) : '?';
      const window =
        data.contextWindow > 0 ? formatTokens(data.contextWindow) : '?';
      const percent =
        data.percent !== null ? `${data.percent.toFixed(1)}%` : '?';
      box.addChild(
        new Text(
          `${theme.fg('accent', '[context]')} ${measured} / ${window} tokens (${percent})`,
          0,
          0,
        ),
      );

      const estimated =
        data.systemPromptTokens +
        data.categories.reduce((sum, c) => sum + c.tokens, 0);
      box.addChild(
        new Text(
          theme.fg(
            'dim',
            data.measuredTokens !== null
              ? `composition is a chars/4 estimate (~${formatTokens(estimated)} tokens total)`
              : `no measured usage yet (post-compaction) — showing chars/4 estimate (~${formatTokens(estimated)} tokens)`,
          ),
          0,
          0,
        ),
      );

      const rows: ContextCategory[] = [
        { label: 'System prompt', tokens: data.systemPromptTokens },
        ...data.categories,
      ];
      const labelWidth = Math.max(...rows.map((r) => r.label.length));
      const barWidth = 16;
      for (const row of rows) {
        if (row.tokens <= 0) continue;
        const share = estimated > 0 ? row.tokens / estimated : 0;
        const filled = Math.max(1, Math.round(share * barWidth));
        const bar =
          theme.fg('accent', '█'.repeat(filled)) +
          theme.fg('dim', '░'.repeat(barWidth - filled));
        const label = row.label.padEnd(labelWidth);
        const tokens = formatTokens(row.tokens).padStart(7);
        const pct = `${(share * 100).toFixed(1)}%`.padStart(6);
        box.addChild(
          new Text(`  ${label} ${theme.fg('dim', tokens)} ${bar} ${pct}`, 0, 0),
        );
      }

      return box;
    },
  );

  pi.registerCommand('context', {
    description: 'Show context window usage and per-category composition',
    handler: async (_args, ctx) => {
      const report = collectReport(ctx);
      // Custom entries render in the TUI but never enter LLM context.
      pi.appendEntry<ContextReport>(ENTRY_TYPE, report);
      if (ctx.mode !== 'tui' && ctx.hasUI) {
        const measured =
          report.measuredTokens !== null
            ? formatTokens(report.measuredTokens)
            : '?';
        const percent =
          report.percent !== null ? `${report.percent.toFixed(1)}%` : '?';
        ctx.ui.notify(
          `Context: ${measured} / ${formatTokens(report.contextWindow)} tokens (${percent})`,
          'info',
        );
      }
    },
  });
}
