// agentd tool protocol surface.
//
// Hand-ported from `subpackage/agentd/internal/**` (Go) and
// `lib/extra/agent/**` + `lib/security/**` (TS). See each module's
// header for the source-of-truth pointer and drift notes. Drift
// between the Go and TS sources is reported by
// `scripts/regen-agentd.py`.
//
// This surface is intended for third-party execution-node authors,
// agentd tool/sandbox extension authors, and monitoring
// integrators. It is a **type-only** mirror — there is no runtime
// implementation in the SDK; consumers are expected to bring their
// own HTTP client.

export * from './envelope.js';
export * from './tools.js';
export * from './sandbox.js';
export * from './security.js';
export * from './node.js';
export * from './paths.js';
export * from './traces.js';
