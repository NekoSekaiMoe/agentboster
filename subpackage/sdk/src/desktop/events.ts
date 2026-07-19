// Source: subpackage/cli/packages/desktop/src-tauri/src/lib.rs (emit sites)
//        + subpackage/cli/packages/desktop/src/rpc/bridge.ts (listen sites)
//
// Tauri event payloads. These are the shapes that flow through
// `app.emit(name, payload)` on the Rust side and `listen(name, ...)`
// on the renderer side. The event names are the canonical strings
// referenced by both tiers; renaming one without the other breaks the
// wire contract silently (events just stop firing).
//
// Source emit sites:
//   - `cli-install-progress` → lib.rs:740 (install_progress_event_name())
//   - `rpc-event`            → lib.rs:1042 (RpcLineEventPayload)
//   - `rpc-closed`           → lib.rs:1047 (RpcClosedEventPayload)
//   - `rpc-stderr`           → lib.rs:1071 (RpcLineEventPayload)
//   - `close-requested`      → lib.rs:1835 (null payload)
//   - `tray-new-chat`        → lib.rs:1720 via emit_tray_event (null payload)
//   - `tray-show`            → tray menu id (renderer-side only, not emitted)

/** Source: lib.rs:487-493 (InstallProgressPayload). */
export interface CliInstallProgressPayload {
  stage: string;
  /** 0.0–1.0 progress within the current stage, when meaningful. */
  progress?: number;
  message?: string;
}

/**
 * Source: lib.rs:41-46 (RpcLineEventPayload).
 *
 * Wire-invariant note: bridge.ts:134-139 also tolerates a camelCase
 * `instanceId` alias because the Desktop renderer's `RpcBridge`
 * historically emitted both shapes; the Rust backend only emits
 * snake_case `instance_id`. SDK consumers can rely on `instance_id`.
 */
export interface RpcLineEventPayload {
  instance_id: string;
  generation: number;
  line: string;
}

/** Source: lib.rs:48-53 (RpcClosedEventPayload). */
export interface RpcClosedEventPayload {
  instance_id: string;
  generation: number;
  reason: string;
}

/**
 * Canonical event name → payload map for Tauri `listen<>()`.
 *
 * Source: lib.rs emit sites (see file header) + bridge.ts:697-749
 * (the renderer's `listen()` registrations).
 *
 * `null` payloads mean the event is signal-only (no data). Tauri's
 * `listen<T>()` still passes a `Event<T>` envelope; the SDK exposes
 * `null` here so consumers know not to read `event.payload`.
 */
export interface DesktopEventMap {
  'cli-install-progress': CliInstallProgressPayload;
  'rpc-event': RpcLineEventPayload;
  'rpc-closed': RpcClosedEventPayload;
  'rpc-stderr': RpcLineEventPayload;
  'close-requested': null;
  'tray-new-chat': null;
}

/**
 * Tray context-menu item ids — source: lib.rs:1698-1701 (with_id calls).
 *
 * These are the strings passed to `MenuItem::with_id(...)` and matched
 * by `handle_tray_menu_event` (lib.rs:1881-1893). The renderer also
 * uses them as event names for tray-driven UI actions
 * (`emit_tray_event` at lib.rs:1719-1721).
 */
export type TrayMenuItemId = 'tray-show' | 'tray-new-chat' | 'tray-quit';
