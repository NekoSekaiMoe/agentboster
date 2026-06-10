import { tool } from 'ai';
import { z } from 'zod';

import {
  downloadAndSyncSkillsFromGit,
  downloadAndSyncSkillFromClawHub,
  getSkillFileContentFromBlob,
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
import { getSkillEntrypointPath } from '@/types/skills';
import { defineBuildInTool } from '../define';

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
        description: `Get file content from a skill by path. Supports startLine/endLine for line-range slicing.`,
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
    };
  },
});
