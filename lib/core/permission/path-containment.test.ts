import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalizeWithExistingAncestor,
  classifyPath,
  normalizeLexical,
} from './path-containment';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ab-path-containment-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('normalizeLexical', () => {
  it('resolves dots and dot-dots without touching the filesystem', () => {
    expect(normalizeLexical('/workspace', 'sub/../evil')).toBe(
      '/workspace/evil',
    );
    // Two dot-dots from /workspace/sub escape the root entirely.
    expect(normalizeLexical('/workspace', 'sub/../../evil')).toBe('/evil');
  });
});

describe('classifyPath', () => {
  it('classifies a plain workspace path', () => {
    const c = classifyPath({ workspaceRoot: root, input: 'src/main.ts' });
    expect(c.root).toBe('workspace');
    expect(c.resolved).toBe(path.join(root, 'src/main.ts'));
  });

  it('catches lexical escapes even when intermediate dirs do not exist', () => {
    const c = classifyPath({
      workspaceRoot: root,
      input: 'no/such/dir/../../../../evil',
    });
    expect(c.root).toBe('external');
  });

  it('rejects null bytes', () => {
    expect(classifyPath({ workspaceRoot: root, input: 'a\0b' }).root).toBe(
      'external',
    );
  });

  it('preserves a non-existing tail on the resolved path', () => {
    const c = classifyPath({ workspaceRoot: root, input: 'new/dir/file.txt' });
    expect(c.resolved.endsWith(path.join('new', 'dir', 'file.txt'))).toBe(true);
  });

  it('follows a symlink that points outside the workspace → external', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'ab-outside-'));
    try {
      symlinkSync(outside, path.join(root, 'escape'));
      const c = classifyPath({ workspaceRoot: root, input: 'escape/file' });
      expect(c.root).toBe('external');
      expect(c.resolved).toBe(path.join(outside, 'file'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps a workspace-internal symlink as workspace', () => {
    mkdirSync(path.join(root, 'real'));
    writeFileSync(path.join(root, 'real', 'f.txt'), 'x');
    symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
    const c = classifyPath({ workspaceRoot: root, input: 'alias/f.txt' });
    expect(c.root).toBe('workspace');
  });

  it('classifies scratch-dir paths separately (scratch outside the workspace)', () => {
    // Note: a scratch dir nested INSIDE the workspace root classifies as
    // workspace — layer 2 checks the workspace root first. A separate
    // scratch area must live outside it (piwork semantics).
    const scratch = mkdtempSync(path.join(tmpdir(), 'ab-scratch-'));
    try {
      const c = classifyPath({
        workspaceRoot: root,
        scratchDir: scratch,
        input: path.join(scratch, 'tmp.out'),
      });
      expect(c.root).toBe('scratch');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('a scratch symlink pointing outside is still external', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'ab-outside2-'));
    const scratch = path.join(root, '.scratch');
    mkdirSync(scratch);
    symlinkSync(outside, path.join(scratch, 'hole'));
    try {
      const c = classifyPath({
        workspaceRoot: root,
        scratchDir: scratch,
        input: path.join(scratch, 'hole', 'x'),
      });
      expect(c.root).toBe('external');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('canonicalizeWithExistingAncestor', () => {
  it('resolves the deepest existing ancestor and appends the tail', () => {
    mkdirSync(path.join(root, 'a'));
    const deepestExisting = path.join(root, 'a');
    const result = canonicalizeWithExistingAncestor(
      path.join(deepestExisting, 'b', 'c.txt'),
    );
    const real = canonicalizeWithExistingAncestor(deepestExisting);
    expect(result).toBe(path.join(real, 'b', 'c.txt'));
  });

  it('returns the input unchanged when nothing can be canonicalized', () => {
    expect(canonicalizeWithExistingAncestor('/definitely/not/there')).toBe(
      '/definitely/not/there',
    );
  });
});
