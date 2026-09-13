import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { ensureTrailingNewline } from './session-manager.ts';

const tempDir = mkdtempSync(join(tmpdir(), 'session-newline-test-'));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('ensureTrailingNewline (pi #8345)', () => {
  it('appends a newline when the file does not end with one', () => {
    const file = join(tempDir, 'truncated.jsonl');
    writeFileSync(file, '{"type":"session"}'); // no trailing \n
    ensureTrailingNewline(file);
    expect(readFileSync(file, 'utf-8')).toBe('{"type":"session"}\n');
  });

  it('is a no-op when the file already ends with a newline', () => {
    const file = join(tempDir, 'ok.jsonl');
    writeFileSync(file, '{"a":1}\n{"b":2}\n');
    ensureTrailingNewline(file);
    expect(readFileSync(file, 'utf-8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('is a no-op for empty files', () => {
    const file = join(tempDir, 'empty.jsonl');
    writeFileSync(file, '');
    ensureTrailingNewline(file);
    expect(readFileSync(file, 'utf-8')).toBe('');
  });
});
