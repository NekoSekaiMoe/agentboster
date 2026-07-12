import { describe, expect, it } from 'vitest';
import {
  NODE_HEARTBEAT_TIMEOUT_MS,
  NODE_ZOMBIE_CUTOFF_MS,
  computeNodeStatus,
  heartbeatOnlineThreshold,
  isNodeHeartbeatFresh,
} from './node-liveness';

const NOW = new Date('2026-07-12T12:00:00Z');
const ms = (n: number) => new Date(NOW.getTime() + n);

describe('heartbeatOnlineThreshold', () => {
  it('returns a Date exactly NODE_HEARTBEAT_TIMEOUT_MS before now', () => {
    const t = heartbeatOnlineThreshold(NOW);
    expect(t.getTime()).toBe(NOW.getTime() - NODE_HEARTBEAT_TIMEOUT_MS);
  });
});

describe('isNodeHeartbeatFresh', () => {
  it('treats a heartbeat within the window as fresh', () => {
    expect(isNodeHeartbeatFresh(ms(-30_000), NOW)).toBe(true); // 30s ago
    expect(isNodeHeartbeatFresh(ms(-119_999), NOW)).toBe(true); // just under 2min
  });

  it('treats a heartbeat older than the window as stale', () => {
    expect(isNodeHeartbeatFresh(ms(-120_001), NOW)).toBe(false); // just over 2min
    expect(isNodeHeartbeatFresh(ms(-10 * 60_000), NOW)).toBe(false); // 10min ago
  });

  it('accepts an ISO string', () => {
    expect(isNodeHeartbeatFresh(ms(-60_000).toISOString(), NOW)).toBe(true);
  });

  it('treats null/missing/invalid heartbeat as stale', () => {
    expect(isNodeHeartbeatFresh(null, NOW)).toBe(false);
    expect(isNodeHeartbeatFresh(undefined, NOW)).toBe(false);
    expect(isNodeHeartbeatFresh('not-a-date', NOW)).toBe(false);
  });
});

describe('computeNodeStatus', () => {
  it('returns online when stored status is online and heartbeat is fresh', () => {
    expect(computeNodeStatus('online', ms(-30_000), NOW)).toBe('online');
  });

  it('returns offline when stored status is online but heartbeat is stale', () => {
    expect(computeNodeStatus('online', ms(-3 * 60_000), NOW)).toBe('offline');
  });

  it('returns offline when stored status is online but heartbeat is null', () => {
    // This is the new-register case: a row just inserted without a
    // heartbeat should not be shown as online until it has actually
    // heartbeated.
    expect(computeNodeStatus('online', null, NOW)).toBe('offline');
  });

  it('returns offline when stored status is offline (regardless of heartbeat)', () => {
    expect(computeNodeStatus('offline', ms(-1_000), NOW)).toBe('offline');
    expect(computeNodeStatus('offline', null, NOW)).toBe('offline');
  });

  it('returns offline for unknown stored status', () => {
    expect(computeNodeStatus('unknown', ms(-1_000), NOW)).toBe('offline');
  });
});

describe('constants', () => {
  it('NODE_HEARTBEAT_TIMEOUT_MS is 2 minutes (matches dispatch path)', () => {
    // dispatch.ts uses `2 * 60 * 1000` — keep these in sync.
    expect(NODE_HEARTBEAT_TIMEOUT_MS).toBe(2 * 60 * 1000);
  });

  it('NODE_ZOMBIE_CUTOFF_MS is at least 1 hour (sanity bound)', () => {
    expect(NODE_ZOMBIE_CUTOFF_MS).toBeGreaterThan(60 * 60 * 1000);
  });
});
