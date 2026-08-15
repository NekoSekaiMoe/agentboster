/**
 * CSV field encoder shared by the config download routes
 * (audit-logs/download and traces/download — previously duplicated
 * verbatim in both).
 * - empty/null stays an empty string;
 * - values containing commas, quotes or newlines are quoted with `"` escaped;
 * - values starting with =, +, -, or @ (optionally preceded by spaces or
 *   tabs — spreadsheet apps skip leading whitespace before evaluating a
 *   cell as a formula) get a leading apostrophe so spreadsheet apps do not
 *   evaluate them as formulas (CSV injection).
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Leading whitespace (spaces/tabs) before a formula trigger: Excel and
  // Google Sheets skip it before evaluating the cell as a formula, so
  // " =1+1" is as dangerous as "=1+1" (OWASP CSV injection guidance).
  if (/^\s*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
