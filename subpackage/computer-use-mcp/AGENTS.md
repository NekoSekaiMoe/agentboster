# CLAUDE.md — computer-use-mcp-go/

Compact guide for AI coding sessions working in the `computer-use-mcp-go/` package. Go implementation of the computer-use MCP server, providing screenshots, input simulation, and accessibility APIs.

## Read first

- `README.md` is the best architecture map — covers features, build instructions, platform support matrix.
- This is a **standalone Go module**, NOT part of the root yarn workspace or the agentd Go module.
- The package is **CGo-optional**: core features (screenshot, input, terminal masking, session lock) use pure Go or purego; only accessibility APIs require CGo.

## Module

Go module (`go 1.23.2`), completely independent from:
- Root yarn workspace (Web app)
- `subpackage/agentd/` (Go daemon, separate `go.mod`)
- `subpackage/dbushelper/` (Go AT-SPI2 client, separate `go.mod`)

Run all commands from this directory.

## Toolchain

| Tool | Purpose |
|------|---------|
| Go 1.23.2+ | Build + test |
| `github.com/kbinani/screenshot` | Cross-platform screen capture |
| `github.com/disintegration/imaging` | Image processing (Lanczos3) |
| `github.com/ebitengine/purego` | CGo-free syscall bindings |
| `github.com/mark3labs/mcp-go` | MCP protocol implementation |

**Platform-specific (optional):**
- Linux: `libatspi2.0-dev` (accessibility only)
- macOS: Accessibility permission (accessibility only)
- Windows: None (accessibility uses purego)

## Commands

```bash
go build -o computer-use-mcp ./cmd/server  # Build binary
go test ./...                               # Run all tests
go test ./... -cover                        # With coverage
go test ./pkg/screenshot -v                 # Specific package
```

The binary is `computer-use-mcp` (~9MB).

## Package layout

| Directory | What it does |
|-----------|--------------|
| `cmd/server/main.go` | MCP JSON-RPC server (stdio), tool registration, request routing |
| `cmd/server/handlers.go` | Tool handler implementations (screenshot, mouse_move, etc.) |
| `pkg/capability/` | Platform detection: display server, resolution, scale factor, permissions |
| `pkg/screenshot/` | Screen capture, Lanczos3 downscaling, terminal masking, PNG/JPEG encoding |
| `pkg/input/` | Input controller: mouse move/click/drag, keyboard typing/keys/combos via purego |
| `pkg/coord/` | Coordinate mapper: bidirectional screenshot-space ↔ native-screen conversion |
| `pkg/lock/` | Session lock file with PID tracking, stale lock reclamation, cross-app conflict prevention |
| `pkg/escape/` | Global Escape key listener (X11/CoreGraphics/Windows) for emergency abort |
| `pkg/accessibility/` | **Optional** unified accessibility tree (macOS AX API, Windows UIAutomation, Linux AT-SPI2) |

## MCP protocol

- JSON-RPC 2.0 over newline-delimited stdio
- Protocol version: `2024-11-05`
- Tools: `screenshot`, `mouse_move`, `mouse_click`, `mouse_drag`, `type_text`, `key_event`, `capabilities`
- Each tool returns `{"success": bool, "data": any, "error": string}`

## Non-obvious constraints

- **Coordinates are screenshot-relative**: Input tools use the scale factor and monitor origin from the last screenshot to map back to native pixels. If no screenshot was taken, falls back to detected display scale.
- **Terminal safety**: `allow_terminal_edit` in screenshot options defaults to `false`. Screenshots mask terminals; input operations are rejected when a terminal is in the foreground (macOS/Windows). Set to `true` to override.
- **Linux terminal masking is crude**: No reliable API to identify terminal windows, so the bottom 1/3 of the screen is masked. macOS/Windows mask per-window.
- **Session lock is cross-app**: Lock checks `~/.config/agentboster-cli/` and `~/.config/agentboster-desktop/` to prevent CLI and desktop app from using computer-use simultaneously.
- **Escape hook runs on a background thread**: Cannot be cleanly joined; meant to live for the process lifetime.
- **purego is CGo-free but platform-specific**: Input simulation uses `purego.Dlopen` + `purego.RegisterLibFunc` to call system APIs (libX11/libXtst on Linux, CoreGraphics on macOS, user32.dll on Windows). Each platform has its own `input_{linux,darwin,windows}.go`.
- **Accessibility is optional**: The `pkg/accessibility/` package requires CGo on Linux (AT-SPI2) and macOS (AX API), but uses purego on Windows (UIAutomation). Core features (screenshot, input) work without it.

## Testing

- `pkg/coord/` has unit tests for coordinate mapping roundtrips (87.5% coverage).
- `pkg/lock/` has unit tests for lock acquire/release, double-acquire prevention, stale lock reclamation (69.4% coverage).
- `pkg/capability/` has unit tests for platform detection (56.1% coverage).
- Screenshot and input tests require a display server and are gracefully skipped in headless/CI environments.
- Accessibility tests require platform-specific permissions and skip if unavailable.

## Gotchas

- **Headless environments**: Tests that need a display (screenshot capture, input simulation) detect `screenshot.NumActiveDisplays() == 0` and skip with `t.Skip()`. They don't fail.
- **Build tags**: Platform-specific files use `// +build linux`, `// +build darwin`, `// +build windows`. The `stub.go` file covers unsupported platforms.
- **Linux AT-SPI2 CGo**: The `pkg/accessibility/linux.go` file uses `#cgo pkg-config: atspi-2`. If `libatspi2.0-dev` is not installed, the build fails. To build without accessibility, use build tags (not yet implemented).
- **purego limitations**: `purego.Dlopen` requires library names (e.g., `libX11.so.6` on Linux, `user32.dll` on Windows). Library paths vary across distros; the code uses common names that work on most systems.
- **Windows VARIANT handling**: `pkg/accessibility/windows.go` uses `oleaut32.dll` `VariantClear` to free COM memory. Forgetting this causes leaks.
- **macOS Accessibility permission**: The `AXIsProcessTrusted()` call in `darwin.go` returns `false` if the app doesn't have Accessibility permission. The backend creation fails with a clear error.

## Cross-compilation

**Pure Go targets** (no CGo) compile trivially:
```bash
GOOS=darwin GOARCH=amd64 go build ./cmd/server   # macOS
GOOS=windows GOARCH=amd64 go build ./cmd/server  # Windows
GOOS=linux GOARCH=amd64 go build ./cmd/server    # Linux
```

**With accessibility (CGo)**, you must build on the target platform or use a cross-compilation toolchain (complex).

## Comparison with Rust version

| Feature | Rust (`computer-use-mcp/`) | Go (`computer-use-mcp-go/`) |
|---------|---------------------------|----------------------------|
| Screenshot | ✅ xcap | ✅ kbinani/screenshot |
| Input simulation | ✅ enigo (uses CGo) | ✅ purego (zero CGo) |
| Coordinate mapping | ✅ | ✅ |
| Terminal masking | ✅ (Linux better) | 🟡 (Linux crude) |
| Session lock | ✅ | ✅ |
| Escape hook | ✅ rdev | ✅ purego |
| Accessibility | ✅ Full tree traversal | 🟡 Basic (node-by-ID, click) |
| Cross-compile | 🟡 Complex (Rust + C toolchains) | ✅ One command (pure Go) |
| Binary size | ~8MB | ~9MB |
| Test coverage | Good | Good (core 70%+) |

**Recommendation:** Use Go version for easier deployment. Use Rust version if you need full accessibility tree traversal.

## Design decisions

- **purego over CGo for input**: Eliminates CGo setup complexity and cross-compilation pain. Trade-off: more verbose syscall code, but worth it for zero-dependency builds.
- **Coordinate mapping is explicit**: The `CoordMapper` struct is passed to input methods rather than being global state. This makes coordinate systems explicit in the API.
- **Terminal masking is conservative**: Defaults to blocking terminal edits. Safer default for autonomous agents; human operators can override.
- **Session lock uses filesystem, not DB**: Simpler than coordinating with a Postgres-backed KV. Works for single-machine scenarios (both CLI and desktop run on the same host).
- **Accessibility is optional**: Core features (screenshot, input) work without it. Accessibility is for advanced use cases (UI automation, screen readers).

## Integration notes

- The MCP server speaks JSON-RPC 2.0 over stdio. The AgentBoster CLI/desktop app should spawn this binary as a subprocess and communicate via stdin/stdout pipes.
- The server is stateless except for the session lock and coordinate mapper state (updated on each screenshot). No database, no HTTP server.
- The `capabilities` tool returns platform info (display server, resolution, scale factor, permissions). Clients should call this first to check if computer-use is available.
- The binary is self-contained: copy it to the target machine and run. No npm install, no cargo build.

## Future work

- [ ] Build tags to disable accessibility (optional CGo)
- [ ] Better Linux terminal detection (via D-Bus or /proc)
- [ ] Full accessibility tree traversal (currently only node-by-ID)
- [ ] Clipboard integration (read/write)
- [ ] Screen recording (video capture)
