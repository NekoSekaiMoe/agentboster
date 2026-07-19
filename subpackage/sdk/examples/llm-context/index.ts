/**
 * LLM context example extension.
 *
 * Demonstrates how to:
 *   1. Read the current session conversation (buildSessionContext)
 *   2. Resolve the active model's API key across runtime versions
 *      (resolveModelApiKey compatibility helper)
 *   3. Call a provider REST API directly with fetch — the agentboster
 *      CLI is a thin client, so extensions that need their own LLM call
 *      (advisors, linters, summarizers) must use fetch, not the host's
 *      internal `completeSimple`.
 *
 * The tool `summarize_conversation` returns a 1-paragraph summary of
 * everything said so far in the current session.
 */

import { Type } from 'typebox';
import {
  buildSessionContext,
  convertToLlm,
  resolveModelApiKey,
  type ExtensionAPI,
  type ExtensionContext,
} from '@agentboster/sdk';

const SUMMARY_PROMPT =
  'You summarize coding-assistant conversations. Read the conversation ' +
  'below and produce a single dense paragraph covering: what the user ' +
  'asked, what was tried, and the current outcome. Skip preamble.\n\n';

export default function summarize(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'summarize_conversation',
    label: 'Summarize',
    description:
      'Summarize the current session conversation in one paragraph. ' +
      'Useful for handoff, changelog drafting, or recap-before-compact.',
    promptSnippet: 'Summarize the conversation so far',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      // No model resolution possible outside a session — bail early.
      if (!ctx?.sessionManager || !ctx?.model) {
        return {
          content: [
            {
              type: 'text',
              text: 'No active session/model — cannot summarize.',
            },
          ],
        };
      }

      const apiKey = await resolveModelApiKey(ctx, ctx.model);
      if (!apiKey) {
        return {
          content: [
            {
              type: 'text',
              text: 'API key not configured for the active provider.',
            },
          ],
        };
      }

      // Build the canonical conversation representation the runtime
      // itself uses when calling providers. convertToLlm then turns
      // it into the OpenAI-style messages array most providers accept.
      const sessionContext = await buildSessionContext({
        sessionManager: ctx.sessionManager,
        sessionId: ctx.sessionManager.activeSessionId ?? '',
        compaction: ctx.compaction,
        cwd: ctx.cwd,
        model: ctx.model,
        isProjectTrusted: ctx.isProjectTrusted,
        signal,
      });
      const llmMessages = convertToLlm(sessionContext);

      // Prepend the summarization instruction. Real extensions might
      // also trim old messages, drop tool outputs, etc.
      const messages = [
        { role: 'system', content: SUMMARY_PROMPT },
        ...llmMessages.map((m) => ({
          role: m.role ?? 'user',
          content:
            typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content),
        })),
      ];

      // Most agentboster providers speak OpenAI Chat Completions. For
      // Anthropic-native endpoints you'd hit /v1/messages instead; this
      // example keeps the most common path.
      const endpoint =
        (ctx.model as { baseUrl?: string })?.baseUrl?.replace(/\/+$/, '') ??
        'https://api.openai.com/v1';
      const modelId = (ctx.model as { id?: string })?.id ?? 'gpt-4o-mini';

      const resp = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: modelId, messages, temperature: 0.2 }),
        signal,
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        return {
          content: [
            {
              type: 'text',
              text: `Summarize failed: ${resp.status} ${detail.slice(0, 200)}`,
            },
          ],
        };
      }

      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text =
        json.choices?.[0]?.message?.content?.trim() ??
        '(provider returned empty response)';

      return {
        content: [{ type: 'text', text }],
      };
    },
  });
}
