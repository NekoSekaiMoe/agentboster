# Repository Guidelines

Go implementation of an MCP (Model Context Protocol) server for computer use — screenshots, input simulation, accessibility trees, clipboard, and screen recording. Cross-platform (Linux / macOS / Windows), **zero CGo** (all platform FFI goes through `purego` or `golang.org/x/sys`), and a **standalone Go module** independent of the root yarn workspace and the other `subpackage/*` projects.

> `CLAUDE.md` is a symlink to this file. Editing here covers both.

## Project Structure & Module Organization

- `cmd/server/` — MCP JSON-RPC server (stdio). `main.go` wires tools; handlers split across `handlers.go`, `accessibility_handlers.go`, `clipboard_handlers.go`, `recorder_handlers.go`.
- `pkg/` — one package per concern: `capability` (platform detection), `screenshot` (capture + Lanczos3 scale + terminal mask), `input` (mouse/keyboard), `coord` (screenshot↔native mapping), `lock` (session lock w/ PID tracking), `escape` (global escape listener), `safety` (terminal safety policy), `accessibility` (optional a11y tree), `clipboard`, `recorder` (GIF via stdlib `image/gif`).
- Platform code uses **build-tagged files** (`*_linux.go`, `*_darwin.go`, `*_windows.go`) plus `*_stub.go` companions under `//go:build !<platform>` that return "not available" errors. When adding a platform backend, add both the impl and the stub so the package compiles on every OS.

## Gotchas Easy To Miss

- **Module path ≠ directory path.** `go.mod` declares `github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp` (`subpackages`, plural), but the directory is `subpackage/computer-use-mcp` (singular). Import paths always use the `subpackages/` form.
- **No CGo anywhere** — do not add `import "C"` or CGo-only deps. Use `purego.Dlopen` for runtime-loaded platform libraries; use `golang.org/x/sys` / `syscall` otherwise.
- **`go vet ./...` is enforced in CI.** Windows/darwin/linux syscall code deliberately routes `unsafe.Pointer` through `uintptr` to avoid the `unsafeptr` check — follow that pattern when passing pointers to syscalls.
- Accessibility is **optional and lazy**: if `accessibility.New()` can't load the platform library/permission, the a11y tools are simply not registered. Core features always stay available.

## Build, Test, and Development Commands

```bash
go build -o computer-use-mcp ./cmd/server          # build server binary
go build ./...                                     # build all packages (what CI runs)
go vet ./...                                       # static checks (CI gate)
go test ./... -v                                   # all tests (many skip in headless envs)
go test -short ./pkg/coord ./pkg/lock ./pkg/capability   # headless-safe subset (CI)
go test ./pkg/screenshot -v                        # single package
```

Cross-compile works (no CGo): `GOOS=darwin GOARCH=amd64 go build ./cmd/server`.

## Coding Style & Naming Conventions

Standard `gofmt` / `go vet`. Conventional Commits with **scope `computer-use-mcp-go`**: `feat(computer-use-mcp-go): ...`, `fix(computer-use-mcp-go): ...`, `docs(computer-use-mcp-go): ...`. Tests live as `*_test.go` next to the code; tests needing a display server must `t.Skipf(...)` when none is detected rather than fail.

## Testing Guidelines

- Framework: Go standard `testing`.
- Display-dependent packages (`screenshot`, `input`, `accessibility`) skip gracefully on headless/CI runners — keep that behavior for new tests.
- CI (`.github/workflows/computer-use-mcp-go-ci.yml`) runs `go vet` + `go build` on all three OSes and `go test -short` on the headless-safe packages on Linux only.

## Commit & Pull Request Guidelines

Follow Conventional Commits with the `computer-use-mcp-go` scope (see `git log`). Keep cross-platform builds green on Linux, macOS, and Windows. PRs touching platform code should note which OSes were built/tested locally.
