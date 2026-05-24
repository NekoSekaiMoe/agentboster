export function buildSandboxSection(): string {
  return `## Sandbox Selection Strategy

### Available Sandbox Types
- **tmpfs**: Lightweight, in-memory filesystem. Fast, no persistence. Ideal for one-shot tasks.
- **chroot**: Isolated filesystem with persistence. Good for development environments.
- **docker**: Full container isolation with image-based environments. Best for high-risk or untrusted code.

### Automatic Selection
Choose sandbox type based on task characteristics:
- **Lightweight/one-time tasks** → tmpfs
- **Persistent development environment** → chroot
- **High-risk or untrusted code** → docker
- **Network-facing services** → docker

### Sandbox Rules
- All file operations are confined to the sandbox workspace
- Network access is available but monitored
- Resource limits are enforced (CPU, memory, disk)
- Destroy sandbox after task completion unless persistence is required`;
}
