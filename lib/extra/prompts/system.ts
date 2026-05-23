import { buildIdentitySection } from './fragments/identity';
import { buildMemorySection } from './fragments/memory';
import { buildParallelSection } from './fragments/parallel';
import { buildPermissionsSection } from './fragments/permissions';
import { buildSandboxSection } from './fragments/sandbox';
import { buildSkillsSection } from './fragments/skills';
import { buildToolsSection } from './fragments/tools';

export interface SystemPromptConfig {
  agentName?: string;
  agentId?: string;
  workingDirectory?: string;
  sandboxType?: string;
  skills?: Array<{ name: string; description: string }>;
  customInstructions?: string;
  enableParallelAgents?: boolean;
}

export function buildSystemPrompt(config: SystemPromptConfig = {}): string {
  const sections: string[] = [];

  sections.push(buildIdentitySection());
  sections.push(buildToolsSection());
  sections.push(buildSandboxSection());
  sections.push(buildPermissionsSection());
  sections.push(buildMemorySection());

  if (config.enableParallelAgents !== false) {
    sections.push(buildParallelSection());
  }

  const skills = config.skills ?? [];
  sections.push(buildSkillsSection(skills));

  if (config.workingDirectory) {
    sections.push(
      `## Working Directory\n\nYour working directory is: \`${config.workingDirectory}\``,
    );
  }

  if (config.sandboxType) {
    sections.push(
      `## Active Sandbox\n\nCurrent sandbox type: **${config.sandboxType}**`,
    );
  }

  if (config.customInstructions) {
    sections.push(`## Custom Instructions\n\n${config.customInstructions}`);
  }

  return sections.join('\n\n---\n\n');
}

export function buildDefaultSystemPrompt(
  skills?: Array<{ name: string; description: string }>,
): string {
  return buildSystemPrompt({
    skills,
    enableParallelAgents: true,
  });
}
