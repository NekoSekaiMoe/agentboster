// Source: subpackage/cli/packages/desktop/src/main.ts (lines 67-203)
//
// Workspace state contracts. These types are currently private to the
// Desktop renderer (declared as `interface` without `export` in
// main.ts). They are mirrored here as the public SDK surface so
// embedders / extension authors / external tooling that read the
// Desktop's `localStorage` workspace snapshot (key
// `pi-desktop.workspaces.v1`) can do so against a typed shape.
//
// Source-of-truth status: ASPIRATIONAL. main.ts is not currently
// exported; if it ever is, replace these copies with a re-export.
// Until then, drift is detected by scripts/regen-desktop.py (it
// diffs the interface bodies in main.ts against this file).
//
// Why ASPIRATIONAL rather than making main.ts export these now:
// main.ts is a ~6,300-line renderer entry point. Promoting its
// private interfaces to public exports would force every internal
// helper type it references into the Desktop package's public
// surface, which is a separate (much larger) refactor. The current
// ASPIRATIONAL mirror + drift detector is the lowest-risk way to
// give SDK consumers a typed shape today — the detector catches
// shape changes; the ASPIRATIONAL marker reminds reviewers that
// the source-of-truth move is still pending.

/** Source: components/sidebar.ts:12 (SidebarMode). */
export type SidebarMode = 'projects' | 'files';

/**
 * Source: main.ts:67-77 (WorkspaceSessionTab).
 *
 * One tab in the chat session rail. Each tab owns its own RPC bridge
 * instance on the renderer; the SDK does not surface the bridge handle
 * here (it's a runtime object, not a data contract).
 */
export interface WorkspaceSessionTab {
  id: string;
  projectId: string | null;
  projectPath: string | null;
  sessionPath: string | null;
  title: string;
  messageCount: number | null;
  ephemeral: boolean;
  needsAttention: boolean;
  attentionMessage: string | null;
}

/** Source: main.ts:79-87 (WorkspaceFileTab). */
export interface WorkspaceFileTab {
  id: string;
  projectId: string | null;
  projectPath: string | null;
  path: string | null;
  title: string;
  draftDirectoryPath: string | null;
  draftAnchorPath: string | null;
}

/**
 * Literal union of panes a workspace can show.
 * Source: main.ts:96-103 (inline union on `WorkspaceState.pane`).
 */
export type Pane =
  | 'chat'
  | 'file'
  | 'packages'
  | 'settings'
  | 'terminal'
  | 'agentd-vnc'
  | 'schedule';

/**
 * Source: main.ts:89-114 (WorkspaceState).
 *
 * Persisted to `localStorage` under `pi-desktop.workspaces.v1` as a
 * plain JSON object. The renderer keeps an array of these.
 */
export interface WorkspaceState {
  id: string;
  title: string;
  color: string | null;
  emoji: string | null;
  pinned: boolean;
  leftMode: SidebarMode;
  pane: Pane;
  activeProjectId: string | null;
  activeProjectPath: string | null;
  filePath: string | null;
  terminalOpen: boolean;
  terminalActive: boolean;
  sessionTitle: string;
  sessionTabs: WorkspaceSessionTab[];
  activeSessionTabId: string | null;
  fileTabs: WorkspaceFileTab[];
  activeFileTabId: string | null;
}

/**
 * Runtime phase of a single chat session tab.
 * Source: main.ts:133-139 (inline union on `SessionRuntime.phase`).
 */
export type SessionRuntimePhase =
  | 'idle'
  | 'starting'
  | 'switching_session'
  | 'creating_session'
  | 'ready'
  | 'failed';

/**
 * Source: main.ts:116-142 (SessionRuntime).
 *
 * IMPORTANT: this is the SDK-safe shape — `bridge: RpcBridge` and
 * `eventUnlisten: (() => void) | null` are runtime object references
 * and are intentionally omitted (TODO: when main.ts exports
 * SessionRuntime, decide whether to re-export `RpcBridge` as a type
 * alias and put it back, or keep this SDK shape as data-only).
 */
export interface SessionRuntime {
  key: string;
  instanceId: string;
  // TODO: original field is `bridge: RpcBridge` — runtime instance
  // reference, omitted from the SDK data contract.
  workspaceId: string;
  tabId: string;
  projectPath: string;
  lastKnownSessionPath: string | null;
  /**
   * Web-side CLI session id assigned the first time this runtime
   * connects. Reused across reconnects so the Web backend's
   * `cli-remote:<sessionId>` KV entry stays stable for the lifetime
   * of this Desktop session tab, letting `computer-use-remote`
   * redispatch after a CLI restart.
   */
  webCliSessionId: string | null;
  running: boolean;
  draftInitialized: boolean;
  phase: SessionRuntimePhase;
  lastError: string | null;
  // TODO: original field is `eventUnlisten: (() => void) | null` —
  // runtime function reference, omitted from the SDK data contract.
}

/**
 * Source: main.ts:198-203 (CliInstallState).
 *
 * Renderer-side view of the CLI install progress; populated from
 * `cli-install-progress` events emitted by `install_cli`
 * (lib.rs:752-808).
 */
export interface CliInstallState {
  stage: string;
  progress: number | null;
  message: string | null;
  error: string | null;
}
