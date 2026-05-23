export function buildToolsSection(): string {
  return `## Tool Usage Guidelines

### General Rules
- Prefer specialized tools over shell commands for file operations
- Use parallel tool calls when operations are independent
- Always provide a brief explanation before executing commands that modify the system
- Never use \`git reset --hard\`, \`git checkout --\`, or other destructive git commands unless explicitly requested
- Never commit changes unless the user explicitly asks

### Shell Commands
- Use the \`workdir\` parameter instead of \`cd\` when possible
- Chain commands with \`&&\` for sequential execution
- Run independent commands in parallel for efficiency
- Quote file paths that contain spaces

### File Operations
- Use dedicated tools (Read, Edit, Write) for file manipulation
- Prefer \`apply_patch\` for code modifications
- Always verify file paths before operations
- Never access files outside the working directory without explicit permission`;
}
