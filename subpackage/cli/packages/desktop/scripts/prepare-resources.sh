#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$DESKTOP_DIR/src-tauri/resources"

mkdir -p "$RESOURCES_DIR"

# Determine host triple
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  TARGET="aarch64-apple-darwin" ;;
  Darwin-x86_64) TARGET="x86_64-apple-darwin" ;;
  Linux-x86_64)  TARGET="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
  MINGW*|MSYS*|CYGWIN*) TARGET="x86_64-pc-windows-msvc" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

EXT=""
if [[ "$TARGET" == *windows* ]]; then
  EXT=".exe"
fi

REPO_ROOT="$(cd "$DESKTOP_DIR/../../../.." && pwd)"
MCP_CRATE="$REPO_ROOT/subpackage/computer-use-mcp"

CLI_BIN_NAME="agentboster-cli-${TARGET}${EXT}"
MCP_BIN_NAME="computer-use-mcp${EXT}"

# 1) Copy computer-use-mcp binary
# Check CI artifact path first, then local build paths
if [[ -n "${ARTIFACT_DIR:-}" ]] && [[ -f "$ARTIFACT_DIR/$MCP_BIN_NAME" ]]; then
  cp "$ARTIFACT_DIR/$MCP_BIN_NAME" "$RESOURCES_DIR/$MCP_BIN_NAME"
elif [[ -f "$MCP_CRATE/target/release/$MCP_BIN_NAME" ]]; then
  cp "$MCP_CRATE/target/release/$MCP_BIN_NAME" "$RESOURCES_DIR/$MCP_BIN_NAME"
elif [[ -f "$MCP_CRATE/target/debug/$MCP_BIN_NAME" ]]; then
  cp "$MCP_CRATE/target/debug/$MCP_BIN_NAME" "$RESOURCES_DIR/$MCP_BIN_NAME"
else
  echo "WARNING: computer-use-mcp binary not found; Desktop will lack computer-use tools." >&2
fi

# 2) Copy agentboster-cli binary
if [[ -n "${ARTIFACT_DIR:-}" ]] && [[ -f "$ARTIFACT_DIR/$CLI_BIN_NAME" ]]; then
  cp "$ARTIFACT_DIR/$CLI_BIN_NAME" "$RESOURCES_DIR/$CLI_BIN_NAME"
elif [[ -f "$REPO_ROOT/subpackage/cli/dist/$CLI_BIN_NAME" ]]; then
  cp "$REPO_ROOT/subpackage/cli/dist/$CLI_BIN_NAME" "$RESOURCES_DIR/$CLI_BIN_NAME"
fi

# Make binaries executable
chmod +x "$RESOURCES_DIR"/* 2>/dev/null || true

echo "Resources prepared in $RESOURCES_DIR:"
ls -la "$RESOURCES_DIR/"
