# computer-use-mcp-go

Go implementation of the MCP server for computer use (screenshots, input, accessibility). Cross-platform alternative to the Rust version.

## Features

✅ **Screenshot capture** with Lanczos3 scaling and coordinate mapping  
✅ **Cross-platform input simulation** (mouse, keyboard) via purego (zero CGo for input)  
✅ **Terminal window masking** for safety  
✅ **Session lock** with zombie process cleanup  
✅ **Escape hook** for emergency stop  
✅ **Platform capability detection**  
🟡 **Accessibility tree API** (optional, requires platform libraries)  

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
  accessibility/     Accessibility tree (optional CGo)
```

## Build

### Quick start (no accessibility)

```bash
go build -o computer-use-mcp ./cmd/server
```

Binary: ~9MB, zero CGo dependencies for core features.

### With accessibility support

**Linux:**
```bash
sudo apt-get install libatspi2.0-dev
go build -o computer-use-mcp ./cmd/server
```

**macOS:**
```bash
# Requires Accessibility permission in System Preferences
go build -o computer-use-mcp ./cmd/server
```

**Windows:**
```bash
# Uses UIAutomation via purego
go build -o computer-use-mcp ./cmd/server
```

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

| Tool | Description |
|------|-------------|
| `screenshot` | Capture screen with optional scaling |
| `mouse_move` | Move cursor to coordinates |
| `mouse_click` | Click mouse button |
| `mouse_drag` | Drag from start to end |
| `type_text` | Type text string |
| `key_event` | Press/release/click key |
| `capabilities` | Get platform capabilities |

## Cross-compilation

```bash
# Linux → macOS
GOOS=darwin GOARCH=amd64 go build ./cmd/server

# Linux → Windows
GOOS=windows GOARCH=amd64 go build ./cmd/server

# macOS → Linux
GOOS=linux GOARCH=amd64 go build ./cmd/server
```

**Caveat:** Accessibility package requires CGo and cannot be cross-compiled. Build on the target platform or disable with build tags.

## Platform support

| Feature | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Screenshot | ✅ X11/Wayland | ✅ Quartz | ✅ GDI |
| Input | ✅ X11/Xtst | ✅ CoreGraphics | ✅ SendInput |
| Terminal mask | 🟡 Fallback | ✅ CGWindowList | ✅ EnumWindows |
| Accessibility | 🟡 AT-SPI2 (CGo) | 🟡 AX API (CGo) | 🟡 UIAutomation (purego) |
| Escape hook | ✅ X11 | ✅ CoreGraphics | ✅ GetAsyncKeyState |

**Legend:**  
✅ Full support  
🟡 Requires extra dependencies or has limitations  

## Test coverage

```
pkg/capability    56.1%
pkg/coord         87.5%
pkg/input         27.1% (headless limitations)
pkg/lock          69.4%
pkg/screenshot    13.0% (headless limitations)
```

Core logic (coord, lock, capability detection) has high coverage. Input/screenshot tests require real display servers.

## Comparison with Rust version

| Aspect | Rust | **Go** |
|--------|------|--------|
| Core features | ✅ | ✅ |
| Accessibility | ✅ Full | 🟡 Basic |
| Cross-compile | 🟡 Complex | ✅ **One command** |
| CGo deps | ✅ enigo | ✅ **Zero (core)** |
| Binary size | ~8MB | ~9MB |
| Test coverage | Good | **Good** |

**Recommendation:** Use Go version for easier builds and deployment. Use Rust version if you need full accessibility tree traversal on all platforms.

## License

Same as parent project.
