#!/usr/bin/env bash
set -euo pipefail

# Fill src-tauri/resources/ with the sidecar binaries the Tauri bundle
# embeds (`bundle.resources: ["resources/*"]` in tauri.conf.json).
#
# Two sidecars are expected at runtime by src-tauri/src/lib.rs:
#
#   computer-use-mcp[.exe]                   — MCP server (single binary)
#   agentboster-cli-<rust-triple>[.cmd|.exe] — CLI entry (sh wrapper on
#                                              unix; .cmd shim on Windows)
#   agentboster-cli.cjs                      — CLI JS bundle (companion to
#                                              the wrapper/shim; the wrapper
#                                              execs `node …/agentboster-cli.cjs`)
#
# The CLI is a Node bundle, not a native binary: it ships as TWO files
# (a POSIX `#!/bin/sh` wrapper + the .cjs). On Windows there's no #!,
# so the Rust side (discover_sidecar in lib.rs) synthesizes a .cmd shim
# at runtime; we only need to stage the .cjs + a marker wrapper there.
#
# ── Binary sources ────────────────────────────────────────────────
# Each sidecar resolves via the same 3-tier lookup:
#
#   1. CI staging dirs (env vars, set by .github/workflows/{release,build-all}.yml):
#      ARTIFACT_DIR    → dir holding computer-use-mcp[.exe]
#      CLI_STAGED_DIR  → dir holding agentboster-cli + agentboster-cli.cjs
#                        (layout produced by `yarn package`, i.e. the
#                        flattened tarball: the wrapper sits next to .cjs)
#
#   2. Local cargo builds:
#      subpackage/computer-use-mcp/target/{release,debug}/computer-use-mcp[.exe]
#
#   3. Local CLI dist:
#      subpackage/cli/dist/agentboster-cli.cjs   (bundle.mjs output)
#
# Missing MCP prints a WARNING (Desktop degrades to no computer-use tools).
# Missing CLI prints a WARNING (Desktop falls back to PATH / auto-installer).
# Neither is fatal: a dev `cargo check` only needs resources/ to be non-empty.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$DESKTOP_DIR/src-tauri/resources"

mkdir -p "$RESOURCES_DIR"
touch "$RESOURCES_DIR/.keep"

# Determine host Rust triple. CI runners pass TARGET explicitly to avoid
# uname ambiguity on Windows ARM64 (Git Bash uname -m is unreliable there);
# locals fall back to uname probing.
if [[ -n "${TARGET:-}" ]]; then
  : # trust the caller (release.yml / build-all.yml set this per matrix)
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  TARGET="aarch64-apple-darwin" ;;
    Darwin-x86_64) TARGET="x86_64-apple-darwin" ;;
    Linux-x86_64)  TARGET="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
    MINGW*|MSYS*|CYGWIN*) TARGET="x86_64-pc-windows-msvc" ;;
    *) echo "Unsupported platform: $(uname -s)-$(uname -m) (set TARGET= to override)" >&2; exit 1 ;;
  esac
fi

EXT=""
if [[ "$TARGET" == *windows* ]]; then
  EXT=".exe"
fi

REPO_ROOT="$(cd "$DESKTOP_DIR/../../../.." && pwd)"
MCP_CRATE="$REPO_ROOT/subpackage/computer-use-mcp"
CLI_DIST="$REPO_ROOT/subpackage/cli/packages/coding-agent/dist"

# Runtime file-name contract (must mirror discover_sidecar / discover_mcp_binary
# in src-tauri/src/lib.rs):
#   non-Windows: agentboster-cli-<triple>      (sh wrapper, executable)
#                agentboster-cli.cjs           (node bundle, same dir)
#   Windows:     agentboster-cli-<triple>.cmd  (build-time shim, copied
#                                              here; lib.rs only writes
#                                              one at runtime as a fallback)
#                agentboster-cli.cjs           (node bundle, same dir)
#   MCP:         computer-use-mcp[.exe]        (no triple)
# The CLI launcher and the MCP binary use DIFFERENT suffixes on Windows:
# MCP is a native binary (.exe), the CLI launcher is a batch shim (.cmd).
# The CLI .cmd is synthesized HERE at build time and copied in; lib.rs's
# `ensure_cli_launcher` searches for exactly `agentboster-cli-<triple>.cmd`.
# (Using a shared EXT for both previously produced an .exe-named .cmd file
# that never matched discover_sidecar's search — see Windows fallback path.)
if [[ "$TARGET" == *windows* ]]; then
  CLI_BIN_NAME="agentboster-cli-${TARGET}.cmd"
else
  CLI_BIN_NAME="agentboster-cli-${TARGET}"
fi
MCP_BIN_NAME="computer-use-mcp${EXT}"

# ── 1) computer-use-mcp ───────────────────────────────────────────
if [[ -n "${ARTIFACT_DIR:-}" ]] && [[ -f "$ARTIFACT_DIR/$MCP_BIN_NAME" ]]; then
  cp "$ARTIFACT_DIR/$MCP_BIN_NAME" "$RESOURCES_DIR/$MCP_BIN_NAME"
elif [[ -f "$MCP_CRATE/target/release/$MCP_BIN_NAME" ]]; then
  cp "$MCP_CRATE/target/release/$MCP_BIN_NAME" "$RESOURCES_DIR/$MCP_BIN_NAME"
elif [[ -f "$MCP_CRATE/target/debug/$MCP_BIN_NAME" ]]; then
  cp "$MCP_CRATE/target/debug/$MCP_BIN_NAME" "$RESOURCES_DIR/$MCP_BIN_NAME"
else
  echo "WARNING: computer-use-mcp binary not found; Desktop will lack computer-use tools." >&2
fi

# ── 2) agentboster-cli (launcher + .cjs companion) ────────────────
#
# The launcher ships next to `agentboster-cli.cjs`:
#   - non-Windows: a POSIX `#!/bin/sh` wrapper named `agentboster-cli`
#     (execs `node …/agentboster-cli.cjs`).
#   - Windows: there is no sh wrapper in the tarball, so we synthesize
#     `agentboster-cli-<triple>.cmd` HERE at build time and copy it in.
#     lib.rs's `ensure_cli_launcher` reuses it if present and only falls
#     back to runtime synthesis when missing — so the normal install
#     path never writes into the (potentially read-only) resources dir.
#
# We copy the launcher (renamed to the triple form Rust's discover_sidecar
# searches for) AND the .cjs it execs.
staged_cli_wrapper=""
staged_cli_cjs=""

if [[ -n "${CLI_STAGED_DIR:-}" ]]; then
  # CI: tarball already extracted by the workflow into $CLI_STAGED_DIR.
  if [[ -f "$CLI_STAGED_DIR/agentboster-cli.cjs" ]]; then
    staged_cli_cjs="$CLI_STAGED_DIR/agentboster-cli.cjs"
  fi
  if [[ "$TARGET" != *windows* ]] && [[ -f "$CLI_STAGED_DIR/agentboster-cli" ]]; then
    staged_cli_wrapper="$CLI_STAGED_DIR/agentboster-cli"
  fi
else
  # Local dev: bundle.mjs wrote the .cjs into packages/coding-agent/dist.
  if [[ -f "$CLI_DIST/agentboster-cli.cjs" ]]; then
    staged_cli_cjs="$CLI_DIST/agentboster-cli.cjs"
  fi
fi

if [[ -n "$staged_cli_cjs" ]]; then
  cp "$staged_cli_cjs" "$RESOURCES_DIR/agentboster-cli.cjs"

  if [[ "$TARGET" != *windows* ]]; then
    # Non-Windows: also stage the sh wrapper under the triple name
    # discover_sidecar searches for.
    if [[ -n "$staged_cli_wrapper" ]]; then
      cp "$staged_cli_wrapper" "$RESOURCES_DIR/$CLI_BIN_NAME"
    fi
  else
    # Windows: synthesize the .cmd shim at build time so the normal path
    # doesn't depend on lib.rs writing into resources/ at runtime. The
    # shim uses `%~dp0` ("this script's dir") so it finds the sibling
    # .cjs regardless of install path — same body lib.rs generates.
    cmd_body=$'@echo off\r\nnode "%~dp0agentboster-cli.cjs" %*\r\n'
    printf '%s' "$cmd_body" > "$RESOURCES_DIR/$CLI_BIN_NAME"
  fi
else
  echo "WARNING: agentboster-cli.cjs not found; Desktop will fall back to PATH / auto-installer." >&2
fi

# Make binaries executable (no-op on Windows, harmless).
chmod +x "$RESOURCES_DIR"/* 2>/dev/null || true

echo "Resources prepared in $RESOURCES_DIR (TARGET=$TARGET):"
ls -la "$RESOURCES_DIR/"
