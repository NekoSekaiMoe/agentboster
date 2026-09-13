import { describe, expect, it, vi } from 'vitest';

import { createWriteToolDefinition } from './write.ts';

describe('write tool byte count (pi #8979)', () => {
  it('reports UTF-8 byte length, not UTF-16 code-unit count', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const tool = createWriteToolDefinition('/tmp', {
      operations: { writeFile, mkdir },
    });

    // '你好' is 2 UTF-16 code units but 6 UTF-8 bytes. The tool used to
    // report `content.length` (2) as "bytes".
    const result = await tool.execute(
      'call-1',
      {
        path: 'hello.txt',
        content: '你好',
      },
      undefined,
      undefined,
      undefined as never,
    );

    const text = (result as { content: Array<{ type: string; text?: string }> })
      .content[0]?.text;
    expect(text).toContain('Successfully wrote 6 bytes');
  });

  it('reports ASCII content unchanged', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const tool = createWriteToolDefinition('/tmp', {
      operations: { writeFile, mkdir },
    });

    const result = await tool.execute(
      'call-2',
      {
        path: 'ascii.txt',
        content: 'abcdef',
      },
      undefined,
      undefined,
      undefined as never,
    );

    const text = (result as { content: Array<{ type: string; text?: string }> })
      .content[0]?.text;
    expect(text).toContain('Successfully wrote 6 bytes');
  });
});
