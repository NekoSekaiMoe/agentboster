/**
 * CSV field encoder shared by the config download routes
 * (audit-logs/download and traces/download — previously duplicated
 * verbatim in both).
 * - empty/null stays an empty string;
 * - values containing commas, quotes or newlines are quoted with `"` escaped;
 * - values starting with =, +, -, or @ get a leading apostrophe so spreadsheet
 *   apps do not evaluate them as formulas (CSV injection).
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
