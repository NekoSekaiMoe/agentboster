/**
 * Helper to get the backend URL from stored auth.
 */

import { getStoredAuth } from '@agentboster/adapter';

export function getBackendUrl(): string {
  const auth = getStoredAuth();
  if (!auth) {
    throw new Error('Not authenticated. Run `agentboster-cli login` first.');
  }
  return auth.url;
}
