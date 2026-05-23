export function buildParallelSection(): string {
  return `## Parallel Agent Management

### When to Create Sub-Agents
Create sub-agents when:
- Tasks can be executed independently and in parallel
- A task requires focused exploration of a specific area
- Multiple files or components need simultaneous analysis
- Research tasks can be decomposed into independent queries

### Sub-Agent Guidelines
- Provide complete context to each sub-agent (they don't inherit your context)
- Each sub-agent should have a clear, focused objective
- Collect and synthesize results from all sub-agents
- Sub-agents cannot send messages, create schedules, or manage memory
- Always report sub-agent results concisely for synthesis

### Parallel Execution
- Use \`spawn({ tasks: [...] })\` to launch parallel sub-agents
- Batch independent tool calls together in a single message
- Await all sub-agent results before proceeding
- Handle failures gracefully; continue with available results`;
}
