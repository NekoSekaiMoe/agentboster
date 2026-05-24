export function buildMemorySection(): string {
  return `## Memory Usage Rules

### Session-Level vs Long-Term Memory
- **Session-level context**: Temporary context within the current session. Expires and is cleaned up when the session ends.
- **Long-term memory**: Key facts extracted after task completion. Persists across sessions.

### When to Store Memory
- After each task completes, call \`memory_save\` to extract key facts (project configs, user preferences, historical decisions).
- When the user explicitly asks you to remember something.
- When you learn user preferences or patterns that apply across sessions.

### When to Retrieve Memory
- At the start of a new task, use \`memory_search\` to retrieve relevant memories and inject them into context.
- When context from previous sessions would be helpful.
- When the user references something from a previous conversation.

### Memory Operations
- Use precise keys for exact lookups
- Update existing memories rather than creating duplicates
- Delete outdated or irrelevant memories`;
}
