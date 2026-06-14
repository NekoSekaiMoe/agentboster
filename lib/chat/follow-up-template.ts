export type FollowUpTemplate = {
  title: string;
  format: string;
};

export const FOLLOWUP_MARKER_START = '__FOLLOWUP_START__';
export const FOLLOWUP_MARKER_END = '__FOLLOWUP_END__';

export const LEGACY_FOLLOWUP_MARKER = '你要是愿意';

const FOLLOWUP_BLOCK_RE = /```followup\s*\n([\s\S]*?)\n```/;
const TITLE_LINE_RE = /^title:\s*(.+?)\s*$/m;
const FORMAT_LINE_RE = /^format:\s*(.+?)\s*$/m;
const PLACEHOLDER_RE = /\{[012]\}/g;

export function parseFollowUpTemplate(
  soulContent: string,
): FollowUpTemplate | null {
  if (!soulContent) {
    return null;
  }

  const blockMatch = FOLLOWUP_BLOCK_RE.exec(soulContent);
  if (!blockMatch?.[1]) {
    return null;
  }

  const body = blockMatch[1];
  const titleMatch = TITLE_LINE_RE.exec(body);
  const formatMatch = FORMAT_LINE_RE.exec(body);
  if (!titleMatch?.[1] || !formatMatch?.[1]) {
    return null;
  }

  const title = titleMatch[1].trim();
  const format = formatMatch[1].trim();

  const placeholders = format.match(PLACEHOLDER_RE) ?? [];
  const seen = new Set<string>();
  for (const p of placeholders) {
    seen.add(p);
  }
  if (!seen.has('{0}') || !seen.has('{1}') || !seen.has('{2}')) {
    return null;
  }

  return { title, format };
}

export function renderFollowUpInstruction(
  template: FollowUpTemplate,
): string[] {
  const sample = template.format
    .replace('{0}', '<a concise follow-up option>')
    .replace('{1}', '<a concise follow-up option>')
    .replace('{2}', '<a concise follow-up option>');

  return [
    `After fully answering the user, append a short follow-up suggestion block at the very end of your final assistant answer, using the user's custom template titled "${template.title}".`,
    `Render exactly three follow-up options by substituting the placeholders \`{0}\`, \`{1}\`, and \`{2}\` in this template with one concise option each:`,
    '',
    `\`${template.format}\``,
    '',
    'Wrap the rendered block between these two marker lines so it can be parsed:',
    '',
    `${FOLLOWUP_MARKER_START}`,
    '<the rendered template on a single line>',
    `${FOLLOWUP_MARKER_END}`,
    '',
    `Example output shape:`,
    '',
    `${FOLLOWUP_MARKER_START}`,
    sample,
    `${FOLLOWUP_MARKER_END}`,
    '',
    'The three options must be useful continuations for the just-finished answer. Do not add any text after the closing marker.',
  ];
}
