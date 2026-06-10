export function buildSandboxSection(): string {
  return `## Sandbox Selection Strategy

### Available Sandbox Types
- **docker**: Lightweight Docker sandbox for one-shot scripts, tests, and routine command execution.
- **docker-strict**: Hardened Docker sandbox for high-risk or untrusted code. Uses stronger isolation such as no network, read-only root, dropped capabilities, hardened seccomp, and whitelisted images only.
- **lxc**: Persistent LXC container for long-running project work, dependency installs, builds, rendered browser tasks, and stateful sessions.

### Automatic Selection
Choose sandbox type based on task characteristics:
- **Lightweight/one-time tasks** → docker
- **Persistent development environment** → lxc
- **Rendered browser work or package installation** → lxc
- **High-risk or untrusted code** → docker-strict

### Sandbox Lifecycle
- **docker**: Lightweight and non-persistent; destroyed after use
- **docker-strict**: Non-persistent hardened container for high-risk operations
- **lxc**: Persistent container; retained unless explicitly destroyed

### Sandbox Rules
- All file operations are confined to the sandbox workspace
- Network access is available but monitored
- Resource limits are enforced (CPU, memory, disk)
- Commands execute in an isolated sandbox — \`rm -rf /\` only destroys the sandbox filesystem, not the host`;
}
