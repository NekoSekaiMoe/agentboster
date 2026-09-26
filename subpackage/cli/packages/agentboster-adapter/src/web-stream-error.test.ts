import { describe, expect, it, vi } from 'vitest';
import { extractErrorChunkText } from './web-stream.ts';

// Root CI does not build the CLI workspaces. Forward to the real source
// implementation so importing web-stream does not require generated dist/.
vi.mock('@agentboster-cli/ai/utils/event-stream', () => {
  // Keep this dynamic so the package build does not emit sibling sources.
  return import(
    new URL('../../ai/src/utils/event-stream.ts', import.meta.url).href
  );
});

describe('extractErrorChunkText (errorText passthrough)', () => {
  it('reads errorText from AI SDK UIMessage error parts', () => {
    // The wire format written by the backend's DurableAgent:
    // node_modules/@workflow/ai/dist/agent/do-stream-step.js maps internal
    // provider stream errors to { type: 'error', errorText } verbatim.
    expect(
      extractErrorChunkText({
        type: 'error',
        errorText: 'prompt is too long: 213462 tokens > 200000 maximum',
      }),
    ).toBe('prompt is too long: 213462 tokens > 200000 maximum');
  });

  it('falls back to message for legacy producers', () => {
    expect(
      extractErrorChunkText({ type: 'error', message: 'legacy text' }),
    ).toBe('legacy text');
  });

  it('prefers errorText when both are present', () => {
    expect(
      extractErrorChunkText({
        type: 'error',
        errorText: 'primary',
        message: 'secondary',
      }),
    ).toBe('primary');
  });

  it('degrades to unknown error for empty or missing text', () => {
    expect(extractErrorChunkText({ type: 'error' })).toBe('unknown error');
    expect(extractErrorChunkText({ type: 'error', errorText: '' })).toBe(
      'unknown error',
    );
    expect(
      extractErrorChunkText({ type: 'error', errorText: 42 as never }),
    ).toBe('unknown error');
  });
});
