import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir, VERSION } from '../config.ts';

const MAX_CRASH_RECORDS = 5;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export interface CrashRecord {
  timestamp: string;
  version: string;
  kind: string;
  message: string;
  stack: string | null;
  sessionFile: string | null;
  cwd: string;
  notified?: boolean;
}

export interface CrashInput {
  kind: string;
  error: unknown;
  sessionFile?: string;
  cwd: string;
}

function crashLogPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'crashes.json');
}

/**
 * Read crash records with string timestamps and messages; other fields are
 * not validated. Returns an empty array for unreadable or invalid JSON logs
 * and non-array contents. Defaults to crashes.json in the agent directory.
 */
export function readCrashLog(path = crashLogPath()): CrashRecord[] {
  try {
    const records: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(records)
      ? records.filter(
          (record): record is CrashRecord =>
            typeof record === 'object' &&
            record !== null &&
            typeof (record as CrashRecord).timestamp === 'string' &&
            typeof (record as CrashRecord).message === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function writeCrashLog(records: CrashRecord[], path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
}

function normalizeStackPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '');
}

function stackContainsPath(
  stack: string,
  targetPath: string,
  includeDescendants: boolean,
): boolean {
  const target = normalizeStackPath(targetPath);
  if (!target || target.startsWith('<')) return false;
  const caseInsensitive = /^[a-z]:\//iu.test(target);
  const haystack = caseInsensitive ? stack.toLowerCase() : stack;
  const needle = caseInsensitive ? target.toLowerCase() : target;
  if (includeDescendants) return haystack.includes(`${needle}/`);
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const next = haystack[index + needle.length];
    if (
      next === undefined ||
      next === ':' ||
      next === ')' ||
      /\s/u.test(next)
    ) {
      return true;
    }
    index = haystack.indexOf(needle, index + needle.length);
  }
  return false;
}

/**
 * Find loaded extensions with source files in a stack trace (pi 0.87.0).
 * Returns unique package sources or extension paths in extension order, using
 * `at` frames after the first line. Package and directory entries also match
 * descendant files. Missing stacks return an empty array.
 */
export function findExtensionStackMatches(
  stack: string | undefined,
  extensions: ReadonlyArray<{
    path: string;
    resolvedPath: string;
    sourceInfo: { source: string; origin?: string; baseDir?: string };
  }>,
): string[] {
  if (!stack) return [];
  const normalizedStack = stack
    .split('\n')
    .slice(1)
    .filter((line) => /^\s+at\s/u.test(line))
    .map((line) => {
      try {
        return decodeURI(line);
      } catch {
        return line;
      }
    })
    .join('\n')
    .replace(/\\/g, '/');
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const extension of extensions) {
    const resolvedPath = normalizeStackPath(extension.resolvedPath);
    const singleFilePackage =
      extension.sourceInfo.origin === 'package' &&
      !/^(?:npm:|git:|https?:\/\/|ssh:\/\/)/u.test(
        extension.sourceInfo.source,
      ) &&
      /\.[cm]?[jt]s$/u.test(extension.sourceInfo.source);
    const packageRoot =
      extension.sourceInfo.origin === 'package' &&
      !singleFilePackage &&
      extension.sourceInfo.baseDir
        ? extension.sourceInfo.baseDir
        : undefined;
    const slashIndex = resolvedPath.lastIndexOf('/');
    const directoryEntry = /\/index\.[cm]?[jt]s$/u.test(resolvedPath);
    const matched = packageRoot
      ? stackContainsPath(normalizedStack, packageRoot, true)
      : directoryEntry && slashIndex !== -1
        ? stackContainsPath(
            normalizedStack,
            resolvedPath.slice(0, slashIndex),
            true,
          )
        : stackContainsPath(normalizedStack, resolvedPath, false);
    if (!matched) continue;
    const label =
      extension.sourceInfo.origin === 'package' && extension.sourceInfo.source
        ? extension.sourceInfo.source
        : extension.path;
    if (!seen.has(label)) {
      seen.add(label);
      matches.push(label);
    }
  }
  return matches;
}

/**
 * Persist a crash while retaining the last five records in append order.
 * Returns the saved record, or undefined if record creation or writing fails.
 * An unreadable existing log is treated as empty; parent directories are created.
 */
export function recordCrash(
  crash: CrashInput,
  path = crashLogPath(),
): CrashRecord | undefined {
  try {
    const { error } = crash;
    const record: CrashRecord = {
      timestamp: new Date().toISOString(),
      version: VERSION,
      kind: crash.kind,
      message:
        error instanceof Error ? error.message || error.name : String(error),
      stack: error instanceof Error && error.stack ? error.stack : null,
      sessionFile: crash.sessionFile ?? null,
      cwd: crash.cwd,
    };
    writeCrashLog(
      [...readCrashLog(path), record].slice(-MAX_CRASH_RECORDS),
      path,
    );
    return record;
  } catch {
    return undefined;
  }
}

/**
 * Return the last unnotified record whose age is at most seven days, or
 * undefined if none qualifies. Attempts to mark all pending records notified;
 * write failures are ignored, so the same crash may be returned again.
 * @param now Current time in milliseconds since the Unix epoch.
 */
export function takeUnnotifiedCrash(
  path = crashLogPath(),
  now = Date.now(),
): CrashRecord | undefined {
  const records = readCrashLog(path);
  const crash = [...records]
    .reverse()
    .find(
      (record) =>
        !record.notified && now - Date.parse(record.timestamp) <= MAX_AGE,
    );
  if (!crash) return undefined;
  try {
    writeCrashLog(
      records.map((record) =>
        record.notified ? record : { ...record, notified: true },
      ),
      path,
    );
  } catch {
    // Showing the notice again is harmless.
  }
  return crash;
}

/** Remove the crash log if present, ignoring filesystem failures. */
export function clearCrashLog(path = crashLogPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The records can be attached again if cleanup fails.
  }
}
