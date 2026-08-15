import { describe, expect, it } from 'vitest';
import { csvField } from './csv';

describe('csvField', () => {
  it('keeps plain values untouched', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField(42)).toBe('42');
    expect(csvField('a=b')).toBe('a=b');
  });

  it('returns an empty string for null/undefined', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('quotes values containing commas, quotes or newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('prefixes values that start with a formula trigger character', () => {
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('-2')).toBe("'-2");
    expect(csvField('@cmd')).toBe("'@cmd");
  });

  it('prefixes formula triggers preceded by leading spaces or tabs', () => {
    // Excel/Sheets skip leading whitespace before evaluating a cell as a
    // formula — " =1+1" is just as dangerous as "=1+1" (OWASP CSV injection).
    expect(csvField(' =1+1')).toBe("' =1+1");
    expect(csvField('\t=1+1')).toBe("'\t=1+1");
    expect(csvField('   @cmd')).toBe("'   @cmd");
    expect(csvField('\t+cmd')).toBe("'\t+cmd");
  });

  it('prefixes a trigger preceded by a newline-run header', () => {
    // sanitizeAuditCommand-style values: trigger after CRLF/newline header.
    // (The quoting in the received value comes from the \r\n quote rule,
    // which is correct CSV escaping — the assertion checks the apostrophe.)
    expect(csvField('\r\n=cmd')).toBe('"\'\r\n=cmd"');
    expect(csvField('\n@rebatch')).toBe('"\'\n@rebatch"');
  });

  it('does not prefix inner whitespace or trailing triggers', () => {
    expect(csvField('total = 3')).toBe('total = 3');
    expect(csvField('a + b')).toBe('a + b');
    expect(csvField('5-3')).toBe('5-3');
    expect(csvField('x@y')).toBe('x@y');
    // leading space NOT followed by a trigger stays untouched
    expect(csvField(' 5-3')).toBe(' 5-3');
  });
});
