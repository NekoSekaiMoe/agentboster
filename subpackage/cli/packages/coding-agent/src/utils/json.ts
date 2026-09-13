/**
 * Strip a leading UTF-8 BOM (U+FEFF). Windows editors (e.g. Notepad) emit
 * BOMs that break `JSON.parse` and frontmatter detection (pi #8337).
 */
export function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ''))
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (m, tail) => tail ?? (m[0] === '"' ? m : ''),
    );
}
