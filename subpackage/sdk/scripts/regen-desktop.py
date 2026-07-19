#!/usr/bin/env python3
"""Drift detector for the Desktop SDK surface.

This script does NOT regenerate files — it reports drift between the
Desktop source tier and `subpackage/sdk/src/desktop/`. Run it as a CI
gate or before committing changes that touch Desktop types.

What it checks:

  1. RPC bridge types — every `export type` / `export interface` in
     `subpackage/cli/packages/desktop/src/rpc/bridge.ts` must have a
     matching export in `subpackage/sdk/src/desktop/rpc.ts`. The
     renderer-side types `RpcBridge`, `ActiveRpcBridgeProxy`,
     `rpcBridge`, `setActiveRpcBridge`, `RpcEventCallback`, and
     `UnlistenFn` are runtime values and intentionally excluded.

  2. Tauri commands — every `#[tauri::command]` fn name in
     `subpackage/cli/packages/desktop/src-tauri/src/lib.rs` must
     appear as a key in `DesktopInvokeMap` (defined in
     `subpackage/sdk/src/desktop/invoke.ts`).

  3. Tauri event payloads — every `app.emit("<name>", ...)` /
     `emit_tray_event(app, "<name>")` in lib.rs must appear as a key
     in `DesktopEventMap` (defined in
     `subpackage/sdk/src/desktop/events.ts`). Signal-only tray events
     (`tray-show`) are renderer-only and excluded.

Exit code:
  0 — no drift detected.
  1 — drift detected (or a source file is unreadable).

Usage:
    python3 subpackage/sdk/scripts/regen-desktop.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SDK_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_ROOT = SDK_ROOT.parent / "cli/packages/desktop"
BRIDGE_TS = DESKTOP_ROOT / "src/rpc/bridge.ts"
LIB_RS = DESKTOP_ROOT / "src-tauri/src/lib.rs"

SDK_RPC_TS = SDK_ROOT / "src/desktop/rpc.ts"
SDK_INVOKE_TS = SDK_ROOT / "src/desktop/invoke.ts"
SDK_EVENTS_TS = SDK_ROOT / "src/desktop/events.ts"

# Renderer-only exports from bridge.ts that the SDK intentionally does
# not mirror (they are runtime classes/objects, not data contracts).
BRIDGE_VALUE_EXPORTS = {
    "RpcBridge",
    "ActiveRpcBridgeProxy",
    "rpcBridge",
    "setActiveRpcBridge",
    "RpcEventCallback",
}

# Renderer-only or main-process-internal event names. These are emitted
# from places other than lib.rs (e.g. the tray menu builder) or are not
# part of the public event contract.
EVENTS_IGNORE = {"tray-show"}


def extract_bridge_exports(src: str) -> set[str]:
    """Return the set of exported type/interface names from bridge.ts.

    Matches:
        export type Foo = ...;
        export interface Foo { ... }
        export class Foo { ... }   (excluded — runtime class)
    """
    names: set[str] = set()
    for m in re.finditer(
        r"^export\s+(?:type|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)",
        src,
        re.MULTILINE,
    ):
        names.add(m.group(1))
    return names


def extract_sdk_rpc_exports(src: str) -> set[str]:
    """Same extraction as `extract_bridge_exports`, but on the SDK file."""
    names: set[str] = set()
    for m in re.finditer(
        r"^export\s+(?:type|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)",
        src,
        re.MULTILINE,
    ):
        names.add(m.group(1))
    return names


def extract_tauri_commands(src: str) -> set[str]:
    """Return the set of `fn` names marked `#[tauri::command]`.

    Matches:
        #[tauri::command]
        async fn rpc_start(...) -> ... { ... }
    """
    names: set[str] = set()
    pattern = re.compile(
        r"#\[tauri::command\][^\n]*\n\s*(?:async\s+)?fn\s+([a-z0-9_]+)",
        re.MULTILINE,
    )
    for m in pattern.finditer(src):
        names.add(m.group(1))
    return names


def extract_invoke_map_keys(src: str) -> set[str]:
    """Return the command-name keys declared in `DesktopInvokeMap`.

    Matches lines of the form `<cmd_name>: { args: ...; result: ... }`,
    skipping the inner `args` / `result` field labels by requiring a
    trailing `:` followed by `{`.
    """
    block_match = re.search(
        r"interface\s+DesktopInvokeMap\s*\{(.*?)\n\}",
        src,
        re.DOTALL,
    )
    if not block_match:
        return set()
    body = block_match.group(1)
    return set(
        re.findall(
            r"^\s*([a-z0-9_]+)\s*:\s*\{",
            body,
            re.MULTILINE,
        )
    )


def extract_emit_names(src: str) -> set[str]:
    """Return event names emitted via `app.emit("...")` /
    `emit_tray_event(app, "...")` / `app_handle.emit("...", ...)`,
    and the `install_progress_event_name()` constant.

    Also resolves `install_progress_event_name()` (defined as returning
    the literal `"cli-install-progress"` in lib.rs:503-505) by name.
    """
    names: set[str] = set()
    # Direct string-literal emits.
    for m in re.finditer(
        r'\.emit\(\s*"([a-z0-9\-_]+)"', src
    ):
        names.add(m.group(1))
    for m in re.finditer(
        r'emit_tray_event\(\s*\w+\s*,\s*"([a-z0-9\-_]+)"', src
    ):
        names.add(m.group(1))
    # install_progress_event_name() → resolves to a const string.
    const_match = re.search(
        r'fn\s+install_progress_event_name\(\)[^{]*\{\s*"([a-z0-9\-_]+)"',
        src,
    )
    if const_match:
        # The emitter is called as emit_progress(... ) →
        # install_progress_event_name(). Detect both the call site
        # (already matched by `.emit(` if it's inlined) and resolve
        # the const directly.
        names.add(const_match.group(1))
    return names


def extract_event_map_keys(src: str) -> set[str]:
    """Return the keys declared in `DesktopEventMap`."""
    block_match = re.search(
        r"interface\s+DesktopEventMap\s*\{(.*?)\n\}",
        src,
        re.DOTALL,
    )
    if not block_match:
        return set()
    body = block_match.group(1)
    return set(
        re.findall(
            r"^\s*'([a-z0-9\-_]+)'\s*:", body, re.MULTILINE
        )
    )


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        print(
            f"error: source file not found: {path}",
            file=sys.stderr,
        )
        sys.exit(1)


def main() -> int:
    bridge_src = read(BRIDGE_TS)
    lib_src = read(LIB_RS)
    rpc_src = read(SDK_RPC_TS)
    invoke_src = read(SDK_INVOKE_TS)
    events_src = read(SDK_EVENTS_TS)

    drift = False

    # --- 1. RPC bridge types -------------------------------------------
    bridge_exports = (
        extract_bridge_exports(bridge_src) - BRIDGE_VALUE_EXPORTS
    )
    sdk_rpc_exports = extract_sdk_rpc_exports(rpc_src)
    missing_rpc = bridge_exports - sdk_rpc_exports
    extra_rpc = sdk_rpc_exports - bridge_exports
    if missing_rpc or extra_rpc:
        drift = True
        print("drift: rpc.ts vs bridge.ts")
        for name in sorted(missing_rpc):
            print(f"  - missing in sdk/src/desktop/rpc.ts: {name}")
        for name in sorted(extra_rpc):
            print(f"  - extra in sdk/src/desktop/rpc.ts:    {name}")

    # --- 2. Tauri commands ---------------------------------------------
    commands = extract_tauri_commands(lib_src)
    invoke_keys = extract_invoke_map_keys(invoke_src)
    missing_cmds = commands - invoke_keys
    extra_cmds = invoke_keys - commands
    if missing_cmds or extra_cmds:
        drift = True
        print("drift: invoke.ts DesktopInvokeMap vs lib.rs #[tauri::command]")
        for name in sorted(missing_cmds):
            print(f"  - missing in DesktopInvokeMap: {name}")
        for name in sorted(extra_cmds):
            print(f"  - extra in DesktopInvokeMap:   {name}")

    # --- 3. Tauri events ------------------------------------------------
    emit_names = extract_emit_names(lib_src) - EVENTS_IGNORE
    event_keys = extract_event_map_keys(events_src)
    missing_events = emit_names - event_keys
    extra_events = event_keys - emit_names
    if missing_events or extra_events:
        drift = True
        print("drift: events.ts DesktopEventMap vs lib.rs emits")
        for name in sorted(missing_events):
            print(f"  - missing in DesktopEventMap: {name}")
        for name in sorted(extra_events):
            print(f"  - extra in DesktopEventMap:   {name}")

    if drift:
        print(
            "\nDrift detected. Sync sdk/src/desktop/*.ts with the "
            "Desktop source tier and re-run.",
            file=sys.stderr,
        )
        return 1
    print("No drift detected.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
