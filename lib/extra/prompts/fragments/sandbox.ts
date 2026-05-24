export function buildSandboxSection(): string {
  return `## Sandbox Selection Strategy

### Available Sandbox Types
- **tmpfs**: Lightweight, in-memory filesystem. Fast, optional persistence. Ideal for one-shot tasks.
- **chroot**: Isolated filesystem with persistence. Always persistent. Good for development environments.
- **docker**: Full container isolation with image-based environments. Optional persistence. Best for high-risk or untrusted code. Only whitelisted images are allowed (e.g., \`alpine:latest\`, \`ubuntu:22.04\`).

### Automatic Selection
Choose sandbox type based on task characteristics:
- **Lightweight/one-time tasks** → tmpfs
- **Persistent development environment** → chroot
- **High-risk or untrusted code** → docker
- **Network-facing services** → docker

### tmpfs Dynamic Sizing
The AI evaluates tmpfs size based on task type (light: 15–50 MB, medium: 50–200 MB, heavy: 200–500 MB). The Agent Daemon probes available memory (zram → physical → swap) and determines the final allocation. If space runs low during execution, the daemon auto-expands (up to min(current × 3, available memory × 60%)). If memory is insufficient, the user is notified and can switch to Docker.

### Sandbox Lifecycle
- **tmpfs**: Automatically destroyed after task completion
- **chroot**: Persisted across tasks; retained unless explicitly destroyed
- **docker**: Retained or destroyed on demand

### Sandbox Rules
- All file operations are confined to the sandbox workspace
- Network access is available but monitored
- Resource limits are enforced (CPU, memory, disk)
- Commands execute in an isolated sandbox — \`rm -rf /\` only destroys the sandbox filesystem, not the host`;
}
