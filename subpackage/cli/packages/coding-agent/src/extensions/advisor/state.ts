/**
 * state — in-memory advisor settings for the current session.
 *
 * Seeded from the persisted config at extension init (index.ts) and mutated by
 * the /advisor command. Kept module-local so execute.ts can read the live
 * values without threading them through every call site.
 */

import type { AdvisorApi, AdvisorConfig } from './config.ts';

interface AdvisorState {
  provider: string | undefined;
  modelId: string | undefined;
  api: AdvisorApi | undefined;
  baseUrl: string | undefined;
  effort: string | undefined;
  apiKey: string | undefined;
}

const state: AdvisorState = {
  provider: undefined,
  modelId: undefined,
  api: undefined,
  baseUrl: undefined,
  effort: undefined,
  apiKey: undefined,
};

/** True when a model has been configured and the advisor tool should be active. */
export function isAdvisorConfigured(): boolean {
  return Boolean(state.modelId && state.api);
}

export function getAdvisorState(): Readonly<AdvisorState> {
  return state;
}

export function applyAdvisorConfig(config: AdvisorConfig): void {
  state.provider = config.provider;
  state.modelId = config.modelId;
  state.api = config.api;
  state.baseUrl = config.baseUrl;
  state.effort = config.effort;
  state.apiKey = config.apiKey;
}

export function clearAdvisorState(): void {
  state.provider = undefined;
  state.modelId = undefined;
  state.api = undefined;
  state.baseUrl = undefined;
  state.effort = undefined;
  state.apiKey = undefined;
}
