export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  main: string;
  dependencies?: string[];
  permissions?: string[];
}

export interface SkillInstallOptions {
  source: string;
  autoRestart: boolean;
}

export interface ExecutionContext {
  agentId: string;
  userId: string;
  workingDirectory: string;
  env?: Record<string, string>;
}

export interface ISkillLoader {
  loadFromFile(path: string): Promise<SkillManifest>;
  install(options: SkillInstallOptions): Promise<SkillManifest>;
  uninstall(skillName: string): Promise<void>;
  listInstalled(): Promise<SkillManifest[]>;
  executeSkill(
    name: string,
    input: string,
    context: ExecutionContext,
  ): Promise<string>;
}
