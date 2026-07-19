#!/usr/bin/env python3
"""Drift detector for the Web HTTP API surface in subpackage/sdk.

The Web surface (subpackage/sdk/src/web/**) is hand-ported from the Web
tier's source files — unlike the CLI runtime surface, these are real
TypeScript type definitions (not `any` stubs), so this script does NOT
generate them. It only checks that the set of exports the Web tier
declares in its source-of-truth files still matches what the SDK mirrors.

Run it after touching any source file listed in `SOURCE_FILES`:

    python3 subpackage/sdk/scripts/regen-web.py

Exit code:
  0  no drift detected (or only additive — see below)
  1  drift detected (a source export has no SDK mirror; or a mirror
     has no source counterpart)

The script's matching is by **export name only**, not by shape. A
type's fields can still drift silently — field-level diffing is out of
scope (would need a real TS AST walk). Treat this as a name-level
smoke test: it catches "source added a new public type and the SDK
forgot to mirror it", not "source renamed a field".

Additive policy: if the source has exports the SDK doesn't mirror, the
script reports them as MISSING and exits 1. If the SDK has exports the
source doesn't declare, it reports them as STALE but exits 0 (the SDK
is allowed to add helper types not present in the source tier).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# subpackage/sdk/
SDK_ROOT = Path(__file__).resolve().parent.parent
# repo root (subpackage/sdk -> subpackage -> repo root)
REPO_ROOT = SDK_ROOT.parent.parent

# Source-of-truth files in the Web tier. Each entry maps a repo-relative
# path to the SDK module that mirrors it. Drift is reported per pair.
# Add new pairs here when the surface grows.
SOURCE_FILES: list[tuple[str, Path]] = [
    ("lib/auth/session.ts", SDK_ROOT / "src/web/auth.ts"),
    ("lib/auth/pair-code.ts", SDK_ROOT / "src/web/auth.ts"),
    ("lib/extra/auth/types.ts", SDK_ROOT / "src/web/auth.ts"),
    ("lib/cli/schedule-serialization.ts", SDK_ROOT / "src/web/routes.ts"),
    ("lib/cli/remote-control.ts", SDK_ROOT / "src/web/routes.ts"),
    # Routes files only declare zod runtime schemas (no exported TS
    # types), so they are intentionally NOT in this list — the SDK
    # hand-ports their wire shape as interfaces, and there is no
    # exported name for the script to track.
]

# Source exports intentionally NOT mirrored in the SDK. These are either
# runtime helpers (functions, factories) that don't belong in a
# type-only surface, or internal row types whose wire shape the SDK
# hand-ports under a different name. Review this list when the source
# tier changes the corresponding symbol — the type may need to be
# re-imported under its new shape.
#
# Format: bare symbol names. The drift detector skips them when
# computing MISSING (source has, SDK doesn't). They are still printed
# for visibility (as SKIP) so reviewers see them on every run.
INTENTIONALLY_SKIPPED: set[str] = {
    # lib/auth/session.ts
    "getAuthCookieOptions",        # runtime helper (Set-Cookie header builder)
    "getExpiredAuthCookieOptions", # runtime helper
    # lib/cli/schedule-serialization.ts
    "PersistedScheduledTask",      # DB row type; SDK ports wire shape as ScheduleTaskRecord
    "DisplayStatus",               # internal row discriminator; SDK has ScheduleDisplayStatus
    "deriveDisplayStatus",         # runtime helper
    "serializeScheduledTask",      # runtime helper
    # lib/cli/remote-control.ts
    "registerCliListener",         # runtime helper
    "unregisterCliListener",       # runtime helper
    "getCliListener",              # runtime helper
}

# Matches:
#   export interface Foo
#   export type Foo = ...
#   export type Foo = ...   (multi-line OK; we capture only the name)
#   export const Foo
#   export function foo
#   export class Foo
#   export enum Foo
# We capture leading identifier only — generics and `=` are skipped.
EXPORT_RE = re.compile(
    r"""
    ^ \s* export \s+
    (?: default \s+ )?                # optional `default`
    (?: const | let | var | function | class | interface | type | enum )
    \s+
    ([A-Za-z_$][\w$]*)
    """,
    re.MULTILINE | re.VERBOSE,
)


def extract_exports(path: Path) -> set[str]:
    """Return the set of top-level export names declared in `path`.

    Pure regex — does not follow imports or expand re-exports. Good
    enough for the hand-curated source files listed above (each one
    declares its own types inline; none of them re-export from a
    sibling in a way the SDK would need to mirror).
    """
    if not path.exists():
        return set()
    text = path.read_text(encoding="utf-8")
    return {m.group(1) for m in EXPORT_RE.finditer(text)}


def collect_sdk_mirror_names(sdk_module: Path) -> set[str]:
    """Return export names declared in the SDK mirror module.

    Includes names declared via `export interface` / `export type` /
    `export const` directly in the file. Does NOT chase `export * from`
    — the Web surface modules are flat (no re-exports inside the
    surface itself; the barrel is `src/web/index.ts`).
    """
    return extract_exports(sdk_module)


def main() -> int:
    has_drift = False

    print("=" * 72)
    print("Web surface exports — drift report")
    print("=" * 72)

    # Group by SDK module so we can compute one (source_union, sdk_set)
    # diff per mirror file even if multiple source files map to it.
    mirror_to_sources: dict[Path, list[str]] = {}
    for src_rel, sdk_module in SOURCE_FILES:
        mirror_to_sources.setdefault(sdk_module, []).append(src_rel)

    for sdk_module, source_rels in mirror_to_sources.items():
        print(f"\n## {sdk_module.relative_to(SDK_ROOT)}")
        source_union: set[str] = set()
        for src_rel in source_rels:
            src_path = REPO_ROOT / src_rel
            names = extract_exports(src_path)
            source_union |= names
            print(f"  source: {src_rel} ({len(names)} exports)")
            for name in sorted(names):
                print(f"    - {name}")

        sdk_names = collect_sdk_mirror_names(sdk_module)
        print(f"  mirror: {sdk_module.relative_to(SDK_ROOT)} ({len(sdk_names)} exports)")

        # Apply allowlist: source exports we've consciously decided not
        # to mirror (helpers, runtime types ported under different names).
        # These are reported as SKIP for visibility but don't count as
        # MISSING — they're intentional omissions, reviewed per change.
        skipped = source_union & INTENTIONALLY_SKIPPED
        missing = source_union - sdk_names - INTENTIONALLY_SKIPPED
        stale = sdk_names - source_union

        if skipped:
            print(f"  SKIP (intentional; see INTENTIONALLY_SKIPPED in script):")
            for name in sorted(skipped):
                print(f"    . {name}")

        if missing:
            has_drift = True
            print(f"  MISSING (source declares, SDK does not mirror):")
            for name in sorted(missing):
                print(f"    ! {name}")
        else:
            print("  MISSING: (none)")

        if stale:
            # STALE is non-fatal: SDK is allowed to add helper types
            # (e.g. ScheduleNodeRouting, ScheduleDisplayStatus,
            # ScheduleTaskType factored out for reuse) that the source
            # tier doesn't export under those exact names.
            print(f"  STALE (SDK-only; allowed for helpers):")
            for name in sorted(stale):
                print(f"    ~ {name}")
        else:
            print("  STALE: (none)")

    print("\n" + "=" * 72)
    if has_drift:
        print("RESULT: DRIFT — add the MISSING exports to the SDK mirror(s).")
        return 1
    print("RESULT: OK — every tracked source export has an SDK mirror.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
