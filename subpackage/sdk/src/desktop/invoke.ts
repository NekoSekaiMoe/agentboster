// Source: subpackage/cli/packages/desktop/src-tauri/src/lib.rs (tauri::generate_handler! list, lines 1841-1858)
//
// Typed Tauri invoke contracts for every command the Desktop backend
// registers. Each `XxxArgs` interface mirrors the command's Rust
// parameter list (minus `app: AppHandle` / `state: tauri::State<...>`,
// which are injected by Tauri and never passed by the caller), and
// each `XxxResult` mirrors the `Result<T, String>` success payload.
//
// Wire-shape rules (see SDK root AGENTS.md → "Rust → TS port"):
//   - `Option<T>` arg → `T | null | undefined` (Tauri serializes missing
//     keys as `null` on the JS side, and the Rust `Option` deserializer
//     accepts both `null` and absent keys).
//   - `Option<T>` field inside a struct → `T | null`.
//   - snake_case is preserved for command-level args (Tauri's default
//     `tauri::command` rename), EXCEPT for `RpcStartOptions` where the
//     bridge translates camelCase→snake_case before invoking. We expose
//     the wire shape here (snake_case) for direct invoke callers.
//   - `Result<T, String>` → `Promise<T>`; the `Err(String)` arm
//     surfaces as a rejected promise with the string as `message`.

import type { AppSettings } from './settings.js';
import type { PiCliCommandResult } from './rpc.js';

// ---------------------------------------------------------------------------
// rpc_start — lib.rs:947-1082
// ---------------------------------------------------------------------------

/**
 * Wire shape of `RpcStartOptions` as it crosses the Tauri boundary.
 * Source: lib.rs:99-117 (snake_case Rust struct) + bridge.ts:328-340
 * (renderer→wire translation).
 *
 * This is NOT the same as `RpcStartOptions` in `rpc.ts` (camelCase,
 * renderer-facing). Use this when calling `invokeTyped('rpc_start', ...)`
 * directly.
 */
export interface RpcStartWireOptions {
  cli_path: string | null;
  pi_path: string | null;
  cwd: string;
  provider: string | null;
  model: string | null;
  env: Record<string, string> | null;
  session_id: string | null;
  backend_url: string | null;
}

export interface RpcStartArgs {
  options: RpcStartWireOptions;
  /** Source: lib.rs:952 (Option<String>, normalized to "default" when null). */
  instanceId?: string;
}

/** Source: lib.rs:55-59 (RpcStartResult). */
export interface RpcStartResult {
  discovery: string;
  generation: number;
}

// ---------------------------------------------------------------------------
// rpc_send — lib.rs:1085-1111
// ---------------------------------------------------------------------------

export interface RpcSendArgs {
  /** JSON-stringified RPC command (see bridge.ts:862-872). */
  command: string;
  instanceId?: string;
}
export type RpcSendResult = void;

// ---------------------------------------------------------------------------
// rpc_stop — lib.rs:1114-1128
// ---------------------------------------------------------------------------

export interface RpcStopArgs {
  instanceId?: string;
}
export type RpcStopResult = void;

// ---------------------------------------------------------------------------
// rpc_stop_all — lib.rs:1131-1141
// ---------------------------------------------------------------------------

export type RpcStopAllArgs = {};
export type RpcStopAllResult = void;

// ---------------------------------------------------------------------------
// rpc_is_running — lib.rs:1144-1171
// ---------------------------------------------------------------------------

export interface RpcIsRunningArgs {
  instanceId?: string;
}
export type RpcIsRunningResult = boolean;

// ---------------------------------------------------------------------------
// rpc_ui_response — lib.rs:1174-1200
// ---------------------------------------------------------------------------

export interface RpcUiResponseArgs {
  /** JSON-stringified extension UI response (see bridge.ts:587-590). */
  response: string;
  instanceId?: string;
}
export type RpcUiResponseResult = void;

// ---------------------------------------------------------------------------
// install_cli — lib.rs:752-808
// ---------------------------------------------------------------------------

export type InstallCliArgs = {};
/** Source: lib.rs:495-501 (InstallResult). */
export interface InstallCliResult {
  /** Absolute path to the installed `agentboster-cli` entry script. */
  bin_path: string;
  /** Release tag the installer pulled (e.g. "v0.1.5"). */
  version: string;
}

// ---------------------------------------------------------------------------
// save_settings — lib.rs:1408-1426
// ---------------------------------------------------------------------------

export interface SaveSettingsArgs {
  settings: AppSettings;
}
export type SaveSettingsResult = void;

// ---------------------------------------------------------------------------
// load_settings — lib.rs:1429-1459
// ---------------------------------------------------------------------------

export type LoadSettingsArgs = {};
export type LoadSettingsResult = AppSettings;

// ---------------------------------------------------------------------------
// open_file_dialog — lib.rs:1462-1466
// ---------------------------------------------------------------------------

export interface OpenFileDialogArgs {
  multiple: boolean;
}
export type OpenFileDialogResult = string[];

// ---------------------------------------------------------------------------
// run_pi_cli_command — lib.rs:1536-1577
// ---------------------------------------------------------------------------

/**
 * Wire shape of `PiCliCommandOptions`. Source: lib.rs:1468-1475.
 */
export interface PiCliCommandWireOptions {
  args: string[];
  cwd: string | null;
  env: Record<string, string> | null;
  cli_path: string | null;
  pi_path: string | null;
}

export interface RunPiCliCommandArgs {
  options: PiCliCommandWireOptions;
}
export type RunPiCliCommandResult = PiCliCommandResult;

// ---------------------------------------------------------------------------
// get_desktop_runtime_info — lib.rs:1579-1586
// ---------------------------------------------------------------------------

export type GetDesktopRuntimeInfoArgs = {};
/** Source: lib.rs:1485-1490 (DesktopRuntimeInfo). */
export interface GetDesktopRuntimeInfoResult {
  platform: string;
  arch: string;
  version: string;
}

// ---------------------------------------------------------------------------
// open_path_in_default_app — lib.rs:1588-1690
// ---------------------------------------------------------------------------

export interface OpenPathInDefaultAppArgs {
  path: string;
}
export type OpenPathInDefaultAppResult = void;

// ---------------------------------------------------------------------------
// resolve_close_action — lib.rs:1922-1956
// ---------------------------------------------------------------------------

export interface ResolveCloseActionArgs {
  /**
   * Source: lib.rs:1919-1921 comment. Canonical values are
   * `'tray' | 'quit' | 'ask'`, but the dialog also emits `'ask-tray'`
   * (hide this once, don't persist) and `'ask-quit'` (quit this once,
   * don't persist). `CloseAction::from_settings` (lib.rs:1264-1271)
   * resolves all five variants.
   */
  action: string;
  /** Whether to persist the choice to settings.json. */
  remember: boolean;
}
export type ResolveCloseActionResult = void;

// ---------------------------------------------------------------------------
// set_close_action — lib.rs:1959-1964
// ---------------------------------------------------------------------------

export interface SetCloseActionArgs {
  action: string;
}
export type SetCloseActionResult = void;

// ---------------------------------------------------------------------------
// show_main_window_cmd — lib.rs:1968-1972
// ---------------------------------------------------------------------------

export type ShowMainWindowCmdArgs = {};
export type ShowMainWindowCmdResult = void;

// ---------------------------------------------------------------------------
// Aggregate map
// ---------------------------------------------------------------------------

/**
 * Command-name → { args, result } map. Every key is a string passed to
 * Tauri's `invoke()` (matching `tauri::generate_handler!` at
 * lib.rs:1841-1858). Source of truth: scripts/regen-desktop.py diffs
 * this map's keys against the Rust handler list.
 */
export interface DesktopInvokeMap {
  install_cli: { args: InstallCliArgs; result: InstallCliResult };
  rpc_start: { args: RpcStartArgs; result: RpcStartResult };
  rpc_send: { args: RpcSendArgs; result: RpcSendResult };
  rpc_stop: { args: RpcStopArgs; result: RpcStopResult };
  rpc_stop_all: { args: RpcStopAllArgs; result: RpcStopAllResult };
  rpc_is_running: { args: RpcIsRunningArgs; result: RpcIsRunningResult };
  rpc_ui_response: { args: RpcUiResponseArgs; result: RpcUiResponseResult };
  save_settings: { args: SaveSettingsArgs; result: SaveSettingsResult };
  load_settings: { args: LoadSettingsArgs; result: LoadSettingsResult };
  open_file_dialog: {
    args: OpenFileDialogArgs;
    result: OpenFileDialogResult;
  };
  run_pi_cli_command: {
    args: RunPiCliCommandArgs;
    result: RunPiCliCommandResult;
  };
  get_desktop_runtime_info: {
    args: GetDesktopRuntimeInfoArgs;
    result: GetDesktopRuntimeInfoResult;
  };
  open_path_in_default_app: {
    args: OpenPathInDefaultAppArgs;
    result: OpenPathInDefaultAppResult;
  };
  resolve_close_action: {
    args: ResolveCloseActionArgs;
    result: ResolveCloseActionResult;
  };
  set_close_action: { args: SetCloseActionArgs; result: SetCloseActionResult };
  show_main_window_cmd: {
    args: ShowMainWindowCmdArgs;
    result: ShowMainWindowCmdResult;
  };
}

/**
 * Minimal invoke function shape — matches `@tauri-apps/api/core`'s
 * `invoke` so this SDK does not need to depend on `@tauri-apps/api`.
 * Inject the real `invoke` at the call site (see `makeTypedInvoke`).
 */
export type InvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Wrap a raw Tauri `invoke` function with full type information.
 *
 * @example
 * ```ts
 * import { invoke } from '@tauri-apps/api/core';
 * import { makeTypedInvoke } from '@agentboster/sdk/desktop';
 *
 * const invokeTyped = makeTypedInvoke(invoke);
 * const { discovery } = await invokeTyped('rpc_start', {
 *   options: { cli_path: null, pi_path: null, cwd: '/repo', ... },
 * });
 * ```
 */
export function makeTypedInvoke(
  invoke: InvokeFn,
): <K extends keyof DesktopInvokeMap>(
  cmd: K,
  args: DesktopInvokeMap[K]['args'],
) => Promise<DesktopInvokeMap[K]['result']> {
  return function invokeTyped<K extends keyof DesktopInvokeMap>(
    cmd: K,
    args: DesktopInvokeMap[K]['args'],
  ): Promise<DesktopInvokeMap[K]['result']> {
    return invoke(cmd, args as unknown as Record<string, unknown>) as Promise<
      DesktopInvokeMap[K]['result']
    >;
  };
}
