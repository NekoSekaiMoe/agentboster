#!/usr/bin/env python3
"""Regenerate subpackage/sdk/vendor/core.d.ts from the runtime's exports.

The SDK ships a type stub so the package can be type-checked without
the full cli workspace installed. The stub mirrors the runtime's
public export list (all types resolve to `any`, all values are
declared as `any`) — the runtime injects real types when an extension
is loaded inside the host.

Run this whenever the runtime's public surface changes:

    python3 subpackage/sdk/scripts/regen-stubs.py

The script reads `subpackage/cli/packages/coding-agent/src/index.ts`
and writes `subpackage/sdk/vendor/core.d.ts`. It does NOT modify any
runtime source.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # subpackage/
RUNTIME_INDEX = REPO_ROOT / "cli/packages/coding-agent/src/index.ts"
STUB_OUT = REPO_ROOT / "sdk/vendor/core.d.ts"

HEADER = """\
// Type stub for @agentboster-cli/core.
//
// This stub mirrors the public export list of the runtime so the SDK
// package type-checks standalone (without the cli workspace installed).
// All types resolve to minimal shapes; the runtime injects real types
// when an extension is loaded inside it.
//
// REGEN INSTRUCTIONS:
//   When the runtime's public surface changes, regenerate this file:
//     python3 subpackage/sdk/scripts/regen-stubs.py
//   (or manually sync against cli/packages/coding-agent/src/index.ts)
//
// Do NOT add real type definitions here — runtime is the source of truth.

"""


def extract_names(src: str) -> tuple[list[str], list[str]]:
    """Return (type_names, value_names) extracted from the runtime index.

    Handles both forms:
      - `export type { A, B, C } from '...'` — block-level type export
      - `export { A, B, type C, D } from '...'` — inline per-item type
    """
    type_names: set[str] = set()
    value_names: set[str] = set()

    # Form 1: export type { ... } — entire block is types
    for m in re.finditer(r"export\s+type\s*\{([^}]+)\}", src):
        for raw in m.group(1).split(","):
            item = raw.strip()
            if not item:
                continue
            m2 = re.match(
                r"([A-Za-z_][A-Za-z0-9_]*)\s*"
                r"(?:as\s+([A-Za-z_][A-Za-z0-9_]*))?",
                item,
            )
            if m2:
                type_names.add(m2.group(2) or m2.group(1))

    # Form 2: export { ... } (no leading `type`) — mixed; per-item `type`
    # prefix marks types, the rest are values
    for m in re.finditer(r"(?<![\w])export\s*\{([^}]+)\}", src):
        body = m.group(1)
        for raw in body.split(","):
            item = raw.strip()
            if not item:
                continue
            m2 = re.match(
                r"(?:type\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*"
                r"(?:as\s+([A-Za-z_][A-Za-z0-9_]*))?",
                item,
            )
            if not m2:
                continue
            local_name = m2.group(2) or m2.group(1)
            if item.lstrip().startswith("type "):
                type_names.add(local_name)
            else:
                value_names.add(local_name)

    return sorted(type_names), sorted(value_names)


def main() -> int:
    if not RUNTIME_INDEX.exists():
        print(f"error: runtime index not found at {RUNTIME_INDEX}", file=sys.stderr)
        return 1

    src = RUNTIME_INDEX.read_text(encoding="utf-8")
    type_names, value_names = extract_names(src)

    STUB_OUT.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        HEADER,
        "// This file is a module (NOT ambient `declare module`) so that TypeScript",
        "// treats it as the actual module shape when paths maps",
        "// '@agentboster-cli/core' to it. The runtime injects real types at load.",
        "",
    ]
    for n in type_names:
        lines.append(f"export type {n} = any;")
    for n in value_names:
        lines.append(f"export const {n}: any;")
    lines.append("")

    STUB_OUT.write_text("\n".join(lines), encoding="utf-8")
    print(
        f"wrote {STUB_OUT.relative_to(REPO_ROOT)}: "
        f"{len(type_names)} types + {len(value_names)} values"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
