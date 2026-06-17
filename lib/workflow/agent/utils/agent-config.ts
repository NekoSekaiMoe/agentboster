import type { AppConfig } from '@/types/config';

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
