import type { AppConfig } from '@/types/config';
import type { ToolCatalogResponse } from '@/types/config/tools';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { createLogger } from '@/lib/utils/logger';
import { MAIN_AGENT_NAME } from '../utils/agent-config';
import type { BuildAgentToolsOptions, BuildInToolDefinition } from './define';
import { getMCPTools } from './mcp';
import {
  isValidToolName,
  sanitizeToolName,
  suggestClosestName,
} from './tool-name-guard';
export {
  defineBuildInTool,
  type BuildAgentToolsOptions,
  type BuildInToolDefinition,
} from './define';

import agentdNodesTool from './agentd/nodes';
import browserTool from './execute/browser';
import desktopTool from './execute/desktop';
import sandboxTool from './execute/sanbox';
import localCliTool from './local';
import memoryTool from './memories/local';
import askQuestionTool from './questions/ask-question';
import localSkillTool from './skills/local';
import barrierTool from './tasks/barrier';
import handoffTool from './tasks/handoff';
import scheduleTool from './tasks/schedule';
import subAgentTool from './tasks/sub-agent';
import taskSummaryTool from './tasks/summary';
import sequentialThinkingTool from './reasoning/sequential-thinking';

const BUILT_IN_TOOLS: BuildInToolDefinition[] = [
  sandboxTool,
  browserTool,
  desktopTool,
  memoryTool,
  localSkillTool,
  scheduleTool,
  taskSummaryTool,
  subAgentTool,
  agentdNodesTool,
  localCliTool,
  askQuestionTool,
  sequentialThinkingTool,
  barrierTool,
  handoffTool,
];

export function getBuildInToolCatalog(config: AppConfig): ToolCatalogResponse {
  return {
    tools: BUILT_IN_TOOLS.map((definition) => definition.toCatalogItem(config)),
  };
}

export async function buildAgentTools(
  config: AppConfig,
  sessionId: string,
  options: BuildAgentToolsOptions = {},
): Promise<ToolSet> {
  const tools: ToolSet = {};
  const runId = options.runId ?? sessionId;
  const agentName = options.agentName ?? MAIN_AGENT_NAME;
  const allowDelegation = options.allowDelegation ?? true;
  const writable = options.writable;
  const userId = options.userId;
  const source = options.source;
  const buildNestedTools = (nestedOptions: BuildAgentToolsOptions = {}) =>
    buildAgentTools(config, sessionId, {
      runId,
      agentName,
      allowDelegation,
      writable,
      userId,
      source,
      ...nestedOptions,
    });

  for (const definition of BUILT_IN_TOOLS) {
    const registeredTools = await definition.register(config, {
      sessionId,
      runId,
      appConfig: config,
      agentName,
      allowDelegation,
      writable,
      userId,
      source,
      buildNestedTools,
    });

    if (!registeredTools) {
      continue;
    }

    Object.assign(tools, registeredTools);
  }

  const mcpTools = await getMCPTools(
    config.mcp,
    'MCP',
    {
      sessionId,
      agentName,
    },
    config,
  );
  const mergedTools: ToolSet = {
    ...tools,
    ...mcpTools,
  };

  // Plan mode: drop every state-mutating tool, keeping only read-only /
  // observe / reason tools so the model can investigate and propose a
  // plan without touching anything. Mirrors pi's plan-mode extension
  // semantics ("read-only planning, propose plan, then act").
  //
  // agentboster runs tools in two execution planes (the Web workflow is
  // the single tool registry for both):
  //   - agentd sandbox: docker/lxc/browser/desktop — remote execution
  //   - CLI host local_*: the user's own filesystem and shell
  //
  // Plan mode uses an ALLOWLIST because agentd/browser expose too many
  // tools to maintain a stable blocklist, and MCP tools (web_search,
  // fetch_url, etc.) are read-side research aids that should stay
  // available. Anything not on the allowlist is dropped; the model
  // therefore cannot mutate, execute, click, type, or write anywhere.
  const logger = createLogger('workflow.agent.tools');
  if (options.planMode) {
    const PLAN_MODE_ALLOWED = new Set<string>([
      // Reasoning scratchpad (no IO).
      'sequential_thinking',
      // Read-only local filesystem access (CLI host).
      'local_read_file',
      // Read-only sandbox tools (agentd).
      'readFile',
      // Read-only browser observers (agentd Playwright).
      'browser_get_text',
      'browser_get_html',
      'browser_screenshot',
      'browser_list_profiles',
      'browser_tab_list',
      'browser_inspect',
      // Memory read (write/delete blocked).
      'readMemory',
      // Let the model ask the user for clarification or to surface its
      // proposed plan for approval. ask_question blocks until the user
      // answers, so it is the natural plan-approval channel.
      'ask_question',
      // Task summary read (already read-only) helps the model see what
      // it has already committed to in earlier runs.
      'task_summary',
    ]);
    // MCP tools are external research aids (web_search, fetch_url, ...).
    // They were merged into mergedTools above; tag them as allowed unless
    // individually blocked. Heuristic: anything containing "search" or
    // "fetch" or "read" or "get" is research-y; everything else from MCP
    // is dropped to be safe.
    const mcpKeys = new Set(Object.keys(mcpTools));
    for (const key of Object.keys(mergedTools)) {
      if (PLAN_MODE_ALLOWED.has(key)) continue;
      if (mcpKeys.has(key) && /search|fetch|read|get|list|query/i.test(key)) {
        continue;
      }
      delete mergedTools[key];
    }
    logger.info('tools:plan_mode_filtered', {
      kept: Object.keys(mergedTools).length,
    });
  }

  // Last-mile guard: drop any tool whose key fails provider tool-name
  // validation. Without this filter, a single bad key (e.g. an MCP server
  // exposing a tool whose name starts with a digit or contains non-ASCII
  // chars) causes Gemini to reject the ENTIRE tools array with
  // `function_declarations[N].name: Invalid function name`, taking down
  // the whole workflow run.
  const dropped: string[] = [];
  for (const key of Object.keys(mergedTools)) {
    if (!isValidToolName(key)) {
      delete mergedTools[key];
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    logger.warn('tools:dropped_invalid_names', {
      count: dropped.length,
      // Avoid logging the full list — keys could be empty strings or
      // contain noise. Truncate each to 40 chars for log readability.
      names: dropped.map((n) =>
        n.length > 40 ? `${n.slice(0, 37)}...` : n.length === 0 ? '<empty>' : n,
      ),
    });
  }

  // Wrap the merged toolset in a resilient Proxy that synthesizes a
  // fallback tool for any unknown key. DurableAgent's executeTool
  // hard-throws `Tool "X" not found` on unknown names and that throw is
  // NOT caught by experimental_repairToolCall — the Proxy ensures
  // `tools[anything]` is always truthy so the throw is never reached.
  // See createResilientToolSet for the full rationale and the fallback
  // resolution strategy (alias → edit-distance → structured error).
  return createResilientToolSet(mergedTools, logger);
}

/**
 * Wrap a ToolSet in a Proxy that catches unknown tool-name lookups.
 *
 * Background: DurableAgent's executeTool (in @workflow/ai) does
 *   const tool = tools[toolCall.toolName];
 *   if (!tool) throw new Error(`Tool "${toolCall.toolName}" not found`);
 * and this throw is NOT caught by `experimental_repairToolCall` (which
 * only fires on schema-validation failure) nor by `onError` (which is a
 * log-only hook followed by an immediate re-throw). The throw kills the
 * entire workflow run.
 *
 * The Proxy intercepts `tools[toolCall.toolName]` reads. For real tool
 * names it returns the actual tool. For any other key — including the
 * empty string, snake_case hallucinations (`write_memory`), or fully
 * unknown names (`do_thing`) — it returns a fallback tool whose
 * `execute`:
 *   1. resolves the requested name via `sanitizeToolName` (alias map)
 *      and, if a canonical real tool exists, forwards the call to it;
 *   2. otherwise tries `suggestClosestName` (edit distance ≤ 2) and, if
 *      a close real tool exists, forwards the call to it — silently
 *      recovering single-character typos and casing mistakes;
 *   3. otherwise returns a structured error listing the available tools
 *      so the model can self-correct on the next turn.
 *
 * Crucially, the Proxy is invisible to provider serialization:
 *   - `Object.keys` / `Object.entries` / `getOwnPropertyNames` only
 *     enumerate the real tools (via ownKeys + getOwnPropertyDescriptor
 *     traps), so the model's tools list stays clean — no Gemini
 *     rejection, no alias clutter;
 *   - the `get` trap refuses to synthesize fallbacks for non-string
 *     keys, well-known Symbol keys, and `then` (so the Proxy is not
 *     accidentally treated as a thenable by Promise resolution);
 *   - the fallback tool is memoized per requested name so repeated
 *     calls reuse the same closure.
 *
 * Unlike the previous trap-based approach (which pre-registered ~30
 * alias keys in the ToolSet), this mechanism catches an UNBOUNDED set
 * of hallucinated names with zero noise in the model-visible tools list,
 * and works uniformly across all providers (OpenAI, OpenAI-compatible,
 * Anthropic, Google).
 */
export function createResilientToolSet(
  realTools: ToolSet,
  logger: ReturnType<typeof createLogger>,
): ToolSet {
  const knownNames = Object.keys(realTools);
  const knownSet = new Set(knownNames);

  // Cache of synthesized fallback tools keyed by the requested name.
  // The closure captures `requestedName` so the fallback knows which
  // alias / closest-match to resolve against — `tool.execute`'s second
  // argument does NOT include the tool name, so this is the only path
  // to recover it.
  const fallbackCache = new Map<string, ToolSet[string]>();

  const buildFallback = (requestedName: string): ToolSet[string] => {
    const cached = fallbackCache.get(requestedName);
    if (cached) {
      return cached;
    }

    const fallback = tool({
      description:
        'Internal fallback. Do not call directly — invoked automatically when the model emits a malformed or unknown tool name.',
      inputSchema: z.record(z.string(), z.unknown()),
      execute: async (input, options) => {
        const toolCallId = options?.toolCallId ?? '<unknown>';
        logger.warn('fallback:invoked', {
          requestedName: requestedName.length === 0 ? '<empty>' : requestedName,
          toolCallId,
        });

        // 1) Alias resolution (snake_case / kebab-case / casing).
        const aliased = sanitizeToolName(requestedName, knownSet);
        if (aliased && aliased.reason !== 'exact') {
          const canonical = realTools[aliased.name];
          if (canonical && typeof canonical.execute === 'function') {
            try {
              const result = await canonical.execute(input, options);
              logger.info('fallback:forwarded', {
                from: requestedName,
                to: aliased.name,
                reason: aliased.reason,
                toolCallId,
              });
              return result;
            } catch (forwardError) {
              logger.error('fallback:forward_failed', {
                from: requestedName,
                to: aliased.name,
                toolCallId,
                error:
                  forwardError instanceof Error
                    ? forwardError.message
                    : String(forwardError),
              });
              return {
                ok: false,
                error: `Forwarded call to "${aliased.name}" failed: ${
                  forwardError instanceof Error
                    ? forwardError.message
                    : String(forwardError)
                }`,
              };
            }
          }
        }

        // 2) Edit-distance fallback (≤ 2). Catches single-char typos
        //    and casing mistakes for names not covered by the alias
        //    table. Must reject the suggestion if it equals the
        //    requested name (would otherwise cause infinite recursion
        //    via the Proxy for unknown names that happen to look close
        //    to themselves — e.g. an empty string).
        const closest = suggestClosestName(requestedName, knownSet);
        if (closest && closest !== requestedName) {
          const canonical = realTools[closest];
          if (canonical && typeof canonical.execute === 'function') {
            try {
              const result = await canonical.execute(input, options);
              logger.info('fallback:forwarded', {
                from: requestedName,
                to: closest,
                reason: 'edit-distance',
                toolCallId,
              });
              return result;
            } catch (forwardError) {
              logger.error('fallback:forward_failed', {
                from: requestedName,
                to: closest,
                toolCallId,
                error:
                  forwardError instanceof Error
                    ? forwardError.message
                    : String(forwardError),
              });
              return {
                ok: false,
                error: `Forwarded call to "${closest}" failed: ${
                  forwardError instanceof Error
                    ? forwardError.message
                    : String(forwardError)
                }`,
              };
            }
          }
        }

        // 3) Structured error. DurableAgent wraps this in a
        //    tool-result and returns it to the model, which can then
        //    retry with a valid name on the next turn.
        return {
          ok: false,
          error:
            requestedName.length === 0
              ? 'Tool name was empty. The model emitted a tool_call without a function name.'
              : `Tool name "${requestedName}" is not a valid tool.`,
          suggestion: closest,
          availableTools: knownNames,
          hint: 'Please retry the action using one of the available tool names listed in "availableTools".',
        };
      },
    });

    fallbackCache.set(requestedName, fallback);
    return fallback;
  };

  return new Proxy(realTools, {
    // Read trap: real tools pass through; unknown string keys get a
    // synthesized fallback; everything else (Symbols, `then`, prototype
    // methods) returns the underlying value verbatim to avoid
    // breaking Reflect / Promise resolution / instanceof checks.
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (value !== undefined) {
        return value;
      }
      if (typeof key !== 'string') {
        return undefined;
      }
      // Never synthesize a fallback for `then` — otherwise the Proxy
      // is treated as a thenable and gets silently awaited by Promise
      // resolution machinery, corrupting control flow.
      if (key === 'then') {
        return undefined;
      }
      return buildFallback(key);
    },

    // Enumeration traps: ensure Object.keys / Object.entries /
    // getOwnPropertyNames on the Proxy surface ONLY the real tools.
    // This is what keeps the model-visible tools list clean and
    // prevents Gemini / OpenAI / Anthropic from ever seeing a
    // synthesized fallback name in the function_declarations array.
    // The default Proxy behavior already forwards these to the target,
    // but declaring them explicitly documents the invariant and locks
    // it in against future Proxy spec drift.
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    has(target, key) {
      // DurableAgent / ai SDK occasionally use `key in tools` to gate
      // behavior. Unknown string keys report as present so the lookup
      // path falls through to `get` and hits the fallback.
      if (typeof key === 'string' && key !== 'then') {
        return true;
      }
      return Reflect.has(target, key);
    },
  });
}
