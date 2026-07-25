/**
 * Remote orchestration plan API client for the Agentboster web backend.
 *
 * This module is a thin CLI-side wrapper. The fetch logic lives in
 * @agentboster/adapter (shared with Desktop); here we only add the
 * `listMyRemotePlans` convenience that reads the device's stored auth.
 */

import { getStoredAuth } from '@agentboster/adapter';

// Re-export everything from the shared adapter module so existing imports
// from '../core/remote-orchestration.ts' keep working unchanged.
export {
  addRemotePlanItem,
  archiveRemotePlan,
  createRemotePlan,
  getRemotePlan,
  listRemotePlans,
  patchRemotePlan,
  patchRemotePlanItem,
  removeRemotePlanItem,
  submitRemotePlan,
  type RemotePlan,
  type RemotePlanItem,
} from '@agentboster/adapter';

import { listRemotePlans as listRemotePlansImpl } from '@agentboster/adapter';

/**
 * Convenience: list plans for the current device's CLI session.
 * Returns [] when not logged in.
 */
export async function listMyRemotePlans(
  sessionId: string,
): Promise<import('@agentboster/adapter').RemotePlan[]> {
  const auth = getStoredAuth();
  if (!auth) return [];
  return listRemotePlansImpl(auth, sessionId);
}
