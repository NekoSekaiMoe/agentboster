# Security Policy

AgentBoster is pre-1.0, but security reports are still handled privately.

## Reporting a Vulnerability

Please report suspected vulnerabilities through GitHub Security Advisories for this repository. If that is unavailable, contact the maintainer privately before publishing details.

Include:

- Affected component: Web, daemon, bot adapter, workflow, sandbox, auth, or vault.
- Reproduction steps and expected impact.
- Whether the issue exposes credentials, user data, host files, sandbox escape, authorization bypass, or remote code execution.
- Any logs or payloads needed to reproduce, with secrets redacted.

## Scope

High-priority areas:

- Auth, roles, and owner/root grant paths.
- `/api/agentd/v1/*` daemon-authenticated endpoints.
- L0/L1/L2 gatekeeper decisions and L2 cache scope.
- Sandbox escape or host filesystem access.
- Vault encryption, key handling, and audit behavior.
- Bot webhook authentication and callback payload handling.

## Disclosure

Please wait for confirmation and a fix window before public disclosure. We will coordinate remediation notes when a patch is available.
