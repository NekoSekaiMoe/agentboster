# Agent Note: CLI tests and single-file CI artifacts

Status: implemented

## Problem

PR #65 adds tests that import workspace runtime entries before their `dist/`
files exist. Both the root and CLI CI test jobs run without a CLI build.
It also splits the bundle into a compile-cache launcher and runtime, while
`build-all.yml` transfers only `agentboster-cli.cjs` to packaging jobs. The
runtime is absent there, so tarball creation fails on every target OS.

## Decision

The two tests use Vitest factories that forward only the required runtime
imports to their real TypeScript sources. Context-edit and error-text assertions
remain intact, and production imports retain their workspace package names.
The factories import source URLs resolved relative to each test so they work
under both Vitest roots. Computed imports keep package builds from pulling
sibling sources into their compilation and emitting files outside `dist/`.

`bundle.mjs` emits the complete runtime as the existing single-file artifact.
`package.mjs` copies it to `agentboster-cli-runtime.cjs` and generates the small
`agentboster-cli.cjs` launcher. The distributed launcher enables the compile
cache before requiring the runtime, preserving the PR's startup optimization.
The tarball retains its metadata and MCP binary packaging behavior.

## Alternatives considered

- Build workspaces before tests or expand CI artifact paths: requires workflow
  changes, outside this fix's permitted scope.
- Change runtime imports to cross-package source paths: couples production
  code to checkout layout solely to support tests.
- Remove the compile-cache launcher: loses the intended startup optimization.

## Consequences

Tests run against actual dependency logic without generated workspace files.
The test factories must stay aligned with the runtime dependencies they forward.
The downloadable bundle runs directly; the packaged launcher additionally arms
compile caching before the runtime loads. Packaging needs only the existing
single-file artifact, with no dependency on the bundler's other local outputs.
