// Source: subpackage/cli/packages/desktop/src-tauri/src/lib.rs (AppSettings struct, lines 1203-1233; Default impl, lines 1235-1253)
//
// Centralized AppSettings type for the Desktop surface. The Rust
// `AppSettings` struct is the single source of truth for what the
// settings.json on disk can contain; this file mirrors it 1:1 so
// embedders, extension authors, and Tauri command callers share one
// typed contract.
//
// Wire format notes (see lib.rs:1202-1233):
// - The struct is `#[serde(default)]` as a whole, so every field is
//   optional on deserialize. We still mark fields non-optional here
//   because the Desktop backend always normalizes missing keys to the
//   `Default` impl's values before returning to the renderer. Callers
//   that write a partial settings object should merge with
//   `DEFAULT_APP_SETTINGS` first.
// - snake_case is preserved (serde default) to match the wire format
//   exactly; the renderer's reactive settings store reads these names
//   directly off the JSON payload.

// `QueueMode`, `ClientSpoof`, and `ThinkingLevel` are defined
// canonically in `./rpc.js` (mirrored from bridge.ts:8,10,23). They
// are NOT redefined here to avoid a duplicate-export conflict when
// `desktop/index.ts` re-exports both modules. The `import type` keeps
// them visible in this file's JSDoc hover / type-narrowing context.
import type { ClientSpoof, QueueMode, ThinkingLevel } from './rpc.js';

/** Theme preference (Desktop normalizes to 'dark' | 'light' | 'system'). */
export type ThemeMode = 'dark' | 'light' | 'system';

/** What happens when the user closes the main window. */
export type CloseAction = 'ask' | 'tray' | 'quit';

/** Screenshot format for computer-use-mcp. */
export type ScreenshotFormat = 'jpeg' | 'png';

/**
 * Persisted Desktop settings, written to:
 *   macOS:   ~/Library/Application Support/agentboster-desktop/settings.json
 *   Windows: %LOCALAPPDATA%\agentboster-desktop\settings.json
 *   Linux:   ~/.config/agentboster-desktop/settings.json
 *
 * Mirrors the Rust `AppSettings` struct 1:1 (snake_case, serde-default).
 *
 * String-typed fields are widened with `| string` so the type tolerates
 * forward-compat values the Rust side may add without forcing an SDK
 * rev. Consumers that want strict enums should narrow with a runtime
 * guard.
 */
export interface AppSettings {
  /** Rust `String`. Runtime-normalized; unknown values fall back to `'dark'`. */
  theme: ThemeMode | string;
  /** Rust `String`. Runtime-normalized; unknown values fall back to `'medium'`. */
  thinking_level: ThinkingLevel | string;
  /** Rust `bool`. */
  auto_compaction: boolean;
  /** Rust `bool`. */
  auto_retry: boolean;
  /** Rust `String`. Queue mode for steering input during a run. */
  steering_mode: QueueMode | string;
  /** Rust `String`. Queue mode for follow-up input after a run completes. */
  follow_up_mode: QueueMode | string;
  /** Rust `String`. Whether to spoof client identity to upstream providers. */
  client_spoof: ClientSpoof | string;
  /** Rust `Option<String>`. Manual override of the model provider id. */
  model_provider?: string | null;
  /** Rust `Option<String>`. Manual override of the model id. */
  model_id?: string | null;
  /** Rust `Option<String>`. Manual override of the pi binary path. */
  pi_path?: string | null;
  /**
   * Rust `String`. Behavior on main-window close:
   * `'ask' | 'tray' | 'quit'`. The Rust `CloseAction::from_settings`
   * (lib.rs:1264-1271) also accepts the aliases `'minimize'`/`'background'`
   * (→ tray) and `'exit'` (→ quit); only the canonical three are listed
   * here. Any other value resolves to `'ask'`.
   */
  close_action: CloseAction | string;
  /** Rust `String`. Default screenshot format (`'jpeg' | 'png'`). */
  screenshot_format: ScreenshotFormat | string;
  /** Rust `i64`. JPEG quality 1..=100. Ignored when `screenshot_format === 'png'`. */
  screenshot_quality: number;
}

/**
 * Defaults for `AppSettings` — mirrors the Rust `Default` impl at
 * lib.rs:1235-1253 verbatim. Use as the merge base when patching a
 * partial settings object before invoking `save_settings`.
 */
export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = {
  theme: 'dark',
  thinking_level: 'medium',
  auto_compaction: true,
  auto_retry: true,
  steering_mode: 'one-at-a-time',
  follow_up_mode: 'one-at-a-time',
  client_spoof: 'off',
  model_provider: null,
  model_id: null,
  pi_path: null,
  close_action: 'ask',
  screenshot_format: 'jpeg',
  screenshot_quality: 80,
};
