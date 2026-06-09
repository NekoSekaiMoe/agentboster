export type SuggestedFollowUpBlock = {
  questions: string[];
  textWithoutQuestions: string;
};

function stripListMarker(value: string): string {
  return value
    .replace(/^\s*(?:[-*+]|[0-9]{1,2}[.)]|[一二三四五六七八九十][、.])\s*/, '')
    .trim();
}

export function parseSuggestedFollowUps(
  text: string,
): SuggestedFollowUpBlock | null {
  const marker = '你要是愿意';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const beforeMarker = text.slice(0, markerIndex).trimEnd();
  const block = text.slice(markerIndex).trim();
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 4 || !lines[0]?.startsWith(marker)) {
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
