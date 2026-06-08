import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type {
  ExecutionContext,
  ISkillLoader,
  SkillInstallOptions,
  SkillManifest,
} from './types';

interface InstalledSkill extends SkillManifest {
  path: string;
  installedAt: number;
}

const SKILL_FILE_PATTERN = 'SKILL.md';

export class SkillLoader implements ISkillLoader {
  private skillDirs: string[];
  private installed = new Map<string, InstalledSkill>();

  constructor(skillDirs: string[] = []) {
    this.skillDirs =
      skillDirs.length > 0
        ? skillDirs
        : [
            join(process.cwd(), '.agents', 'skills'),
            join(process.cwd(), '.opencode', 'skills'),
          ];
  }

  async loadFromFile(path: string): Promise<SkillManifest> {
    const content = await readFile(path, 'utf-8');
    return this.parseSkillContent(content, path);
  }

  async install(options: SkillInstallOptions): Promise<SkillManifest> {
    const { source, autoRestart } = options;

    if (source.startsWith('http://') || source.startsWith('https://')) {
      return this.installFromUrl(source);
    }

    return this.installFromLocal(source);
  }

  async uninstall(skillName: string): Promise<void> {
    this.installed.delete(skillName);
  }

  async listInstalled(): Promise<SkillManifest[]> {
    const results: SkillManifest[] = [];

    for (const dir of this.skillDirs) {
      try {
        const entries = await this.discoverSkillsInDir(dir);
        results.push(...entries);
      } catch {}
    }

    for (const skill of this.installed.values()) {
      if (!results.find((r) => r.name === skill.name)) {
        results.push(skill);
      }
    }

    return results;
  }

  async executeSkill(
    name: string,
    input: string,
    context: ExecutionContext,
  ): Promise<string> {
    const skill = this.installed.get(name);
    if (!skill) {
      throw new Error(`Skill not found: ${name}`);
    }

    const content = await readFile(skill.path, 'utf-8');

    let processed = content;
    processed = processed.replace(/\{\{input\}\}/g, input);
    processed = processed.replace(/\{\{agentId\}\}/g, context.agentId);
    processed = processed.replace(/\{\{userId\}\}/g, context.userId);
    processed = processed.replace(
      /\{\{workingDirectory\}\}/g,
      context.workingDirectory,
    );

    return processed;
  }

  async discoverAll(): Promise<SkillManifest[]> {
    return this.listInstalled();
  }

  private async discoverSkillsInDir(dir: string): Promise<SkillManifest[]> {
    const results: SkillManifest[] = [];

    try {
      const dirStat = await stat(dir);
      if (!dirStat.isDirectory()) return results;
    } catch {
      return results;
    }

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = join(dir, entry.name, SKILL_FILE_PATTERN);
        try {
          const manifest = await this.loadFromFile(skillPath);
          results.push(manifest);
        } catch {}
      } else if (entry.name === SKILL_FILE_PATTERN) {
        try {
          const manifest = await this.loadFromFile(join(dir, entry.name));
          results.push(manifest);
        } catch {}
      }
    }

    return results;
  }

  private parseSkillContent(content: string, path: string): SkillManifest {
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    let name = basename(path, extname(path));
    let version = '1.0.0';
    let description = '';

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const nameMatch = frontmatter.match(/^name:\s*(.+)/m);
      const versionMatch = frontmatter.match(/^version:\s*(.+)/m);
      const descMatch = frontmatter.match(
        /^description:\s*["']?(.+?)["']?\s*$/m,
      );

      if (nameMatch) name = nameMatch[1].trim();
      if (versionMatch) version = versionMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
    }

    return {
      name,
      version,
      description,
      main: path,
    };
  }

  private async installFromUrl(url: string): Promise<SkillManifest> {
    const { ofetch } = await import('ofetch');
    const _content = await ofetch<string>(url);
    const name = basename(url, extname(url));

    const manifest: SkillManifest = {
      name,
      version: '1.0.0',
      description: `Installed from ${url}`,
      main: url,
    };

    this.installed.set(name, {
      ...manifest,
      path: url,
      installedAt: Date.now(),
    });

    return manifest;
  }

  private async installFromLocal(source: string): Promise<SkillManifest> {
    const manifest = await this.loadFromFile(source);
    this.installed.set(manifest.name, {
      ...manifest,
      path: source,
      installedAt: Date.now(),
    });
    return manifest;
  }
}
