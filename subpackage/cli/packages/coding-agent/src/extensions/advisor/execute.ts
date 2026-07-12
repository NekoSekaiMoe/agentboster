/**
 * execute — the advisor side-call.
 *
 * Assembles the executor's current LLM context (via buildSessionContext +
 * convertToLlm), prepends a tool-inventory system note, and makes ONE
 * non-streaming completion against the configured provider. The advisor never
 * calls tools and never streams — it returns a single block of guidance text.
 *
 * Unlike @juicesharp/rpiv-advisor (which uses pi-ai's completeSimple), this
 * fork's completeSimple throws — the CLI is a thin client and routes normal
 * turns through the web backend. So the advisor talks to the provider API
 * directly over fetch(), using its own persisted key material.
 */

import { convertToLlm } from '../../core/messages.ts';
import { buildSessionContext } from '../../core/session-manager.ts';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from '../../core/extensions/index.ts';
import { type AdvisorConfig, defaultBaseUrl, resolveApiKey } from './config.ts';
import { ADVISOR_SYSTEM_PROMPT } from './prompt.ts';

export interface AdvisorDetails {
  advisorModel?: string;
  effort?: string;
  errorMessage?: string;
}

/** Minimal LLM message shape shared by both wire protocols. */
interface LlmTextMessage {
  role: 'user' | 'assistant';
  text: string;
}

function textResult(
  text: string,
  details: AdvisorDetails,
): AgentToolResult<AdvisorDetails> {
  return { content: [{ type: 'text', text }], details };
}

/**
 * Flatten the executor's AgentMessage context into simple role+text turns.
 *
 * The advisor only needs to read what happened; it does not need structured
 * tool-call blocks. Tool results are folded into user turns and assistant
 * tool calls are rendered as readable text so a plain chat-completions API can
 * consume the transcript without provider-specific tool schemas.
 */
function flattenContext(ctx: ExtensionContext): LlmTextMessage[] {
  const { messages } = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  const llm = convertToLlm(messages);
  const out: LlmTextMessage[] = [];

  for (const msg of llm) {
    if (msg.role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
              .join('\n');
      if (text.trim()) out.push({ role: 'user', text });
    } else if (msg.role === 'assistant') {
      const parts: string[] = [];
      for (const c of msg.content) {
        if (c.type === 'text') parts.push(c.text);
        else if (c.type === 'toolCall')
          parts.push(`[tool call: ${c.name}(${JSON.stringify(c.arguments)})]`);
      }
      const text = parts.join('\n');
      if (text.trim()) out.push({ role: 'assistant', text });
    } else if (msg.role === 'toolResult') {
      const text = msg.content
        .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
        .join('\n');
      out.push({
        role: 'user',
        text: `[tool result: ${msg.toolName}${msg.isError ? ' (error)' : ''}]\n${text}`,
      });
    }
  }

  return out;
}

/** Anthropic Messages API — one-shot, no tools, no streaming. */
async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  turns: LlmTextMessage[],
  effort: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const root = baseUrl.replace(/\/$/, '');
  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: 8192,
    system: ADVISOR_SYSTEM_PROMPT,
    messages: turns.map((t) => ({
      role: t.role,
      content: [{ type: 'text', text: t.text }],
    })),
  };
  if (effort && effort !== 'off') {
    const budget =
      effort === 'low'
        ? 4000
        : effort === 'medium'
          ? 10000
          : effort === 'xhigh'
            ? 32000
            : 16000;
    body.thinking = { type: 'enabled', budget_tokens: budget };
    // Anthropic requires max_tokens > thinking budget.
    body.max_tokens = budget + 4096;
  }

  const resp = await fetch(`${root}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Anthropic API ${resp.status}: ${detail.slice(0, 500)}`);
  }
  const json = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (json.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/** OpenAI Chat Completions API — one-shot, no tools, no streaming. */
async function callOpenAI(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  turns: LlmTextMessage[],
  effort: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const root = baseUrl.replace(/\/$/, '');
  const body: Record<string, unknown> = {
    model: modelId,
    messages: [
      { role: 'system', content: ADVISOR_SYSTEM_PROMPT },
      ...turns.map((t) => ({ role: t.role, content: t.text })),
    ],
  };
  if (effort && effort !== 'off') {
    // Reasoning models accept reasoning_effort: low|medium|high.
    body.reasoning_effort =
      effort === 'xhigh' || effort === 'minimal' ? 'high' : effort;
  }

  const resp = await fetch(`${root}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`OpenAI API ${resp.status}: ${detail.slice(0, 500)}`);
  }
  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (json.choices?.[0]?.message?.content ?? '').trim();
}

export async function executeAdvisor(
  ctx: ExtensionContext,
  config: AdvisorConfig,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
  const label = config.modelId
    ? `${config.provider ?? 'advisor'}:${config.modelId}`
    : 'advisor';
  const details: AdvisorDetails = {
    advisorModel: label,
    effort: config.effort,
  };

  if (!config.modelId || !config.api) {
    return textResult(
      'Advisor is not configured. Run `/advisor` to pick a model, or set advisor.json.',
      { ...details, errorMessage: 'not configured' },
    );
  }

  const apiKey = resolveApiKey(config.apiKey);
  if (!apiKey) {
    return textResult(
      `Advisor has no API key. Set "apiKey" in advisor.json (a literal value or "$ENV_VAR").`,
      { ...details, errorMessage: 'no api key' },
    );
  }

  const baseUrl = config.baseUrl ?? defaultBaseUrl(config.api);
  const turns = flattenContext(ctx);

  onUpdate?.({
    content: [
      {
        type: 'text',
        text: `Consulting advisor (${label}${config.effort ? `, ${config.effort}` : ''})…`,
      },
    ],
    details,
  });

  try {
    const text =
      config.api === 'anthropic-messages'
        ? await callAnthropic(
            baseUrl,
            apiKey,
            config.modelId,
            turns,
            config.effort,
            signal,
          )
        : await callOpenAI(
            baseUrl,
            apiKey,
            config.modelId,
            turns,
            config.effort,
            signal,
          );

    if (!text) {
      return textResult('Advisor returned an empty response.', {
        ...details,
        errorMessage: 'empty response',
      });
    }
    return textResult(text, details);
  } catch (err) {
    if (signal?.aborted) {
      return textResult('Advisor call was aborted.', {
        ...details,
        errorMessage: 'aborted',
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return textResult(`Advisor call failed: ${message}`, {
      ...details,
      errorMessage: message,
    });
  }
}
