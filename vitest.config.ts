import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * P3.2: Vitest configuration.
 *
 * The web app uses the `@/*` path alias (tsconfig.json). Vitest needs
 * the same alias wired via `resolve.alias` so test files can import
 * modules under their canonical paths (and so mocks using the same
 * alias path match the production import).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    // Server environment — these tests touch DB/HTTP code, not React.
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'hooks/**/*.test.ts'],
    // The Next/Vercel modules reference Node builtins; tell vitest to
    // not polyfill them.
    server: {
      deps: {
        inline: [/^[~/.]/],
      },
    },
  },
});
