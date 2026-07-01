# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Pure-Go AT-SPI2 accessibility D-Bus client. Runs inside the agentd LXC sandbox and is consumed by `cmd/a11y-helper` (a thin CLI) and by agentd's tool layer (`tools_a11y.go`). The library has no side effects — all JSON serialization and exit codes live in `cmd/a11y-helper/main.go`.

## Module

Standalone Go module: `github.com/NekoSekaiMoe/agentboster/subpackage/dbushelper` (Go 1.26.4). Not part of the root yarn workspace or the agentd Go module. Run all commands from this directory.

## Commands

```bash
go build ./...                    # build library + cmd
go test ./...                     # all tests (unit + e2e)
go test -run TestNormalizeRef     # single test
go test ./cmd/a11y-helper/...    # CLI tests only (includes e2e that builds the binary)

# Release binary (fully static, no CGO):
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w" -o agentd-a11y-helper ./cmd/a11y-helper
```

## Architecture

- `conn.go` — bus discovery: resolves AT-SPI bus address via env var → /proc scan → cache-path probing. No reliance on the session bus.
- `atspi.go` — D-Bus interface wrappers (Accessible, Component, Action, EditableText, Text) using raw godbus calls. No Go AT-SPI binding exists; this is hand-rolled.
- `snapshot.go` — iterative DFS walk of the accessibility tree, capped at `maxVisits=8000` nodes / `maxApps=32` apps. Returns `SnapshotOutput` envelope.
- `refs.go` — persisted ref index (`/tmp/agentd-a11y-refs.json`, overridable via `AGENTD_A11Y_REFS` env). Snapshot writes it; click/type/fill read it.
- `action.go` — click/type/fill actions. On failure, returns fallback (x,y) coordinates from the ref's bounding box so the caller can replay via xdotool/RFB.
- `cmd/a11y-helper/main.go` — CLI dispatch + JSON emission. Exit codes: 0 = success or per-action failure (JSON with `ok=false`), 1 = catastrophic (bus unreachable), 2 = usage error.

## Testing

- `conn_unix_test.go` has a `//go:build linux` tag — socket-probing tests only run on Linux.
- `cmd/a11y-helper/cli_e2e_test.go` builds the binary and exercises it as a subprocess; skips if `go` is not on PATH.
- Tests use `t.Setenv("AGENTD_A11Y_REFS", ...)` to isolate the refs file per test.
- Tests use a fake `/proc` layout (tempdir) for `scanProcForBusAddresses`; no real D-Bus daemon needed for unit tests.

## Wire format contract

All subcommands emit a single JSON object on stdout. Agentd parses stdout verbatim. Diagnostics/errors go to stderr only. The `ok` field distinguishes success from per-action failure (which still exits 0 and includes a `fallback` coordinate block).
