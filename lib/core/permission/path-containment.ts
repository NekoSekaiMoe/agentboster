/**
 * Path containment — two-layer resolver shared by permission evaluation AND
 * execution.
 *
 * Ported from ref/piwork `packages/permissions/src/path-containment.ts`
 * (Apache-2.0), itself ported from vastsa's workspace.rs.
 *
 * Layer 1 (lexical): normalize the input against the workspace root without
 * touching the filesystem, so `sub/../../evil` is caught even when
 * intermediate directories do not exist.
 * Layer 2 (symlink-aware): canonicalize the deepest EXISTING ancestor with
 * realpath, then re-append the non-existing tail. A permission prompt and
 * the eventual execution MUST resolve through the same function so symlink
 * behavior cannot change after a grant (TOCTOU).
 *
 * NOTE: this module uses top-level `node:fs` / `node:path` imports and must
 * NEVER be statically imported from `lib/workflow/**` (the workflow DevKit
 * bundler fails the whole build on top-level node:* imports — see AGENTS.md).
 * Consumers belong in route handlers, CLI, or agentd adapters.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionPathRoot } from './types';

export interface PathClassification {
  /** Absolute, symlink-aware resolved path (tail may not exist yet). */
  resolved: string;
  root: PermissionPathRoot;
}

function compareKey(value: string): string {
  // Windows component comparison is case-insensitive.
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(compareKey(parent), compareKey(child));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/** Pure lexical normalization: resolve `.`/`..` against root without fs access. */
export function normalizeLexical(root: string, input: string): string {
  return path.normalize(path.resolve(root, input));
}

function realpath(target: string): string {
  const native = fs.realpathSync.native ?? fs.realpathSync;
  return native(target);
}

/**
 * Canonicalize the deepest existing ancestor and re-append the missing tail.
 * Returns the input unchanged when no ancestor can be canonicalized (e.g.
 * permission errors) — callers then fail closed via the containment check.
 */
export function canonicalizeWithExistingAncestor(absolutePath: string): string {
  let current = absolutePath;
  const tail: string[] = [];
  for (;;) {
    try {
      const canonical = realpath(current);
      return tail.length === 0 ? canonical : path.join(canonical, ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolutePath;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function canonicalRoot(root: string): string {
  try {
    return realpath(root);
  } catch {
    return path.normalize(root);
  }
}

/**
 * Classify `input` (relative or absolute) as workspace / scratch / external.
 * `workspaceRoot` is the session cwd; `scratchDir` is the optional
 * per-session scratch area that writes may use without prompting (execution
 * still goes through this same resolver).
 */
export function classifyPath(options: {
  workspaceRoot: string;
  scratchDir?: string;
  input: string;
}): PathClassification {
  const { workspaceRoot, scratchDir, input } = options;
  if (!workspaceRoot || !input || input.includes('\0')) {
    return { resolved: '', root: 'external' };
  }

  // Layer 1: lexical containment fast check. A lexical escape can never be
  // re-contained by canonicalization, so classify it external immediately.
  const lexical = normalizeLexical(workspaceRoot, input);
  const lexicalWorkspace = path.normalize(workspaceRoot);
  const lexicalScratch = scratchDir ? path.normalize(scratchDir) : undefined;
  const lexicallyContained =
    isWithin(lexicalWorkspace, lexical) ||
    (lexicalScratch ? isWithin(lexicalScratch, lexical) : false);
  if (!lexicallyContained) {
    return {
      resolved: canonicalizeWithExistingAncestor(lexical),
      root: 'external',
    };
  }

  // Layer 2: symlink-aware resolution, compared against canonical roots.
  const resolved = canonicalizeWithExistingAncestor(lexical);
  const workspace = canonicalRoot(workspaceRoot);
  if (isWithin(workspace, resolved)) return { resolved, root: 'workspace' };
  if (lexicalScratch) {
    const scratch = canonicalRoot(lexicalScratch);
    if (isWithin(scratch, resolved)) return { resolved, root: 'scratch' };
  }
  return { resolved, root: 'external' };
}
