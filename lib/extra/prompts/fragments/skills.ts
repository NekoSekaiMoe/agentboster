export function buildSkillsSection(
  skills: Array<{ name: string; description: string }>,
): string {
  if (skills.length === 0) {
    return `## OpenClaw Skills

No skills are currently installed. Skills can be installed from:
- Local filesystem (SKILL.md files, plus supporting files)
- ClawHub package registry
- Remote URLs

Skills extend your capabilities with specialized knowledge and workflows.`;
  }

  const skillList = skills
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join('\n');

  return `## OpenClaw Skills

The following skills are available:

${skillList}

### Skill Usage
- Skills provide specialized instructions for specific domains
- Each skill has a SKILL.md file or compatible manifest entrypoint with detailed instructions
- Skills are automatically loaded and available as tools
- Use skills when a task matches their described domain`;
}
