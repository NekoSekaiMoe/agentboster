import { Buffer } from 'node:buffer';

if (typeof globalThis.Buffer === 'undefined') {
  // The @redis/client RESP decoder reads `Buffer` as a bare global at module
  // evaluation time (not imported from `node:buffer`). That breaks in any
  // runtime that doesn't expose Node globals — Next.js Edge runtime (the
  // default for App Router routes on Vercel, e.g. IM webhook handlers) and
  // the Vercel Workflow DevKit VM sandbox. Inject it from `node:buffer`
  // before any redis client code evaluates.
  (globalThis as { Buffer: typeof Buffer }).Buffer = Buffer;
}
