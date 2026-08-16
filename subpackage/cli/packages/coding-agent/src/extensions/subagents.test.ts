import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

/**
 * The npm package resolves on disk and its manifest declares the expected
 * extension entry. Wired into resolveBuiltinExtensionPaths() in
 * agent-session-services.ts; its @earendil-works/* imports resolve through
 * the loader's virtual-module aliases (see loader.ts VIRTUAL_MODULES).
 */
describe('pi-subagents package', () => {
  const req = createRequire(import.meta.url);
  let manifest: { pi?: { extensions?: string[] } } | undefined;
  try {
    manifest = req('@narumitw/pi-subagents/package.json');
  } catch {
    manifest = undefined;
  }

  it.skipIf(!manifest)('declares a pi extension entrypoint', () => {
    expect(manifest?.pi?.extensions?.[0]).toBe('./src/index.ts');
  });
});
