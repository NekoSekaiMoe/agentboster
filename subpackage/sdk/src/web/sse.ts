// Web HTTP API — SSE event schemas.
//
// Source of truth: /app/api/cli/session-events/[sessionId]/route.ts
// (heartbeat is emitted inline; tool-request / lock-acquired /
// lock-released are pushed via `pushToCliSession` from
// /lib/cli/remote-control.ts and /lib/workflow/agent/tools/execute/computer-use.ts).
//
// The route formats each event as:
//   `event: <type>\ndata: <json>\n\n`
// Consumers parse the `event:` line to pick the matching branch of
// the `CliSessionEvent` discriminated union below; the `data:` line
// is the union member minus its `type` field (the `type` here is the
// discriminator SDK consumers should switch on after merging the two).

export type CliSessionEventType =
  | 'heartbeat'
  | 'tool-request'
  | 'lock-acquired'
  | 'lock-released';

export interface CliSessionHeartbeatEvent {
  type: 'heartbeat';
  timestamp: number;
}

export interface CliSessionToolRequestEvent {
  type: 'tool-request';
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}

export interface CliSessionLockEvent {
  type: 'lock-acquired' | 'lock-released';
  sessionId: string;
}

export type CliSessionEvent =
  | CliSessionHeartbeatEvent
  | CliSessionToolRequestEvent
  | CliSessionLockEvent;
