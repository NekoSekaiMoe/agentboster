#!/usr/bin/env python3
"""Drift detector for the agentd SDK surface.

Scans `subpackage/agentd/internal/clawless/types.go` (and the other
Go source files the SDK ports from) for `type X struct` declarations,
then compares that set against the SDK's hand-ported allowlist in
`src/agentd/.source-allowlist`. Reports:

  - NEW: Go structs that exist in source but are NOT in the allowlist
    (candidates to port — review and either port + add to allowlist,
    or leave unported and add to the skip list with a reason).
  - GONE: allowlist entries that no longer exist in source (stale SDK
    ports — clean up the corresponding TS module).

The allowlist lives at `src/agentd/.source-allowlist` as a plain text
file with one `StructName  # short reason` per line. Blank lines and
`#`-prefixed lines are ignored.

This script does NOT modify any source file. It exits non-zero when
drift is detected so it can be wired into CI.

Usage:
    python3 subpackage/sdk/scripts/regen-agentd.py [--allowlist PATH]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # subpackage/
SDK_ROOT = Path(__file__).resolve().parent.parent           # sdk/

# Go source files the agentd surface ports from.
GO_SOURCES = [
    REPO_ROOT / "agentd/internal/clawless/types.go",
    REPO_ROOT / "agentd/internal/clawless/l1_client.go",
    REPO_ROOT / "agentd/internal/agent/manager.go",
    REPO_ROOT / "agentd/internal/agent/tools.go",
    REPO_ROOT / "agentd/internal/server/exec_stream.go",
    REPO_ROOT / "agentd/internal/server/routes.go",
    REPO_ROOT / "agentd/internal/sandbox/manager.go",
    REPO_ROOT / "agentd/internal/lifecycle/lifecycle.go",
    REPO_ROOT / "agentd/internal/metrics/metrics.go",
]

DEFAULT_ALLOWLIST = SDK_ROOT / "src/agentd/.source-allowlist"

STRUCT_RE = re.compile(r"type\s+([A-Z][A-Za-z0-9_]*)\s+struct\b")


def collect_go_structs() -> dict[str, Path]:
    """Return {struct_name: source_path} for all Go structs in scope."""
    out: dict[str, Path] = {}
    for path in GO_SOURCES:
        if not path.exists():
            continue
        src = path.read_text(encoding="utf-8")
        for m in STRUCT_RE.finditer(src):
            name = m.group(1)
            # First occurrence wins; report duplicates as a warning.
            if name in out:
                print(
                    f"warning: struct {name} declared in multiple files "
                    f"({out[name].name} and {path.name}); using first",
                    file=sys.stderr,
                )
                continue
            out[name] = path
    return out


def read_allowlist(path: Path) -> set[str]:
    """Read the allowlist file. Returns the set of struct names."""
    names: set[str] = set()
    if not path.exists():
        return names
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        names.add(line)
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allowlist",
        type=Path,
        default=DEFAULT_ALLOWLIST,
        help="Path to the .source-allowlist file",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="Just list all Go structs in scope and exit",
    )
    args = parser.parse_args()

    go_structs = collect_go_structs()

    if args.list:
        for name in sorted(go_structs):
            print(f"{name}\t{go_structs[name].relative_to(REPO_ROOT)}")
        return 0

    allowlist = read_allowlist(args.allowlist)

    if not allowlist:
        print(
            f"warning: allowlist {args.allowlist} is empty or missing — "
            "every Go struct will report as NEW",
            file=sys.stderr,
        )

    new_structs = sorted(set(go_structs) - allowlist)
    gone_entries = sorted(allowlist - set(go_structs))

    if not new_structs and not gone_entries:
        print(
            f"agentd SDK surface in sync: {len(allowlist)} allowlisted, "
            f"{len(go_structs)} Go structs in scope."
        )
        return 0

    print("agentd SDK surface drift detected:")
    if new_structs:
        print(f"\n  NEW (Go structs not in SDK allowlist) — {len(new_structs)}:")
        for name in new_structs:
            src = go_structs[name].relative_to(REPO_ROOT)
            print(f"    + {name}  ({src})")
        print(
            "\n    Action: port to src/agentd/<module>.ts and add to "
            ".source-allowlist, OR document skip reason in the allowlist."
        )

    if gone_entries:
        print(f"\n  GONE (allowlist entries no longer in Go source) — "
              f"{len(gone_entries)}:")
        for name in gone_entries:
            print(f"    - {name}")
        print(
            "\n    Action: remove the matching TS export from "
            "src/agentd/ and drop the allowlist entry."
        )

    return 1


if __name__ == "__main__":
    sys.exit(main())
