import { LEGACY_FOLLOWUP_MARKER } from './follow-up-template';

export type SuggestedFollowUpBlock = {
  questions: string[];
  textWithoutQuestions: string;
};

function stripListMarker(value: string): string {
  return value
    .replace(/^\s*(?:[-*+]|[0-9]{1,2}[.)]|[一二三四五六七八九十][、.])\s*/, '')
    .trim();
}

function splitCustomOptions(line: string): string[] | null {
  const candidates: string[][] = [
    ['【', '】'],
    ['[', ']'],
    ['（', '）'],
    ['(', ')'],
    ['{', '}'],
  ];

  for (const [open, close] of candidates) {
    const re = new RegExp(
      `${escapeRegExp(open)}([^${escapeRegExp(open)}${escapeRegExp(close)}]+?)${escapeRegExp(close)}`,
      'g',
    );
    const matches = [...line.matchAll(re)].map((m) => m[1].trim());
    if (matches.length === 3 && matches.every((m) => m.length > 0)) {
      return matches;
    }
  }

  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tolerant marker matchers. The producer emits `@@FOLLOWUP_START@@` /
 * `@@FOLLOWUP_END@@`, but models in the wild frequently drop or add `@`
 * characters (e.g. `@@FOLLOWUP_START@`, `@@@FOLLOWUP_START@@@`). Using `@+`
 * tolerates any non-zero run of `@` so neither shortage nor surplus defeats
 * parsing or stripping.
 */
const START_MARKER_RE = /@+FOLLOWUP_START@+/;
const END_MARKER_RE = /@+FOLLOWUP_END@+/;
const ANY_MARKER_G_RE = /@+FOLLOWUP_(?:START|END)@+/g;

function parseCustomMarkerBlock(text: string): SuggestedFollowUpBlock | null {
  const startMatch = START_MARKER_RE.exec(text);
  if (!startMatch) {
    return null;
  }

  const afterStart = startMatch.index + startMatch[0].length;
  const endMatch = END_MARKER_RE.exec(text);
  if (!endMatch || endMatch.index < afterStart) {
    return null;
  }

  const beforeMarker = text.slice(0, startMatch.index).trimEnd();
  const inner = text.slice(afterStart, endMatch.index).trim();

  const lines = inner
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  let questions: string[] | null = null;

  if (lines.length >= 3) {
    const listItems = lines.slice(0, 3).map(stripListMarker).filter(Boolean);
    if (listItems.length === 3) {
      questions = listItems;
    }
  }

  if (!questions) {
    questions = splitCustomOptions(lines[0]);
  }

  if (questions?.length !== 3) {
    return null;
  }

  return {
    questions,
    textWithoutQuestions: beforeMarker,
  };
}

function parseLegacyMarkerBlock(text: string): SuggestedFollowUpBlock | null {
  const markerIndex = text.lastIndexOf(LEGACY_FOLLOWUP_MARKER);
  if (markerIndex < 0) {
    return null;
  }

  const beforeMarker = text.slice(0, markerIndex).trimEnd();
  const block = text.slice(markerIndex).trim();
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 4 || !lines[0]?.startsWith(LEGACY_FOLLOWUP_MARKER)) {
    return null;
  }

  const questions = lines.slice(1).map(stripListMarker).filter(Boolean);

  if (questions.length !== 3) {
    return null;
  }

  return {
    questions,
    textWithoutQuestions: [beforeMarker, lines[0]].filter(Boolean).join('\n\n'),
  };
}

export function parseSuggestedFollowUps(
  text: string,
): SuggestedFollowUpBlock | null {
  return parseCustomMarkerBlock(text) ?? parseLegacyMarkerBlock(text);
}

const STRIP_MARKER_BLOCK_G_RE = new RegExp(
  `${START_MARKER_RE.source}[\\s\\S]*?${END_MARKER_RE.source}`,
  'g',
);

/**
 * Best-effort strip of any follow-up marker block from text, used as a fallback
 * when {@link parseSuggestedFollowUps} fails (e.g. malformed block, partial
 * output). Removes the whole `MARKER_START ... MARKER_END` span first, then any
 * leftover bare marker tokens, finally trims trailing whitespace. Tolerates
 * models dropping a `@` (matches `@{1,2}` on each side).
 */
export function stripFollowUpMarkers(text: string): string {
  if (!text) return text;
  const stripped = text
    .replace(STRIP_MARKER_BLOCK_G_RE, '')
    .replace(ANY_MARKER_G_RE, '');
  return stripped.trim() === '' ? text : stripped.trim();
}
