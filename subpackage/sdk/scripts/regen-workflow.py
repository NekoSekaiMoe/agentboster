#!/usr/bin/env python3
"""Drift detector for the Workflow DevKit surface in subpackage/sdk.

The SDK mirrors selected types from the Web-tier source-of-truth files
into `src/workflow/`. This script reads the upstream source files,
extracts every `export type` / `export interface` / `export const` /
`export function` name, and compares it against what `src/workflow/`
re-exports. Any name present upstream but missing from the SDK is
reported as drift.

It does NOT modify the SDK source — it only reports. The SDK author
decides whether to add the missing type or pin it as intentionally
out-of-scope.

Run it from the repo root:

    python3 subpackage/sdk/scripts/regen-workflow.py

Exit codes:
    0  no drift (or only intentional omissions)
    1  drift detected — review the report
    2  source files missing — check SOURCE_FILES paths
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# subpackage/sdk/ — this script lives in scripts/, so go up two.
SDK_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = SDK_ROOT.parent.parent

# Upstream source files the Workflow surface mirrors. Relative to REPO_ROOT.
# Add new source files here when the surface grows; the regex below
# handles them automatically.
SOURCE_FILES = [
    "types/workflow.ts",
    "lib/workflow/agent/types/index.ts",
    "lib/workflow/agent/hooks/approvalHook.ts",
    "lib/workflow/agent/hooks/instructionHook.ts",
    "lib/workflow/agent/hooks/localToolHook.ts",
    "lib/workflow/agent/hooks/types.ts",
    "lib/chat/message-utils.ts",
    "lib/workflow/agent/dispatch.ts",
]

# Types/values the SDK intentionally does NOT mirror (out-of-scope for
# the Workflow public surface). When drift reports one of these, leave
# it in this set rather than adding it to the SDK.
INTENTIONAL_OMISSIONS = {
    # types/workflow.ts
    "parseChatSource",
    "isImChatSource",
    "isCliChatSource",
    "getChatSourceFromSessionMetadata",
    "buildExternalThreadId",
    "normalizeMessageText",
    "extractTextFromParts",
    "parseChatInputEnvelope",
    "isCommandName",
    "isWorkflowDataUIPart",
    "isWorkflowMessageUIPart",
    "isWorkflowStatusUIPart",
    "getWorkflowDataAgentName",
    "messageVersionSchema",
    "chatMessageMetadataSchema",
    "workflowMessageDataSchema",
    "workflowStatusDataSchema",
    "workflowDataSchema",
    "chatSourceSchema",
    "chatHookPayloadSchema",
    "toolApprovalPayloadSchema",
    "instructionHookSchema",
    "localToolResultPayloadSchema",
    "runtimeEventPayloadSchema",
    "messagePartSchema",
    # workflow UIDataPart helper types (deep ai-sdk generics)
    "WorkflowUIPart",
    "WorkflowDataUIPart",
    "WorkflowMessageUIPart",
    "WorkflowStatusUIPart",
    "WorkflowUIDataParts",
    # lib/chat/message-utils.ts — large surface, only PersistedMessage*
    # is mirrored. Others are out-of-scope.
    "TOOL_OUTPUT_MAX_CHARS",
    "truncateMiddleText",
    "normalizeToolOutputForPersistence",
    # lib/workflow/agent/dispatch.ts — internal runtime helpers; only
    # the four public resume/start signatures are mirrored as facades.
    "AgentNodeStatus",
    "selectBestNode",
    "requestCompact",
    "getWorkflowRun",
    "canResumeRun",
    "pauseWorkflow",
    "getWorkflowStatus",
    "isAgentdAvailable",
    # dispatch.ts public functions are mirrored as *facades* under
    # SDK-only names (StartWorkflow / ResumeWithMessage / etc.) in
    # src/workflow/dispatch.ts. The function values themselves are
    # runtime-bound (drizzle, workflow/api) and intentionally not
    # re-exported as values from the SDK.
    "startWorkflow",
    "resumeWithMessage",
    "resumeToolApproval",
    "resumeLocalToolResult",
    # lib/chat/message-utils.ts — only PersistedMessage* is mirrored.
    # The serialize* / toModelMessage / toUIMessage / reconstruct*
    # helpers are internal conversion utilities; not part of the
    # workflow public contract.
    "serializeAssistantMessage",
    "serializeSummaryMessage",
    "serializeSystemMessage",
    "serializeToolMessage",
    "serializeUserMessage",
    "serializeWorkflowMessage",
    "toModelMessage",
    "toUIMessage",
    "reconstructUIMessageParts",
    "modelMessagesToPrompt",
    "createTextPart",
    "buildUserParts",
    # lib/workflow/agent/hooks/* — builder values depend on `workflow`.
    "approvalHookBuilder",
    "instructionHookBuilder",
    "localToolResultHookBuilder",
}

# What the SDK actually re-exports. We read the workflow subdirectory's
# declared exports by scanning each `src/workflow/*.ts` for exported
# names. Anything not in this set after the scan is drift.
SDK_WORKFLOW_DIR = SDK_ROOT / "src" / "workflow"

# Names exported by the SDK's workflow surface that don't have a
# 1:1 upstream counterpart (renamed, derived, or facade). Suppress
# "missing upstream" warnings for these.
SDK_ONLY_NAMES = {
    "StartWorkflow",
    "StartWorkflowInput",
    "StartWorkflowOutput",
    "ResumeWithMessage",
    "ResumeWithMessagePayload",
    "ResumeToolApproval",
    "ResumeToolApprovalPayload",
    "ResumeLocalToolResult",
    "ResumeLocalToolResultPayload",
    "ToolApprovalHookPayload",
    "InstructionHookPayload",
    "LocalToolResultHookPayload",
    "RuntimeEventName",  # extracted enum subtype of RuntimeEventPayload
    "BotLocale",
    "AdapterName",
    "WebChatSource",
    "ScheduledChatSource",
    "IMChatSource",
    "CLIChatSource",
    "MessageInputEnvelope",
    "CommandInputEnvelope",
}


def extract_exports(path: Path) -> set[str]:
    """Return the set of top-level exported names in a TS source file.

    Handles:
      export type { A, B } from '...'
      export interface Foo { ... }
      export type Foo = ...
      export function foo(...)
      export const foo = ...
      export class Foo ...
    """
    src = path.read_text(encoding="utf-8")
    names: set[str] = set()

    # Strip block comments so commented-out exports aren't matched.
    src_no_comments = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    src_no_comments = re.sub(r"//[^\n]*", "", src_no_comments)

    # export type Foo = ...
    for m in re.finditer(
        r"^\s*export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\b",
        src_no_comments,
        re.MULTILINE,
    ):
        names.add(m.group(1))

    # export interface Foo
    for m in re.finditer(
        r"^\s*export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)\b",
        src_no_comments,
        re.MULTILINE,
    ):
        names.add(m.group(1))

    # export function foo
    for m in re.finditer(
        r"^\s*export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\b",
        src_no_comments,
        re.MULTILINE,
    ):
        names.add(m.group(1))

    # export const foo / export class Foo
    for m in re.finditer(
        r"^\s*export\s+(?:const|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b",
        src_no_comments,
        re.MULTILINE,
    ):
        names.add(m.group(1))

    # export type { A, B, type C } from '...'  AND
    # export { A, B, type C } from '...'
    for m in re.finditer(
        r"^\s*export\s+(?:type\s+)?\{([^}]+)\}\s*from",
        src_no_comments,
        re.MULTILINE,
    ):
        for raw in m.group(1).split(","):
            item = raw.strip()
            if not item:
                continue
            m2 = re.match(
                r"(?:type\s+)?([A-Za-z_][A-Za-z0-9_]*)",
                item,
            )
            if m2:
                names.add(m2.group(1))

    return names


def main() -> int:
    all_upstream: dict[str, set[str]] = {}
    missing_files: list[str] = []

    for rel in SOURCE_FILES:
        path = REPO_ROOT / rel
        if not path.exists():
            missing_files.append(rel)
            continue
        all_upstream[rel] = extract_exports(path)

    if missing_files:
        print("error: source files not found:", file=sys.stderr)
        for f in missing_files:
            print(f"  {f}", file=sys.stderr)
        return 2

    sdk_names: set[str] = set()
    for path in sorted(SDK_WORKFLOW_DIR.glob("*.ts")):
        sdk_names |= extract_exports(path)

    upstream_union: set[str] = set()
    for names in all_upstream.values():
        upstream_union |= names

    # Drift = upstream names not mirrored by the SDK and not explicitly
    # excluded. We don't flag SDK-only facade names.
    drift = sorted(
        n
        for n in upstream_union
        if n not in sdk_names
        and n not in INTENTIONAL_OMISSIONS
        and n not in SDK_ONLY_NAMES
    )

    # Also report SDK names with no upstream counterpart (helps catch
    # typos / accidental renames). SDK-only facade names are allowed.
    sdk_only = sorted(
        n for n in sdk_names if n not in upstream_union and n not in SDK_ONLY_NAMES
    )

    print("=== Workflow SDK drift report ===")
    print(f"Source files scanned: {len(SOURCE_FILES)}")
    print(f"SDK workflow modules: {len(list(SDK_WORKFLOW_DIR.glob('*.ts')))}")
    print(f"Upstream exports:     {len(upstream_union)}")
    print(f"SDK exports:          {len(sdk_names)}")
    print()

    per_file_counts = " | ".join(
        f"{rel}: {len(names)}" for rel, names in all_upstream.items()
    )
    print(f"Per-file: {per_file_counts}")
    print()

    if drift:
        print("DRIFT — upstream exports missing from SDK:")
        for name in drift:
            # Find which source file declares it.
            owners = [rel for rel, names in all_upstream.items() if name in names]
            print(f"  - {name}  (declared in: {', '.join(owners)})")
        print()

    if sdk_only:
        print("INFO — SDK names with no 1:1 upstream counterpart:")
        for name in sdk_only:
            print(f"  + {name}")
        print()

    if drift:
        print("FAIL: drift detected. Add the missing types to src/workflow/,")
        print("or extend INTENTIONAL_OMISSIONS in scripts/regen-workflow.py.")
        return 1

    print("OK: no drift.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
