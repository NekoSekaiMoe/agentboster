// IMPORTANT: This module MUST be imported as the FIRST import in any
// 'use workflow' file whose static import graph reaches
// `@chat-adapter/state-redis` (or any package that transitively depends
// on the Node.js `Buffer` global at module-evaluation time).
//
// The Vercel Workflow DevKit `'use workflow'` transform executes the
// workflow function body inside a `vm.runInContext` sandbox. That
// sandbox does not expose Node.js globals such as `Buffer`,
// `process`, or `setTimeout`.
//
// One of the static imports reachable from `lib/workflow/agent/index.ts`
// is `@chat-adapter/state-redis` (via the bot reply/instance chain),
// which depends on the `redis` (node-redis) package, which depends on
// `@redis/client`. The RESP decoder at
// `node_modules/@redis/client/dist/lib/RESP/decoder.js` evaluates
// `Buffer` at module-load time (inside a computed property key/value),
// throwing `ReferenceError: Buffer is not defined` and aborting the
// entire workflow before the user code ever runs.
//
// This file installs `Buffer` on the sandbox's `globalThis` during
// module evaluation, so that subsequent module evaluations that
// reference a bare `Buffer` identifier resolve it through the global
// object. The import order is depth-first, source-order, so importing
// this module first guarantees the polyfill runs before the offending
// module is loaded.
import { Buffer } from 'node:buffer';

const globalRef = globalThis as { Buffer?: typeof Buffer };
if (typeof globalRef.Buffer === 'undefined') {
  globalRef.Buffer = Buffer;
}
