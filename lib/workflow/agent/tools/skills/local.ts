import { tool } from 'ai';
import { z } from 'zod';

import {
  downloadAndSyncSkillsFromGit,
  downloadAndSyncSkillFromClawHub,
  getSkillFileContentFromBlob,
  listSkillFilesWithContentFromBlob,
} from '@/lib/core/blob/skills';
import {
  getSkillDetail,
  listSkillMetas,
  persistManualSkill,
  removeSkillDetail,
  syncRepoSkillDetails,
  upsertSkillDetail,
  updateSkillFile,
} from '@/lib/core/kv/skills';
import {
  buildSkillExecCommand,
  getSkillEntrypointPath,
  getSkillRuntime,
  SKILL_RUNTIMES,
} from '@/types/skills';
import { execToolOnAgentd } from '@/lib/extra/agent/agentd-tools-client';
import { defineBuildInTool } from '../define';

/**
 * Hard ceiling on the number of files we are willing to push into a sandbox
 * in a single `runSkill` invocation. The skill import pipeline caps repos
 * at GIT_IMPORT_MAX_FILE_COUNT = 500 (lib/core/blob/skills.ts); we use the
 * same number so a freshly imported skill can always be synced end-to-end.
 */
const RUN_SKILL_MAX_FILES = 500;

/**
 * Per-call wall-clock budget for running the user's entrypoint on agentd.
 * Matches the `exec` tool's existing default and keeps a runaway script
 * from holding a sandbox slot forever.
 */
const RUN_SKILL_EXEC_TIMEOUT_SECONDS = 120;

/**
 * POSIX single-quote a string so it is safe to interpolate into a shell
 * command. Used for the skill directory (sourced from an external skill
 * name) before it is placed into `cd <dir> && ...`. Centralized here
 * rather than reusing buildSkillExecCommand because the entrypoint path
 * already goes through that helper; only the directory does not.
 */
function shellQuotePOSIX(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

/**
 * A skill name is safe to splice into a sandbox-relative path only when
 * it is a single path segment with no separators or traversal. This
 * rejects `\`, `/`, `..`, leading dots, control chars, and shell
 * metacharacters that could otherwise rewrite the skill directory
 * (`skills/${name}`) into an arbitrary workspace or absolute path.
 */
function assertSafeSkillName(name: string): void {
  // A single path segment: no separators of any kind. We also reject any
  // character with code <= 0x20 (control chars + space) without spelling
  // them out in the regex literal — Biome flags explicit control chars in
  // regexes, so we test the char code instead.
  if (/[\\]/.test(name) || name.includes('/')) {
    throw new Error(`Skill name "${name}" contains invalid characters`);
  }
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) <= 0x20) {
      throw new Error(`Skill name "${name}" contains invalid characters`);
    }
  }
  // No traversal components.
  if (name === '.' || name === '..' || name.includes('..')) {
    throw new Error(`Skill name "${name}" must not be a path`);
  }
  // Reject anything that looks like shell metacharacters / absolute paths.
  if (name.startsWith('.') || name.startsWith('/')) {
    throw new Error(`Skill name "${name}" must not start with a dot or slash`);
  }
}

/**
 * Normalize a file path stored in Blob so it is a *relative* path inside
 * the skill directory and cannot escape it. Rejects:
 *   - absolute paths (`/etc/passwd`, `C:\...` after backslash stripping)
 *   - any segment equal to `..` (parent traversal)
 *   - empty / whitespace-only paths
 * Leading slashes are stripped defensively, but that alone is not enough
 * — `../` segments must also be rejected because the agentd `write` tool
 * resolves paths against the sandbox workspace root, so `skills/x/../../y`
 * would land outside the skill dir.
 */
function normalizeSkillRelativePath(rawPath: string): string {
  // Strip Windows backslashes and leading slashes defensively.
  const cleaned = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleaned.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(
        `Skill file path "${rawPath}" contains a parent-traversal segment ("..") and cannot be materialized safely.`,
      );
    }
    if (seg === '') {
      throw new Error(
        `Skill file path "${rawPath}" is empty or contains an empty segment.`,
      );
    }
  }
  return cleaned;
}

export default defineBuildInTool({
  id: 'skills',
  description: `Manage local skills stored in KV and Blob.`,
  factory: async () => {
    return {
      listSkills: tool({
        title: 'List Skills',
        description: `List all skills.`,
        inputSchema: z.object({}),
        execute: async (_value) => {
          'use step';

          return { items: await listSkillMetas() };
        },
      }),

      getSkill: tool({
        title: 'Get Skill',
        description: `Get skill detail by name and get all files tree.`,
        inputSchema: z.object({
          name: z.string().min(1),
        }),
        execute: async ({ name }) => {
          'use step';

          const detail = await getSkillDetail(name);
          if (!detail) throw new Error(`Skill "${name}" not found`);
          return detail;
        },
      }),

      getSkillFile: tool({
        title: 'Get Skill File',
        description: [
          'Get file content from a skill by path as read-only text. Supports startLine/endLine for line-range slicing.',
          '',
          'IMPORTANT: the returned content is reference material only. Do NOT attempt to execute `.py` / `.sh` / `.js` / other code files fetched this way — they are not on a runtime path.',
          'To run a skill, it must declare `runtime: python|bash` in its frontmatter and you must call `runSkill`, which materializes the skill into an agentd sandbox and launches the declared entrypoint.',
        ].join('\n'),
        inputSchema: z.object({
          /** Skill name */
          name: z.string().min(1),
          /** File path relative to skill dir */
          path: z.string().min(1),
          /** Optional start line (1-based) */
          startLine: z.number().int().positive().optional(),
          /** Optional end line (1-based, inclusive) */
          endLine: z.number().int().positive().optional(),
        }),
        execute: async ({ name, path: filePath, startLine, endLine }) => {
          'use step';

          let content = await getSkillFileContentFromBlob(name, filePath);
          if (content === null) {
            throw new Error(`File "${filePath}" not found in skill "${name}"`);
          }

          if (startLine || endLine) {
            const lines = content.split('\n');
            const start = Math.max(1, startLine ?? 1) - 1;
            const end = Math.min(lines.length, endLine ?? lines.length);
            content = lines.slice(start, end).join('\n');
            return {
              name,
              path: filePath,
              content,
              startLine: start + 1,
              endLine: end,
              totalLines: lines.length,
            };
          }

          return { name, path: filePath, content };
        },
      }),

      getSkillEntrypoint: tool({
        title: 'Get Skill Entrypoint',
        description: `Get the primary instruction/entrypoint file for a skill. Supports ClawHub clawhub.json entrypoint metadata and falls back to SKILL.md.`,
        inputSchema: z.object({
          name: z.string().min(1),
          startLine: z.number().int().positive().optional(),
          endLine: z.number().int().positive().optional(),
        }),
        execute: async ({ name, startLine, endLine }) => {
          'use step';

          const detail = await getSkillDetail(name);
          if (!detail) throw new Error(`Skill "${name}" not found`);

          const entrypoint = getSkillEntrypointPath(detail);
          if (!entrypoint) {
            throw new Error(`Skill "${name}" does not have any files`);
          }

          let content = await getSkillFileContentFromBlob(name, entrypoint);
          if (content === null) {
            throw new Error(
              `Entrypoint "${entrypoint}" not found in skill "${name}"`,
            );
          }

          if (startLine || endLine) {
            const lines = content.split('\n');
            const start = Math.max(1, startLine ?? 1) - 1;
            const end = Math.min(lines.length, endLine ?? lines.length);
            content = lines.slice(start, end).join('\n');
            return {
              name,
              path: entrypoint,
              content,
              startLine: start + 1,
              endLine: end,
              totalLines: lines.length,
            };
          }

          return { name, path: entrypoint, content };
        },
      }),

      importSkillRepo: tool({
        title: 'Import Skill Repo',
        description: `Clone a git repo and import skills. Supports OpenClaw/ClawHub single-skill repositories with root SKILL.md, compatible root clawhub.json manifests, and AgentBoster /skills repositories.`,
        inputSchema: z.object({
          /** Git URL of the repository */
          gitURL: z.string().min(1),
        }),
        execute: async ({ gitURL }) => {
          'use step';

          const imported = await downloadAndSyncSkillsFromGit(gitURL);
          const result = await syncRepoSkillDetails(gitURL, imported);
          return { gitURL, imported: result.imported, removed: result.removed };
        },
      }),

      importSkillFromClawHub: tool({
        title: 'Import Skill From ClawHub',
        description: `Import a public OpenClaw/ClawHub skill by slug from the ClawHub registry. Uses the latest version unless version is provided.`,
        inputSchema: z.object({
          slug: z.string().min(1),
          version: z.string().optional(),
        }),
        execute: async ({ slug, version }) => {
          'use step';

          const detail = await downloadAndSyncSkillFromClawHub({
            slug,
            version,
          });
          return { detail: await upsertSkillDetail(detail) };
        },
      }),

      upsertSkill: tool({
        title: 'Upsert Skill',
        description: `Create or update a skill with inline files.`,
        inputSchema: z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          files: z
            .array(z.object({ path: z.string(), content: z.string() }))
            .optional(),
        }),
        execute: async ({ name, description, files }) => {
          'use step';

          const detail = await persistManualSkill({
            name,
            description: description || '',
            files: files || [],
          });
          return { detail };
        },
      }),

      updateSkillFile: tool({
        title: 'Update Skill File',
        description: `Update a single file in an existing skill.`,
        inputSchema: z.object({
          name: z.string().min(1),
          path: z.string().min(1),
          content: z.string(),
        }),
        execute: async ({ name, path: filePath, content }) => {
          'use step';

          const updated = await updateSkillFile(name, filePath, content);
          return { detail: updated, path: filePath };
        },
      }),
      deleteSkill: tool({
        title: 'Delete Skill',
        description: `Delete a single skill by name. Removes all its files from Blob and metadata from KV.`,
        inputSchema: z.object({
          name: z.string().min(1, 'Skill name is required'),
        }),
        execute: async ({ name }) => {
          'use step';

          const removed = await removeSkillDetail(name);
          return { action: 'delete', name, removed };
        },
      }),

      runSkill: tool({
        title: 'Run Skill Entrypoint',
        description: [
          'Execute a skill whose SKILL.md frontmatter declares `runtime: python|bash` on an agentd sandbox.',
          '',
          'The skill must declare a supported `runtime` and a valid `entrypoint` in its frontmatter; otherwise this tool refuses to dispatch and the caller must treat the skill files as read-only reference material (use `getSkillFile` instead).',
          '',
          'What it does end-to-end:',
          '  1. Pulls every file of the skill from blob storage.',
          '  2. Writes them into the sandbox workspace under `skills/<name>/...` via the agentd `write` tool (one call per file, capped at 500 files).',
          '  3. Runs the resolved entrypoint with the declared runtime (`python3 <entrypoint>` or `bash <entrypoint>`) from inside `skills/<name>/`, with a 120s timeout.',
          '  4. Returns stdout / stderr / exit code to the caller.',
          '',
          'Args:',
          '  - name: skill name',
          '  - sessionId: agentd session id the run should be scoped to',
          '  - args: optional CLI args forwarded to the entrypoint after the script path',
          '  - nodeId: optional specific agentd node id (auto-selected when omitted)',
        ].join('\n'),
        inputSchema: z.object({
          name: z.string().min(1),
          sessionId: z.string().min(1),
          args: z.array(z.string()).optional(),
          nodeId: z.string().optional(),
        }),
        execute: async ({ name, sessionId, args, nodeId }) => {
          'use step';

          const detail = await getSkillDetail(name);
          if (!detail) {
            throw new Error(`Skill "${name}" not found`);
          }

          const runtime = getSkillRuntime(detail);
          if (!runtime) {
            throw new Error(
              `Skill "${name}" does not declare a supported \`runtime\` (expected one of: ${SKILL_RUNTIMES.join(', ')}). Files are reference-only and cannot be executed.`,
            );
          }

          // runSkill requires an *explicitly declared* entrypoint in the
          // frontmatter. We deliberately do NOT use getSkillEntrypointPath()
          // here, because that helper falls back to `SKILL.md` / first file
          // when no `entrypoint:` is set — a fallback that would happily
          // dispatch `python3 SKILL.md` for a skill that only declared
          // `runtime: python`, violating the tool's strict runtime contract.
          const frontmatterEntrypoint = detail.frontmatter.entrypoint;
          const entrypoint =
            typeof frontmatterEntrypoint === 'string' &&
            frontmatterEntrypoint.trim()
              ? frontmatterEntrypoint.trim()
              : null;
          if (!entrypoint) {
            throw new Error(
              `Skill "${name}" does not declare an \`entrypoint\` in its frontmatter. Set \`entrypoint:\` to the file runSkill should launch.`,
            );
          }

          if (!detail.files.some((f) => f.path === entrypoint)) {
            throw new Error(
              `Entrypoint "${entrypoint}" is not present in skill "${name}" files.`,
            );
          }

          if (detail.files.length > RUN_SKILL_MAX_FILES) {
            throw new Error(
              `Skill "${name}" has ${detail.files.length} files, exceeding the ${RUN_SKILL_MAX_FILES}-file sync limit for runSkill.`,
            );
          }

          const files = await listSkillFilesWithContentFromBlob(name);
          if (files.length === 0) {
            throw new Error(`Skill "${name}" has no files in blob storage`);
          }

          // Re-check the sync limit against the actual Blob contents. The
          // check above used detail.files.length (KV metadata); when the KV
          // index and Blob storage have drifted, the live file set can be
          // larger than what the metadata claims and would silently bypass
          // the cap. Reject oversized blobs before writing anything.
          if (files.length > RUN_SKILL_MAX_FILES) {
            throw new Error(
              `Skill "${name}" has ${files.length} files in blob storage, exceeding the ${RUN_SKILL_MAX_FILES}-file sync limit for runSkill.`,
            );
          }

          // Workspace-relative directory the agentd `write` tool targets.
          // The agentd workspace layout always has `skills/` as a writable
          // top-level dir (see subpackage/agentd internal/sandbox/workspace.go).
          // The skill name is validated as a single safe path segment so it
          // cannot escape or rewrite the directory.
          assertSafeSkillName(name);
          const skillDir = `skills/${name}`;
          // Shell-quoted form, used everywhere skillDir is interpolated into
          // a command (`cd ${skillDirQuoted} && ...`).
          const skillDirQuoted = shellQuotePOSIX(skillDir);

          // Phase 1 — materialize every file into the sandbox. We deliberately
          // do not skip files based on extension: SKILL.md, requirements.txt,
          // helper scripts, data files — all are needed for the entrypoint to
          // run correctly. The agentd `write` tool creates parent dirs.
          //
          // Node pinning: when the caller did not specify a nodeId, the first
          // successful write pins the node used for *all* subsequent writes
          // and the final exec. Otherwise each execToolOnAgentd() call would
          // re-run selectBestNode() and could scatter files across multiple
          // nodes, leaving the entrypoint's node missing files. We still
          // honor an explicit caller-provided nodeId throughout.
          const syncErrors: Array<{ path: string; error: string }> = [];
          let pinnedNodeId = nodeId;
          for (const file of files) {
            // Defensive: reject any path that could escape skillDir. Only
            // stripping leading slashes is not enough — `..` segments can
            // still write outside skills/<name>/.
            const relPath = normalizeSkillRelativePath(file.path);
            const writeResult = await execToolOnAgentd(
              sessionId,
              'write',
              {
                path: `${skillDir}/${relPath}`,
                content: file.content,
              },
              pinnedNodeId,
            );
            if (!writeResult.success) {
              syncErrors.push({
                path: relPath,
                error: writeResult.error ?? 'unknown write error',
              });
              continue;
            }
            // Pin the node that actually accepted the first successful write.
            // Subsequent iterations and the final exec will pass this id, so
            // no further selectBestNode() round-trips happen.
            if (!pinnedNodeId && writeResult.node?.id) {
              pinnedNodeId = writeResult.node.id;
            }
          }

          if (syncErrors.length > 0) {
            return {
              ok: false as const,
              phase: 'sync' as const,
              runtime,
              entrypoint,
              skillDir,
              errors: syncErrors,
            };
          }

          // Phase 2 — execute the entrypoint from inside skillDir so that
          // `import` / relative paths Just Work. We pass the runtime-derived
          // command through buildSkillExecCommand to keep quoting centralized
          // (types/skills), then append user-supplied args. Args and skillDir
          // are POSIX-quoted to neutralize shell metacharacters.
          const baseCommand = buildSkillExecCommand(runtime, entrypoint);
          const argString = (args ?? [])
            .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
            .join(' ');
          const fullCommand =
            argString.length > 0
              ? `cd ${skillDirQuoted} && ${baseCommand} ${argString}`
              : `cd ${skillDirQuoted} && ${baseCommand}`;

          const execResult = await execToolOnAgentd(
            sessionId,
            'exec',
            {
              command: fullCommand,
              timeout: RUN_SKILL_EXEC_TIMEOUT_SECONDS,
              working_dir: '.',
            },
            pinnedNodeId,
          );

          if (!execResult.success) {
            return {
              ok: false as const,
              phase: 'exec' as const,
              runtime,
              entrypoint,
              skillDir,
              command: fullCommand,
              error: execResult.error ?? 'agentd exec failed',
              stdout: execResult.data,
              node: execResult.node,
            };
          }

          return {
            ok: true as const,
            phase: 'exec' as const,
            runtime,
            entrypoint,
            skillDir,
            command: fullCommand,
            stdout: execResult.data,
            node: execResult.node,
          };
        },
      }),
    };
  },
});
