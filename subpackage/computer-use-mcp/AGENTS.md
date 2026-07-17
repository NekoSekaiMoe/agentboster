# AGENTS.md — computer-use-mcp/

Compact guide for AI coding sessions working in the `computer-use-mcp/` package. Cross-platform MCP server for computer use (screenshots, input, accessibility), consumed by the AgentBoster CLI desktop app.

## Read first

- `computer-use-mcp/README.md` is the best map for architecture, MCP tools, and platform support.
- The `core/` crate has **no I/O side effects** — all JSON-RPC handling and process lifecycle live in `server/src/main.rs`.
- This is a Cargo workspace with two members: `core` (library) and `server` (binary).

## Module

Rust Cargo workspace (edition 2024). Not part of the root yarn workspace, the agentd Go module, or the CLI npm monorepo. Run all commands from this directory.

## Toolchain

| Tool | Purpose |
|------|---------| 
| Rust (stable, edition 2024) | build + test |
| xcap | cross-platform screen capture |
| enigo | cross-platform input simulation |
| atspi + zbus (Linux) | AT-SPI2 accessibility |
| accessibility-sys (macOS) | AX API accessibility |
| uiautomation (Windows) | UIAutomation accessibility |

## Commands

```bash
cargo build                       # debug build (both crates)
cargo build --release             # release binary
cargo test                        # all tests
cargo test -p computer-use-core   # core crate only
cargo test -p computer-use-mcp-server  # server crate only
cargo clippy                      # lint
```

The binary is `target/{debug,release}/computer-use-mcp`.

## Crate layout

| File | What it does |
|------|-------------|
| `core/src/capability.rs` | Platform detection: display server, resolution, scale factor, accessibility permission, admin status |
| `core/src/screenshot.rs` | Screen capture via xcap, Lanczos3 downscaling, terminal window masking, base64 PNG encoding |
| `core/src/input.rs` | Input controller (enigo): mouse move/click/drag, key events, key combos, text typing. Also `get_foreground_window_id()` |
| `core/src/accessibility.rs` | Unified `AxNode` type + per-platform backends (macOS AX API, Windows UIAutomation, Linux AT-SPI2) |
| `core/src/safety.rs` | Terminal window ID detection (macOS CGWindowList, Windows EnumWindows, Linux stub). `EscapeHook` global key listener |
| `core/src/coord.rs` | `CoordMapper`: bidirectional conversion between screenshot-scaled and native screen coordinates |
| `core/src/lock.rs` | `ComputerUseLock`: exclusive session lock file with stale-PID reclamation and cross-app (CLI/desktop) conflict detection |
| `server/src/main.rs` | MCP server: JSON-RPC 2.0 over stdio, `initialize`/`tools/list`/`tools/call` dispatch |

## MCP protocol

- JSON-RPC 2.0 over newline-delimited stdio
- Protocol version: `2024-11-05`
- Notifications (no `id`) are silently ignored
- Tools are conditionally exposed based on detected capabilities

## Non-obvious constraints

- **Coordinates are screenshot-relative**: input tools use the scale factor and monitor origin from the last `screenshot` call to map back to native pixels. If no screenshot was taken, falls back to detected display scale.
- **Terminal safety default**: `allow_terminal_edit` defaults to `false`. Screenshots mask terminals; input operations are rejected when a terminal is in the foreground (macOS/Windows). Set to `true` in `initialize` params to override.
- **Linux terminal masking is a crude fallback**: no reliable API to identify terminal windows, so the bottom 1/3 of the screen is masked. macOS/Windows mask per-window.
- **Linux foreground window detection returns `None`**: `get_foreground_window_id()` is unimplemented on Linux, so the "reject input when terminal is foreground" safety check is skipped.
- **Session lock is cross-app**: lock checks both `~/.config/agentboster-cli/` and `~/.config/agentboster-desktop/` to prevent CLI and desktop app from using computer-use simultaneously.
- **`computer-use-core` differs from `dbushelper`**: this crate uses the Rust `atspi` crate for Linux a11y; `dbushelper` (sibling Go package) uses raw godbus calls and runs inside the agentd LXC sandbox. They serve different products.

## Testing

- `core/src/coord.rs` has unit tests for coordinate mapping roundtrips.
- `core/src/lock.rs` has unit tests for lock acquire/release, double-acquire prevention, and stale lock reclamation.
- Screenshot and input tests require a display server and are not run in CI.
- Accessibility tests require platform-specific permissions (macOS: Accessibility, Linux: AT-SPI2 bus).

## Gotchas

- `EscapeHook` spawns a background thread with `rdev::listen` that blocks until error — the thread cannot be cleanly joined. The hook is meant to live for the process lifetime.
- `mask_terminal_windows` on macOS/Windows uses `unsafe` FFI to the platform windowing API. Changes here should be tested on the target platform.
- The server flushes stdout after every response (`stdout.lock().flush()`). Missing a flush would stall the MCP client.
- `detect_resolution()` uses the first monitor from `xcap::Monitor::all()` — on multi-monitor setups the primary may not be index 0.
