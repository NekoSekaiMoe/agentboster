/**
 * Models — stub. The real pi-ai Models class dispatched to provider
 * SDKs. This fork routes through /api/cli/cli via @agentboster/adapter.
 */

export type { Api, Model } from './types.ts';

export function clampThinkingLevel(..._args: unknown[]): unknown {
  return _args[0];
}
