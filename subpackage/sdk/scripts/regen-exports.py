#!/usr/bin/env python3
"""Generate SDK src/index.ts explicit export list from the runtime's exports.

We don't use `export *` because that prevents the SDK from type-checking
standalone (it requires the runtime's source to be available wherever
the SDK is consumed). Instead we list every export explicitly —
identical names, same source — so the SDK is a curated mirror that
type-checks against the type stub in vendor/core.d.ts.

Run after `regen-stubs.py` whenever the runtime's public surface changes:

    python3 subpackage/sdk/scripts/regen-exports.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SDK_ROOT = Path(__file__).resolve().parent.parent
STUB_PATH = SDK_ROOT / "vendor/core.d.ts"
INDEX_PATH = SDK_ROOT / "src/cli/index.ts"

HEADER = """\
/**
 * @agentboster/sdk — public surface for building agentboster extensions,
 * skills, prompts, themes, and programmatic agent sessions.
 *
 * This package is a curated re-export of `@agentboster-cli/core` (the
 * runtime). When an extension is loaded inside the runtime, the host
 * injects the real `@agentboster-cli/core` via a virtual-module alias,
 * so every type and value declared by the runtime flows through
 * automatically. There is no separate SDK implementation to drift out
 * of sync.
 *
 * Exports are listed explicitly (rather than `export *`) so the SDK can
 * type-check standalone against the minimal stub in `vendor/core.d.ts`.
 * To regenerate this file after a runtime change:
 *
 *     python3 subpackage/sdk/scripts/regen-stubs.py
 *     python3 subpackage/sdk/scripts/regen-exports.py
 *
 * @example Minimal extension
 * ```ts
 * import { Type } from 'typebox';
 * import type { ExtensionAPI } from '@agentboster/sdk';
 *
 * export default function (pi: ExtensionAPI): void {
 *   pi.registerTool({
 *     name: 'hello',
 *     label: 'Hello',
 *     description: 'Say hello to someone.',
 *     parameters: Type.Object({ name: Type.Optional(Type.String()) }),
 *     async execute(_id, params) {
 *       return {
 *         content: [{ type: 'text', text: `Hello, ${params.name ?? 'world'}!` }],
 *       };
 *     },
 *   });
 * }
 * ```
 *
 * See `examples/` for complete working extensions.
 *
 * @packageDocumentation
 */

// ── Full runtime re-export (explicit; regen via scripts/regen-exports.py) ──
// We don't use `export *` so the SDK type-checks standalone against
// vendor/core.d.ts. When the runtime adds an export, regenerate this file.

"""


def main() -> int:
    if not STUB_PATH.exists():
        print(
            f"error: stub not found at {STUB_PATH}; run regen-stubs.py first",
            file=sys.stderr,
        )
        return 1

    stub = STUB_PATH.read_text(encoding="utf-8")
    type_names = re.findall(r"export type (\w+) =", stub)
    value_names = re.findall(r"export const (\w+):", stub)

    lines = [HEADER]
    if type_names:
        lines.append("export type {")
        for n in type_names:
            lines.append(f"  {n},")
        lines.append("} from '@agentboster-cli/core';")
        lines.append("")
    if value_names:
        lines.append("export {")
        for n in value_names:
            lines.append(f"  {n},")
        lines.append("} from '@agentboster-cli/core';")
        lines.append("")

    # Compat helpers (SDK-only)
    lines.append("// ── SDK-only compatibility helpers ──────────────────────────────")
    lines.append("export { resolveModelApiKey } from '../compat.js';")
    lines.append("")

    INDEX_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(
        f"wrote {INDEX_PATH.relative_to(SDK_ROOT.parent.parent)}: "
        f"{len(type_names)} types + {len(value_names)} values"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
