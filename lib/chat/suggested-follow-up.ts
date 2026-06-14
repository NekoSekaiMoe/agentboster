import {
  FOLLOWUP_MARKER_END,
  FOLLOWUP_MARKER_START,
  LEGACY_FOLLOWUP_MARKER,
} from './follow-up-template';

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

function parseCustomMarkerBlock(text: string): SuggestedFollowUpBlock | null {
  const startIdx = text.lastIndexOf(FOLLOWUP_MARKER_START);
  if (startIdx < 0) {
    return null;
  }

  const endIdx = text.indexOf(
    FOLLOWUP_MARKER_END,
    startIdx + FOLLOWUP_MARKER_START.length,
  );
  if (endIdx < 0) {
    return null;
  }

  const beforeMarker = text.slice(0, startIdx).trimEnd();
  const inner = text
    .slice(startIdx + FOLLOWUP_MARKER_START.length, endIdx)
    .trim();

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
