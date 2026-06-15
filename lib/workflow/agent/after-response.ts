/**
 * Post-response callback queue.
 *
 * Replaces `next/server`'s `after()` inside the workflow bundle.
 *
 * Why we can't use `after()`: importing `next/server` into the workflow
 * pulls in `next/dist/server/web/spec-extension/user-agent.js`, which
 * requires the ncc-compiled `ua-parser-js` bundle, which reads
 * `__dirname` at init. The Workflow DevKit runs the bundled code in a
 * `vm.Script.runInContext` sandbox whose context object (created by
 * `vm.createContext()`) does NOT define `__dirname` — so the import
 * throws `ReferenceError: __dirname is not defined`.
 *
 * Fix: keep the workflow bundle free of any `next/server` import.
 * Instead, `afterResponse()` here just pushes the callback into a
 * module-level queue. The host side (lib/workflow/agent/dispatch.ts)
 * drains the queue when the workflow's readable stream closes, which
 * is the same "response is done" point that `next/server.after()`
 * was targeting.
 *
 * This file is safe to import from inside the workflow bundle — it
 * has zero external dependencies.
 */

type AfterCallback = () => void | PromiseLike<void>;

const pendingCallbacks: AfterCallback[] = [];

/**
 * Schedule a callback to run after the workflow response closes.
 * Safe to call from inside a workflow function. The callback runs in
 * the host process (NOT the sandbox) so it has full access to Node
 * builtins, network, and imports like `extractMemoriesFromSession`.
 *
 * If called outside a workflow context (no drain wired up), the
 * callback is dropped silently — callers should treat extraction as
 * best-effort anyway.
 */
export function afterResponse(cb: AfterCallback): void {
  pendingCallbacks.push(cb);
}

/**
 * Drain and run all pending callbacks. Called by the host once the
 * workflow's readable stream closes. Each callback is run with a
 * try/catch so one failure doesn't block the rest.
 *
 * Returns a promise that resolves when all callbacks have settled.
 */
export async function drainPendingAfterCallbacks(): Promise<void> {
  const callbacks = pendingCallbacks.splice(0);
  await Promise.allSettled(
    callbacks.map(async (cb) => {
      try {
        await cb();
      } catch {
        // Swallow — best-effort by design. The callback itself is
        // responsible for its own logging.
      }
    }),
  );
}

/**
 * Reset the queue. Used by tests to isolate runs.
 */
export function _resetAfterQueue(): void {
  pendingCallbacks.length = 0;
}
