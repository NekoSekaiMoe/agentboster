import type { AppConfig } from '@/types/config';
import {
  resolveModelContextLimit,
  resolveModelMaxOutputTokens,
} from './model-context';

export const MAIN_AGENT_NAME = 'main';

/**
 * Minimal shape we need from a user record to resolve model overrides.
 * Accepts StoredUser, null, or any partial — `null`/`undefined` skips the
 * per-user override cleanly (caller has no resolved user identity, e.g.
 * scheduled / anonymous-web chat).
 */
type UserLike =
  | { modelPreferences?: { model?: string } | null }
  | null
  | undefined;

/**
 * Resolve the model id for the main agent, honoring the caller's per-user
 * override when present. Used by chat runs and memory extraction (paths
 * that have an owning user). Background tasks (task-summary, task-memory,
 * compress, L1 scorer) deliberately use {@link getMainAgentModelId} which
 * only reads the global config.
 */
export function resolveMainAgentModelId(
  config: AppConfig,
  user: UserLike,
): string {
  const override = user?.modelPreferences?.model;
  if (override) {
    return override;
  }
  return getMainAgentModelId(config);
}

/**
 * Global-only main agent model id. Throws if neither per-user override nor
 * global default is set. Used by background tasks that have no owning user.
 */
export function getMainAgentModelId(config: AppConfig): string {
  const modelId = config.models?.model;
  if (!modelId) {
    throw new Error('No model configured for the main agent.');
  }

  return modelId;
}

export function getMainAgentTemperature(config: AppConfig): number | undefined {
  return config.models?.temperature;
}

/**
 * Global-only sub-agent model id. Sub-agents are internal helpers spawned
 * by the main agent and do NOT inherit the calling user's per-user
 * preference — they always fall back to the agent-specific override (if
 * configured) or the global default.
 */
export function getAgentModelId(config: AppConfig, agentName: string): string {
  const modelId = config.agents?.[agentName]?.model ?? config.models?.model;
  if (!modelId) {
    throw new Error(`No model configured for agent "${agentName}".`);
  }
  return modelId;
}

export function getAgentTemperature(
  config: AppConfig,
  agentName: string,
): number | undefined {
  return config.agents?.[agentName]?.temperature ?? config.models?.temperature;
}

export function getDelegatableAgentNames(
  config: AppConfig,
  currentAgentName: string,
): string[] {
  return Object.keys(config.agents ?? {}).filter(
    (agentName) => agentName !== currentAgentName,
  );
}

/**
 * Resolved model parameters for the main agent, honoring per-model overrides
 * from `config.models.model_catalog` when the resolved model id has an entry.
 *
 * Resolution order for each field:
 *  - `modelId`: per-user preference → global default (see {@link resolveMainAgentModelId}).
 *  - `temperature`: catalog override → `config.models.temperature`.
 *  - `contextLimit`: catalog override → `config.models.context_limit` →
 *    built-in per-model table (see {@link resolveModelContextLimit}).
 *  - `outputLimit`: catalog override → `config.models.max_output_tokens` →
 *    built-in per-model heuristics (see {@link resolveModelMaxOutputTokens}).
 *
 * Background tasks (task-summary, task-memory, compress, L1 scorer) deliberately
 * keep using {@link getMainAgentModelId} + the global fields directly — they
 * have no owning user and no per-message model pick, so catalog overrides
 * don't apply to them.
 */
export function resolveMainAgentModelParams(
  config: AppConfig,
  user: UserLike,
): {
  modelId: string;
  temperature: number | undefined;
  contextLimit: number;
  outputLimit: number;
} {
  const modelId = resolveMainAgentModelId(config, user);
  const catalogEntry = config.models?.model_catalog?.[modelId];

  const temperature = catalogEntry?.temperature ?? config.models?.temperature;
  const contextLimit = resolveModelContextLimit(
    modelId,
    catalogEntry?.context_limit ?? config.models?.context_limit,
  );
  const outputLimit = resolveModelMaxOutputTokens(
    modelId,
    catalogEntry?.max_output_tokens ?? config.models?.max_output_tokens,
  );

  return { modelId, temperature, contextLimit, outputLimit };
}
