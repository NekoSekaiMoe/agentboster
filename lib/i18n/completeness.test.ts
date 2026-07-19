import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { translations, locales, defaultLocale } from '@/lib/i18n';

describe('i18n all-locale completeness', () => {
  const enKeys = Object.keys(translations[defaultLocale]).sort();

  it('en-US is non-empty', () => {
    // Replaces the old hardcoded count assertion. A hardcoded number
    // had to be manually bumped every time a namespace was added,
    // which made adding i18n keys friction-heavy and led to drift
    // between the snapshot and reality.
    //
    // The duplicate-key guard now lives in its own test below
    // (`<locale> source has no duplicate keys`), because Object.keys /
    // Set dedup cannot detect duplicates — by the time the module's
    // spread-merged object is observed, the later key has already
    // overwritten the earlier one and the runtime sees only one.
    expect(enKeys.length).toBeGreaterThan(0);
  });

  it.each(locales)('%s has full key set', (locale) => {
    const keys = Object.keys(translations[locale]).sort();
    expect(keys).toEqual(enKeys);
  });

  // Source-level duplicate-key detection.
  //
  // The spread-merge in each locale file (`{ ...a, ...b, 'key': ... }`)
  // silently lets a later definition overwrite an earlier one at module
  // load time. Once observed via `Object.keys`, the duplicate is gone —
  // so the previous `Set(keys).size === keys.length` assertion was a
  // tautology and never caught anything. We parse with the TypeScript
  // compiler (acorn can't parse the `.ts` syntax in these files) and
  // walk every ObjectLiteralExpression, flagging any literal key that
  // appears more than once in the same object.
  it.each(
    locales,
  )('%s source has no duplicate keys within a single object literal', (locale) => {
    const file = readFileSync(
      join(process.cwd(), 'lib', 'i18n', 'locales', `${locale}.ts`),
      'utf8',
    );
    const source = ts.createSourceFile(
      `${locale}.ts`,
      file,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
    );

    const offenders: Array<{ key: string; count: number }> = [];

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const seen = new Map<string, number>();
        for (const prop of node.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          let keyName: string | null = null;
          if (ts.isStringLiteral(prop.name)) keyName = prop.name.text;
          else if (ts.isIdentifier(prop.name)) keyName = prop.name.text;
          else if (ts.isNumericLiteral(prop.name)) keyName = prop.name.text;
          if (keyName === null) continue;
          seen.set(keyName, (seen.get(keyName) ?? 0) + 1);
        }
        for (const [key, count] of seen) {
          if (count > 1) offenders.push({ key, count });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);

    expect(offenders).toEqual([]);
  });

  // Sanity: locale list matches the files on disk (guards against a
  // new locale file appearing without being wired into the registry).
  it('locale files on disk match the registered locales', () => {
    const onDisk = readdirSync(join(process.cwd(), 'lib', 'i18n', 'locales'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
    expect(onDisk).toEqual([...locales].sort());
  });
});
