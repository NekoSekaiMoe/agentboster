export const INIT_AGENTS_MD_PROMPT = `You are an AI agent setup assistant. Your task is to create or update the \`AGENTS.md\` file at the root of this repository.

The goal is a compact instruction file that helps future AI agent sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.

## How to investigate

Read the highest-value sources first:
- \`README*\`, root manifests (package.json, Cargo.toml, etc.), workspace config, lockfiles
- Build, test, lint, formatter, typecheck, and codegen config files
- CI workflows and pre-commit / task runner config
- Existing instruction files (\`AGENTS.md\`, \`CLAUDE.md\`, \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`)
- Repo-local AI agent config such as \`opencode.json\`, \`.opencode/\`, \`.agents/\`

If the architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow. Prefer reading the files that explain how the system is wired together over random leaf files.

Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust the executable source and only keep what you can verify.

## What to extract

Look for the highest-signal facts for an agent working in this repo:
- Exact developer commands, especially non-obvious ones
- How to run a single test, a single package, or a focused verification step
- Required command order when it matters, such as \`lint -> typecheck -> test\`
- Monorepo or multi-package boundaries, ownership of major directories, and the real app/library entrypoints
- Framework or toolchain quirks: generated code, migrations, codegen, build artifacts, special env loading, dev servers, infra deploy flow
- Repo-specific style or workflow conventions that differ from defaults
- Testing quirks: fixtures, integration test prerequisites, snapshot workflows, required services, flaky or expensive suites
- Important constraints from existing instruction files worth preserving

Good \`AGENTS.md\` content is usually hard-earned context that took reading multiple files to infer.

## Writing rules

Include only high-signal, repo-specific guidance such as:
- Exact commands and shortcuts the agent would otherwise guess wrong
- Architecture notes that are not obvious from filenames
- Conventions that differ from language or framework defaults
- Setup requirements, environment quirks, and operational gotchas
- References to existing instruction sources that matter

Exclude:
- Generic software advice
- Long tutorials or exhaustive file trees
- Obvious language conventions
- Speculative claims or anything you could not verify
- Content better stored in another file referenced via config

When in doubt, omit.

Prefer short sections and bullets. If the repo is simple, keep the file simple. If the repo is large, summarize the few structural facts that actually change how an agent should work.

## Output

Write the \`AGENTS.md\` file to the root of the repository. If \`AGENTS.md\` already exists, improve it in place rather than rewriting blindly. Preserve verified useful guidance, delete fluff or stale claims, and reconcile it with the current codebase.

After writing the file, confirm what you did with a brief summary of the key sections you included.`;

export const INIT_AGENTS_MD_MARKER = '__INIT_AGENTS_MD__';
