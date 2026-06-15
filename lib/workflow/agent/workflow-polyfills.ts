/**
 * Workflow DevKit runtime polyfills.
 *
 * P3 follow-up: the Workflow DevKit runs the bundled workflow code in a
 * `vm.Script.runInContext` sandbox. That sandbox doesn't define the
 * CommonJS globals `__dirname` / `__filename`, but several ncc-compiled
 * bundles under `node_modules/next/dist/compiled/...` (notably
 * `ua-parser-js`) reference `__dirname` at module init time. Importing
 * `next/server` (which we do for `after()`) pulls in the user-agent
 * spec extension, which pulls in ua-parser-js, which throws:
 *
 *   ReferenceError: __dirname is not defined
 *
 * Fix: define `__dirname`/`__filename` on the workflow context's
 * global object before `start(chatWorkflow, ...)` runs. The DevKit's
 * context shares `globalThis` with the host process, so a one-line
 * assignment here is visible inside the workflow bundle.
 *
 * This file must be imported at the very top of any module that calls
 * `start()` from `workflow/api`. Side-effect-only; exports nothing.
 */

// The host process's real __dirname — for ESM this file doesn't have
// one, so we use process.cwd() as a safe stand-in. The ncc bundles
// only need a string; they use it to compute asset paths that we
// never actually read (we're consuming the JS, not its on-disk layout).
const hostDir = (() => {
  try {
    // Prefer real process CWD — it's what `next dev`/`next start` use.
    return process.cwd();
  } catch {
    return '/';
  }
})();

// Only assign if missing — don't clobber anything that's legitimately set.
if (typeof (globalThis as { __dirname?: unknown }).__dirname === 'undefined') {
  (globalThis as { __dirname: string }).__dirname = hostDir;
}
if (typeof (globalThis as { __filename?: unknown }).__filename === 'undefined') {
  (globalThis as { __filename: string }).__filename = hostDir + '/workflow-bundle.js';
}

export {};
