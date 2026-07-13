/**
 * Next.js instrumentation hook.
 *
 * `register()` runs ONCE on host process start, before any request is served
 * or any workflow step executes. Next.js awaits it, so anything initialized
 * here is guaranteed ready by the time the first request/step hits.
 *
 * We use it to pre-warm the self-hosted node-postgres driver. That driver
 * lives in `lib/core/db/pg-driver.ts` — the ONLY module allowed to reference
 * `pg` — and is loaded here via `await import()`. This file runs only on the
 * host (Node runtime), never inside the workflow `vm.runInContext` sandbox and
 * never reachable from a workflow body, so pulling `pg` in here does NOT drag
 * its `node:*` deps into the workflow steps bundle. See lib/core/db/index.ts
 * for the full rationale (the `db` export is a synchronous Proxy; warm-up
 * injects the pg instance before the first synchronous `db.x` access).
 *
 * The neon path needs no warm-up — it initializes lazily inside the Proxy
 * getter — so `warmupDatabase()` is a no-op there.
 */
export async function register(): Promise<void> {
  // Only the Node.js server runtime can hold a pg TCP pool. The edge runtime
  // (middleware) sets NEXT_RUNTIME='edge' and must skip DB warm-up.
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  try {
    const { warmupDatabase } = await import('@/lib/core/db/pg-driver');
    await warmupDatabase();
  } catch (error) {
    // Non-fatal: a dev server may boot without DATABASE_URL configured. The
    // first real DB access will surface a clear error if the driver is still
    // uninitialized.
    console.warn(
      '[instrumentation] database warm-up skipped:',
      error instanceof Error ? error.message : String(error),
    );
  }
}
