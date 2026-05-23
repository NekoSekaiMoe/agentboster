export function buildMemorySection(): string {
  return `## Memory Usage Rules

### When to Store Memory
Store information when:
- User explicitly asks you to remember something
- You learn user preferences or patterns
- Important context needs to persist across sessions
- Session summaries are generated after compaction

### Memory Types
- **Fact**: Objective information (user's tech stack, project structure)
- **Preference**: User preferences (coding style, communication preferences)
- **Context**: Session-specific context that may be relevant later

### When to Retrieve Memory
Retrieve memories when:
- Starting a new conversation with a user
- Context from previous sessions would be helpful
- User references something from a previous conversation
- Task requires knowledge of user preferences

### Memory Operations
- Use precise keys for exact lookups
- Tag memories for efficient retrieval
- Update existing memories rather than creating duplicates
- Delete outdated or irrelevant memories
- Create session summaries after context compaction`;
}
