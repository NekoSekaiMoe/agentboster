/**
 * extra-cmd — /init command
 *
 * Registers an `/init` command that generates a high-quality AGENTS.md
 * contributor guide for the current repository.
 *
 * This is a command-driven replacement for an auto-invoked init skill.
 * Instead of relying on the model to discover and invoke a skill, `/init`
 * injects the generation instructions as a user message, which always
 * triggers a turn — so the agent gets to work immediately and the user
 * sees exactly what was asked.
 *
 * Usage:
 *   /init                       generate AGENTS.md with the default outline
 *   /init also document the CI   append extra instructions to the prompt
 */

import type { ExtensionAPI } from '../../core/extensions/index.ts';

/** The core AGENTS.md generation instructions. */
const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.

Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it — report that it already exists and stop.

Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section. Analyze the codebase autonomously to fill in accurate, repository-specific details — do not invent commands or conventions; verify them against the actual project files (package manifests, config, CI, existing docs, and git history).

## Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

## Recommended Sections

Adapt as needed — add sections if relevant, and omit those that do not apply.

### Project Structure & Module Organization
Outline the project structure, including where the source code, tests, and assets are located.

### Build, Test, and Development Commands
List key commands for building, testing, and running locally (e.g., npm test, make build). Briefly explain what each command does.

### Coding Style & Naming Conventions
Specify indentation rules, language-specific style preferences, and naming patterns. Include any formatting or linting tools used.

### Testing Guidelines
Identify testing frameworks and coverage requirements. State test naming conventions and how to run tests.

### Commit & Pull Request Guidelines
Summarize commit message conventions found in the project's Git history. Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;

export function registerInitCommand(pi: ExtensionAPI): void {
  pi.registerCommand('init', {
    description: 'Generate an AGENTS.md contributor guide for this repository',
    handler: async (args, _ctx) => {
      const extra = args.trim();
      const prompt = extra
        ? `${INIT_PROMPT}\n\n## Additional instructions\n\n${extra}`
        : INIT_PROMPT;
      // sendUserMessage always triggers a turn, so the agent starts immediately.
      pi.sendUserMessage(prompt);
    },
  });
}
