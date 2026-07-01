# dbushelper

Pure-Go client for the [AT-SPI2](https://gitlab.gnome.org/GNOME/at-spi2-core) accessibility D-Bus registry. Runs **inside** the agentd LXC sandbox (not on the host) and is consumed by:

- `cmd/a11y-helper` — a thin CLI binary that wraps this package for cross-container exec via `sbMgr.Exec`
- `subpackage/agentd/internal/agent/tools_a11y.go` — the agentd tool layer, which exec's the helper binary and parses its JSON envelope into tool results (`desktop_inspect`, `desktop_a11y_click`, `desktop_a11y_type`)

## Layout

```
subpackage/dbushelper/
├── go.mod                      module github.com/NekoSekaiMoe/agentboster/subpackage/dbushelper
├── atspi.go                    exported: RoleIsStructural, IsOnScreen, role/state consts
├── conn.go                     exported: OpenBus, SocketAlive, DisplayNumber, CandidateCachePaths
├── refs.go                     exported: RefEntry, WriteRefs, LookupRef, NormalizeRef, RefsPath
├── snapshot.go                 exported: RunSnapshot, SnapshotOutput, SnapshotItem, Diagnostics, FormatLine
├── action.go                   exported: RunClick/RunType/RunFill, ActionOutput, Fallback, PreferredActionIndex
├── helper_test.go              unit tests for the library
└── cmd/a11y-helper/
    ├── main.go                 thin CLI: flags + JSON + exit
    └── main_test.go            parseLimit tests (CLI detail, not library API)
```

The library has **no side effects** (no stdout, no `os.Exit`). Every function returns data structures. JSON serialization + exit codes live only in `cmd/a11y-helper/main.go`, so future consumers can import the library and call `RunSnapshot` / `RunClick` directly in-process without going through fork+exec.

## Build

```bash
cd subpackage/dbushelper
go build ./...                       # library + cmd
go test ./...                        # unit tests
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w" \
  -o agentd-a11y-helper ./cmd/a11y-helper
```

godbus is pure Go, so `CGO_ENABLED=0` produces a fully static binary that runs on any Linux distro (Alpine, Debian, etc.) without a C runtime mismatch.

## Release

The helper binary is distributed as a GitHub release asset, fetched on first `desktop_inspect` call by `install_a11y_helper_from_release` in `subpackage/agentd/internal/agent/desktop/desktop_install.sh`.

**Asset contract** (must match the install script):

```
releases/download/<version>/agentd-a11y-helper-linux-<arch>-<version>
```

where `<arch>` ∈ {`amd64`, `arm64`} and `<version>` is the unified release tag (e.g. `v0.1.0`). The same tag also produces `agentd-linux-<arch>-<version>` and `agentboster-cli-<version>.tar.gz` — one release per version carries all artifacts.

**To cut a new release:**

1. Tag the commit:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
2. The [`release`](../../.github/workflows/release.yml) GitHub Actions workflow triggers automatically. It builds (in parallel):
   - `agentd-a11y-helper-linux-{amd64,arm64}-<version>` (cross-compiled on ubuntu-latest)
   - `agentd-linux-{amd64,arm64}-<version>` (native runners: ubuntu-latest + ubuntu-24.04-arm)
   - `agentboster-cli-<version>.tar.gz` (Node bundle, OS-agnostic)
3. The `release` job verifies all 5 expected assets are present and attaches them to the GitHub Release named `v0.1.0`.
4. Update the default `AGENTD_A11Y_HELPER_VERSION` (and the cli/agentd equivalent, if they grow version-pin fields) to the new tag, or leave it for sandbox env override.

To test the pipeline without tagging, run the workflow manually via `workflow_dispatch` (the release-upload step is skipped on manual runs — they only verify the build matrix).

## Coverage caveats

Inherited from AT-SPI, not from this code:

| App class | Coverage |
|---|---|
| GTK3 / GTK4 (XFCE, GNOME apps, `xfce4-terminal`) | high |
| Chromium ≥ 90 (+ Electron, since it embeds Chromium) | high (requires `--force-renderer-accessibility`) |
| Firefox | likely works, untested |
| Qt5 / Qt6 | requires the linuxaccessibility plugin; not configured |
| LibreOffice (esp. Calc) | pathological — truncated by `maxVisits=8000` |
| raw-X11 apps (`xterm`, legacy Motif) | invisible to AT-SPI; `xdotool` fallback used |
