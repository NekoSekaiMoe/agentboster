# AGENTS.md — dbushelper/

Compact guide for OpenCode sessions working in the `dbushelper/` package. Pure-Go AT-SPI2 accessibility D-Bus client, consumed by agentd's tool layer (`tools_a11y.go`) via the `cmd/a11y-helper` CLI binary.

## Read first

- `dbushelper/README.md` is the best map for architecture, wire format, and tiered-snapshot semantics.
- The library has **no side effects** — all JSON serialization and process lifecycle live in `cmd/a11y-helper/main.go`.
- Runs **inside** the agentd LXC sandbox; the host calls `sbMgr.Exec("a11y-helper", ...)` and parses stdout.

## Module

Standalone Go module: `github.com/NekoSekaiMoe/agentboster/subpackage/dbushelper` (Go 1.26.4). Not part of the root yarn workspace or the agentd Go module. Run all commands from this directory.

## Toolchain

| Tool | Version | Purpose |
|------|---------|---------|
| Go | 1.26.4 | build + test |
| godbus | v5.2.2 | raw D-Bus protocol (pure Go, no CGO) |
| golang.org/x/sys | v0.27.0 | unix socket helpers |

## Commands

```bash
go build ./...                    # library + cmd/a11y-helper
go vet ./...                      # static analysis
go test ./...                     # all tests (unit + CLI e2e)
go test -run TestNormalizeRef     # single test
go test ./cmd/a11y-helper/...    # CLI e2e only (builds binary as subprocess)

# Release binary (fully static, no CGO):
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w" -o agentd-a11y-helper ./cmd/a11y-helper
```

## File layout

| File | Public API |
|------|-----------|
| `conn.go` | `OpenBus`, `SocketAlive`, `DisplayNumber`, `CandidateCachePaths` |
| `atspi.go` | `RoleIsStructural`, `RoleIsInteractive`, `IsOnScreen`, role/state constants, AT-SPI interface wrappers |
| `snapshot.go` | `RunSnapshot`, `SnapshotOutput`, `SnapshotItem`, `Diagnostics`, `FormatLine`, `JsonQuote` |
| `refs.go` | `RefEntry`, `RefKind`, `WriteRefs`, `AppendRefs`, `LookupRef`, `NormalizeRef`, `RefsPath` |
| `action.go` | `RunClick`, `RunType`, `RunFill`, `RunInspect`, `InspectOutput`, `ActionOutput`, `Fallback`, `PreferredActionIndex` |
| `cmd/a11y-helper/main.go` | CLI binary — flag parsing, JSON serialization, exit codes |

## Testing

- `conn_unix_test.go` has `//go:build linux` — socket-probing tests only run on Linux.
- `cmd/a11y-helper/cli_e2e_test.go` builds the binary as a subprocess; skips if `go` is not on PATH.
- Tests use `t.Setenv("AGENTD_A11Y_REFS", ...)` to isolate the refs file per test.
- Tests use a fake `/proc` layout (tempdir) for `scanProcForBusAddresses`; no real D-Bus daemon needed for unit tests.
- `helper_test.go` covers ref normalization, write/lookup round-trips, atomic writes, counter continuation, role classification, and line formatting.

## Wire format contract

- All subcommands emit a single JSON object on stdout. agentd parses stdout verbatim.
- Diagnostics/errors go to stderr only.
- Exit codes: `0` = success or per-action failure (JSON `ok=false`, includes `fallback` coords when available), `1` = catastrophic (bus unreachable, refs unreadable), `2` = usage error.
- The host must check the JSON `ok` field, **not** exit code alone.

## Tiered refs

| Form | Kind | Legal targets |
|------|------|---------------|
| `eN` | action | `click` / `type` / `fill` / `inspect` |
| `xN` | group | `inspect` only — `click`/`type`/`fill` fail with `ok=false` |

Both live in the same refs file (`/tmp/agentd-a11y-refs.json`, override via `AGENTD_A11Y_REFS`). `snapshot` atomically **overwrites** it; `inspect` **appends** new entries (continued counters); `click`/`type`/`fill` only read.

## Walk caps

| Constant | Value | Effect |
|----------|-------|--------|
| `maxApps` | 32 | Top-level apps descended |
| `maxVisits` | 8000 | Total nodes inspected |
| `maxStack` | 4000 | Pending DFS stack depth (bounds memory on wide trees) |
| `DefaultLimit` | 300 | Accepted nodes per `snapshot` |
| `InspectLimit` | 200 | Accepted nodes per `inspect` |

When any cap is hit, `SnapshotOutput.Truncated` is `true`.

## Gotchas

- `WriteRefs` uses atomic rename (temp file + `os.Rename` in same dir) — concurrent readers always see a complete file.
- `NormalizeRef` accepts flexible forms: `e3` / `E03` / `ref=e3` / `3` (→ `e3`), `x12` / `X12` / `ref=x12` (→ `x12`).
- Bounding boxes are **absolute screen coordinates** (`CoordType.Screen`); host must NOT apply window offset when replaying fallback via xdotool.
- Qt apps are invisible to AT-SPI unless `QT_ACCESSIBILITY=1` is set and Qt runtime deps are installed in the sandbox — this is not the case by default.
- `RunType` falls back to caret offset `0` when `CaretOffset` call fails or returns negative.
- `inspectSubtree` continues the `eN`/`xN` counters from the existing refs file, so IDs never collide across snapshot→inspect calls.
