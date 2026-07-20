# computer-use-mcp

Go implementation of the MCP server for computer use (screenshots, input, accessibility). Cross-platform alternative to the Rust version.

- **Module:** `github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp`
- **Go version:** 1.25.5+
- **Standalone Go module** — independent from the root yarn workspace and from `subpackage/agentd/` / `subpackage/dbushelper/`.

## Features

✅ **Screenshot capture** with Lanczos3 scaling and coordinate mapping
✅ **Cross-platform input simulation** (mouse, keyboard) via purego (zero CGo for input)
✅ **Terminal window masking** for safety, with configurable safety level
✅ **Session lock** with zombie process cleanup
✅ **Escape hook** for emergency stop
✅ **Platform capability detection**
✅ **Accessibility tree API** (optional, full recursive traversal on all platforms — purego, no CGo)
✅ **Clipboard read/write** (text + PNG image, via `golang.design/x/clipboard` — native Wayland + X11 wire protocol, macOS Pasteboard, Win32 user32, all CGo-free)
✅ **Screen recording → animated GIF** (pure stdlib `image/gif`, no ffmpeg)

## Architecture

```
cmd/server/          MCP JSON-RPC server (stdio)
pkg/
  capability/        Platform detection (display server, resolution, permissions)
  screenshot/        Screen capture + scaling + masking
  input/             Mouse/keyboard simulation (purego)
  coord/             Coordinate mapping (screenshot ↔ native)
  lock/              Session lock with PID tracking
  escape/            Global escape key listener
  safety/            Terminal safety policy (level, allow_terminal_edit, whitelists, /proc scanning)
  accessibility/     Accessibility tree (optional, purego on all platforms)
  clipboard/         Clipboard read/write adapter (wraps golang.design/x/clipboard)
  recorder/          GIF screen recording (stdlib image/gif, reuses pkg/screenshot)
```

## Build

### Quick start (no accessibility)

```bash
go build -o computer-use-mcp ./cmd/server
```

Binary: ~9MB, zero CGo dependencies for core features.

### With accessibility support

Accessibility is implemented with **purego** (no CGo) on every platform — it loads the platform a11y library at runtime via `purego.Dlopen`:

| Platform | Library | Requirement |
|----------|---------|-------------|
| Linux    | `libatspi.so.0` (via glib/gobject) | `libatspi2.0-dev` runtime libs, AT-SPI2 bus running |
| macOS    | `ApplicationServices` + `CoreFoundation` | Accessibility permission in System Settings |
| Windows  | `uiautomationcore.dll` + `oleaut32.dll` | None (ships with Windows) |

```bash
# Linux — install runtime libs, then build normally
sudo apt-get install libatspi2.0-dev
go build -o computer-use-mcp ./cmd/server

# macOS — grant Accessibility permission, then build
go build -o computer-use-mcp ./cmd/server

# Windows — no extra setup
go build -o computer-use-mcp ./cmd/server
```

On any platform that lacks the a11y libraries, the build still succeeds — the accessibility tool calls return a clear "backend unavailable" error at runtime, and all core features (screenshot, input, lock, escape) keep working.

## Test

```bash
# All tests
go test ./... -v

# With coverage
go test ./... -cover

# Specific package
go test ./pkg/screenshot -v
```

**Note:** Tests requiring a display server (screenshot, input) skip gracefully in headless/CI environments.

## Usage

```bash
# Start MCP server
./computer-use-mcp

# Example: Take screenshot
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"screenshot","arguments":{}}}' | ./computer-use-mcp

# Example: Move mouse
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mouse_move","arguments":{"x":100,"y":100}}}' | ./computer-use-mcp
```

## MCP Tools

### Core tools

| Tool | Description |
|------|-------------|
| `screenshot` | Capture screen with optional scaling |
| `mouse_move` | Move cursor to coordinates |
| `mouse_click` | Click mouse button |
| `mouse_drag` | Drag from start to end |
| `type_text` | Type text string |
| `key_event` | Press/release/click key |
| `capabilities` | Get platform capabilities |

### Accessibility tools (optional)

Returned only when the platform a11y backend initializes successfully.

| Tool | Description |
|------|-------------|
| `get_accessibility_tree` | Full recursive accessibility tree from the root (depth-limited) |
| `get_focused_element` | The currently focused element |
| `get_element_at_position` | Element at a screen coordinate |
| `perform_accessibility_action` | Invoke an action (click, focus, ...) on a node by ID |

### Clipboard tools

| Tool | Description |
|------|-------------|
| `clipboard_read` | Read the system clipboard as UTF-8 text or a base64 PNG image (`format`: `text` \| `image`, default `text`) |
| `clipboard_write` | Write to the clipboard — `text` (UTF-8) **or** `image_base64` (PNG recommended; JPEG/GIF/WebP auto-normalized to PNG) |

**Linux backend:** the upstream `golang.design/x/clipboard` v0.8 speaks the Wayland wire protocol natively — it dials `$WAYLAND_DISPLAY`, implements `wl_registry`/`wl_seat`/data-control (preferring the standardized `ext_data_control_manager_v1`, falling back to `zwlr_data_control_manager_v1`), and passes file descriptors via `SCM_RIGHTS`. X11 is spoken directly too (no libX11.so at runtime). macOS uses Pasteboard, Windows uses `user32` (OpenClipboard/GetClipboardData). All CGo-free on desktop; no `wl-paste`/`wl-copy`/`xclip` subprocesses required.

### Screen recording tools

| Tool | Description |
|------|-------------|
| `screen_record_start` | Begin capturing the screen as an animated GIF. Returns immediately; pair with `screen_record_stop`. Args: `duration_seconds` (default 15, cap 60), `fps` (default 4, cap 10), `max_width` (default 800), `monitor_index`, `exclude_terminals` (default true) |
| `screen_record_stop` | Stop the recording and return the encoded GIF as base64 (`image/gif`). Errors if no recording is active or zero frames were captured |

**Format choice:** GIF is encoded entirely with the Go standard library (`image/gif`) — no ffmpeg, no external codec, no CGo. Trade-off: 256-color per-frame palette (photographic banding), no audio. For UI-automation replay fed into a vision model this is the right shape: the bytes go straight into the context window, where a binary video codec would be useless anyway. Each frame is captured via `pkg/screenshot.CaptureDisplay` and quantized to the plan9 palette for speed.

## Cross-compilation

```bash
# Linux → macOS
GOOS=darwin GOARCH=amd64 go build ./cmd/server

# Linux → Windows
GOOS=windows GOARCH=amd64 go build ./cmd/server

# macOS → Linux
GOOS=linux GOARCH=amd64 go build ./cmd/server
```

Because accessibility is purego (no CGo), it cross-compiles with the rest of the binary. The a11y libraries are resolved at runtime on the target host; if absent, a11y tool calls fail gracefully while core features still work.

## Platform support

| Feature | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Screenshot | ✅ X11/Wayland | ✅ Quartz | ✅ GDI |
| Input | ✅ X11/Xtst | ✅ CoreGraphics | ✅ SendInput |
| Terminal mask | 🟡 /proc scan + bottom-1/3 fallback | ✅ CGWindowList | ✅ EnumWindows |
| Accessibility | 🟡 AT-SPI2 (purego) | 🟡 AX API (purego) | 🟡 UIAutomation (purego) |
| Clipboard | ✅ Wayland wire protocol / X11 wire protocol | ✅ Pasteboard (purego) | ✅ user32 (purego) |
| Screen recording (GIF) | ✅ stdlib image/gif | ✅ stdlib image/gif | ✅ stdlib image/gif |
| Escape hook | ✅ X11 | ✅ CoreGraphics | ✅ GetAsyncKeyState |

**Legend:**
✅ Full support
🟡 Requires extra runtime libraries / permissions, or has limitations

## Test coverage

```
pkg/accessibility  16.5% (requires platform a11y permission; most paths are platform syscalls)
pkg/capability     56.1%
pkg/coord          87.5%
pkg/input          27.1% (headless limitations)
pkg/lock           65.2%
pkg/safety         78.3%
pkg/screenshot     20.2% (headless limitations)
```

Core logic (coord, lock, safety, capability detection) has high coverage. Input/screenshot/accessibility tests require a real display server and platform permissions.

## Comparison with Rust version

| Aspect | Rust | **Go** |
|--------|------|--------|
| Core features | ✅ | ✅ |
| Accessibility | ✅ Full | ✅ **Full (recursive tree)** |
| CGo deps | ✅ enigo (C FFI on Linux/macOS) | ✅ **Zero (purego everywhere)** |
| Cross-compile | 🟡 Complex | ✅ **One command** |
| Binary size | ~8MB | ~9MB |
| Test coverage | Good | **Good** |

**Recommendation:** Use the Go version for easier builds and deployment. Both versions now offer full accessibility tree traversal; the Go version additionally avoids CGo entirely.

## Roadmap

- [ ] Better Linux terminal window-geometry detection (map `/proc`-detected terminals to actual X11 window bounds; D-Bus path)
- [ ] Optional custom build tag (e.g. `noaccessibility`) to strip the a11y package at compile time for minimal binaries
- [ ] Clipboard image write: accept WebP input (blank-import `golang.org/x/image/webp` in `cmd/server/main.go`)
- [ ] Screen recording: optional MP4/WebM output via optional ffmpeg subprocess for callers that need audio or smaller files

## License

Same as parent project.
