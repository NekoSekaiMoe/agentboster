import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeLocalTool } from './local-security';

describe('executeLocalTool', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads and writes files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboster-cli-'));
    dirs.push(dir);
    const file = join(dir, 'note.txt');

    const write = await executeLocalTool('local_write_file', {
      path: file,
      content: 'hello',
    });
    expect(write.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('hello');

    const read = await executeLocalTool('local_read_file', { path: file });
    expect(read.ok).toBe(true);
    expect(read.output).toBe('hello');
  });

  it('applies a unified diff patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboster-cli-'));
    dirs.push(dir);
    const file = join(dir, 'patch.txt');
    writeFileSync(file, 'one\ntwo\nthree\n', 'utf8');

    const patch = [
      'diff --git a/patch.txt b/patch.txt',
      '--- a/patch.txt',
      '+++ b/patch.txt',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '',
    ].join('\n');

    const result = await executeLocalTool('local_patch_file', {
      path: file,
      patch,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('one\nTWO\nthree\n');
  });
});
