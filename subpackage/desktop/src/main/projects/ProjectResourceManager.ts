import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
	CreateProjectSkillInput,
	PiExtensionSummary,
	PiSkillLocation,
	PiSkillSummary,
	Project,
	ProjectResourceListResult,
} from "../../shared/types";

const SKILL_FILE = "SKILL.md";

type ProjectProvider = (projectId: string) => Project | undefined;

/**
 * 管理单个项目目录内的 pi 资源。
 * 仅扫描/删除项目目录下的 .pi/.agents 资源，避免把全局 skill/extension 混入项目级弹框。
 */
export class ProjectResourceManager {
	constructor(private readonly getProject: ProjectProvider) {}

	async list(projectId: string): Promise<ProjectResourceListResult> {
		const project = this.requireProject(projectId);
		const [skills, extensions] = await Promise.all([
			this.listSkills(project),
			this.listExtensions(project),
		]);
		return { skills, extensions };
	}

	async createSkill(input: CreateProjectSkillInput): Promise<PiSkillSummary> {
		const project = this.requireProject(input.projectId);
		const location = this.skillLocations(project)[0];
		const normalizedName = this.normalizeSkillName(input.name);
		if (!normalizedName) throw new Error("Skill 名称只能包含小写字母、数字和连字符");
		// 保留用户原始输入作为显示名；标准化名仅用于目录/文件路径，SKILL.md 内存原始名
		// 这样 readSkill/refresh 后 UI 展示的是用户输入的原始名称，不会被 normalizeSkillName 截断。
		const displayName = input.name.trim();
		const description = input.description.trim();
		if (!description) throw new Error("Skill 描述不能为空");

		const skillDir = join(location.path, normalizedName);
		this.assertInsideProject(project, skillDir);
		if (existsSync(skillDir)) throw new Error(`项目 Skill 已存在：${normalizedName}`);
		await mkdir(skillDir, { recursive: true });
		const skillPath = join(skillDir, SKILL_FILE);
		await writeFile(
			skillPath,
			`---\nname: ${displayName}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n# ${displayName}\n\n## Usage\n\nReplace this section with your skill instructions.\nSee https://agentskills.io/specification for the SKILL.md format.\n`,
			"utf8",
		);
		// 直接构造返回结果，避免 re-read 解析偏差
		const warnings = this.validateSkill(normalizedName, description);
		return {
			id: `${location.id}:${skillPath}`,
			name: displayName,
			description,
			path: skillPath,
			dir: skillDir,
			sourceId: location.id,
			sourceLabel: location.label,
			type: "directory",
			enabled: true,
			valid: warnings.length === 0,
			warnings,
		};
	}

	async deleteSkill(projectId: string, skillPath: string): Promise<void> {
		const project = this.requireProject(projectId);
		const skill = await this.findSkill(project, skillPath);
		const target = skill.type === "directory" ? skill.dir : skill.path;
		this.assertInsideProject(project, target);
		// 目录型 skill 代表一个完整能力包；删除时移除整个包目录，根 markdown 只删除单文件。
		await rm(target, { recursive: true, force: true });
	}

	async toggleSkill(projectId: string, skillPath: string, enabled: boolean): Promise<PiSkillSummary> {
		const project = this.requireProject(projectId);
		const skill = await this.findSkill(project, skillPath);
		this.assertInsideProject(project, skill.path);
		const raw = await readFile(skill.path, "utf8");
		const next = this.setFrontmatterBoolean(raw, "disable-model-invocation", !enabled);
		await writeFile(skill.path, next, "utf8");
		// 重新读取文件，获取最新 frontmatter 状态
		return this.readSkill(skill.path, this.skillLocations(project).find((l) => l.id === skill.sourceId) ?? this.skillLocations(project)[0], skill.type);
	}

	async toggleExtension(projectId: string, extensionPath: string, enabled: boolean): Promise<void> {
		const project = this.requireProject(projectId);
		this.assertInsideProject(project, extensionPath);
		// 项目级扩展的禁用通过项目的 .pi/settings.json 中的 disabledExtensions 控制
		const settingsFile = join(project.path, ".pi", "settings.json");
		let raw = "{}";
		try { raw = await readFile(settingsFile, "utf8"); } catch {}
		const settings = JSON.parse(raw);
		const disabled: string[] = settings.disabledExtensions ?? [];
		// 使用扩展文件名/目录名作为标识（与 pi list 输出对齐）
		const extName = extensionPath.split(/[\\/]/).pop() ?? extensionPath;
		if (enabled) {
			settings.disabledExtensions = disabled.filter((s) => s !== extName);
		} else {
			if (!disabled.includes(extName)) {
				settings.disabledExtensions = [...disabled, extName];
			}
		}
		await writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");
	}

	async deleteExtension(projectId: string, extensionPath: string): Promise<void> {
		const project = this.requireProject(projectId);
		const extension = (await this.listExtensions(project)).find((item) => item.path === extensionPath);
		if (!extension?.path) throw new Error(`项目 Extension 不存在：${extensionPath}`);
		this.assertInsideProject(project, extension.path);
		await rm(extension.path, { recursive: true, force: true });
	}

	private async listSkills(project: Project): Promise<PiSkillSummary[]> {
		const groups = await Promise.all(
			this.skillLocations(project).map((location) => this.scanSkillLocation(location)),
		);
		return groups.flat().sort((a, b) => a.name.localeCompare(b.name));
	}

	private async scanSkillLocation(location: PiSkillLocation): Promise<PiSkillSummary[]> {
		const entries = await readdir(location.path, { withFileTypes: true }).catch(() => []);
		const skills: PiSkillSummary[] = [];
		for (const entry of entries) {
			const fullPath = join(location.path, entry.name);
			if (entry.isDirectory()) {
				await this.collectDirectorySkills(fullPath, location, skills);
			} else if (location.rootMarkdownEnabled && entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				skills.push(await this.readSkill(fullPath, location, "markdown"));
			}
		}
		return skills;
	}

	private async collectDirectorySkills(dir: string, location: PiSkillLocation, out: PiSkillSummary[]) {
		const skillPath = join(dir, SKILL_FILE);
		if (existsSync(skillPath)) {
			out.push(await this.readSkill(skillPath, location, "directory"));
			return;
		}
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.isDirectory()) await this.collectDirectorySkills(join(dir, entry.name), location, out);
		}
	}

	private async readSkill(
		skillPath: string,
		location: PiSkillLocation,
		type: PiSkillSummary["type"],
	): Promise<PiSkillSummary> {
		const raw = await readFile(skillPath, "utf8").catch(() => "");
		const frontmatter = this.parseFrontmatter(raw);
		const name = String(frontmatter.name ?? "").trim();
		const description = String(frontmatter.description ?? "").trim();
		const warnings = this.validateSkill(name, description);
		return {
			id: `${location.id}:${skillPath}`,
			name: name || dirname(skillPath).split(/[\\/]/).pop() || "未命名 Skill",
			description,
			path: skillPath,
			dir: dirname(skillPath),
			sourceId: location.id,
			sourceLabel: location.label,
			type,
			enabled: frontmatter["disable-model-invocation"] !== "true",
			valid: warnings.length === 0,
			warnings,
		};
	}

	private async listExtensions(project: Project): Promise<PiExtensionSummary[]> {
		const extensionsDir = join(project.path, ".pi", "extensions");
		const entries = await readdir(extensionsDir, { withFileTypes: true }).catch(() => []);
		const result: PiExtensionSummary[] = [];
		// 读取项目级 disabledExtensions
		let disabledExts = new Set<string>();
		try {
			const raw = await readFile(join(project.path, ".pi", "settings.json"), "utf8");
			const settings = JSON.parse(raw);
			disabledExts = new Set(settings.disabledExtensions ?? []);
		} catch {}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name.endsWith(".d.ts")) continue;
			const fullPath = join(extensionsDir, entry.name);
			if (entry.isFile() && entry.name.endsWith(".ts")) {
				const ext = this.toExtensionSummary(entry.name.slice(0, -3), fullPath);
				ext.enabled = !disabledExts.has(ext.source);
				result.push(ext);
				continue;
			}
			if (entry.isDirectory() && existsSync(join(fullPath, "index.ts"))) {
				const ext = this.toExtensionSummary(entry.name, fullPath);
				ext.enabled = !disabledExts.has(ext.source);
				result.push(ext);
			}
		}
		return result.sort((a, b) => a.source.localeCompare(b.source));
	}

	private toExtensionSummary(name: string, path: string): PiExtensionSummary {
		return {
			id: `project:${path}`,
			source: name,
			path,
			scope: "project",
		};
	}

	private skillLocations(project: Project): PiSkillLocation[] {
		return [
			{
				id: "project-pi",
				label: ".pi/skills",
				path: join(project.path, ".pi", "skills"),
				rootMarkdownEnabled: true,
			},
			{
				id: "project-agents",
				label: ".agents/skills",
				path: join(project.path, ".agents", "skills"),
				rootMarkdownEnabled: false,
			},
		];
	}

	private requireProject(projectId: string) {
		const project = this.getProject(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (project.kind === "chat") throw new Error("Chat 项目不支持项目级资源");
		return project;
	}

	private async findSkill(project: Project, skillPath: string) {
		const skill = (await this.listSkills(project)).find((item) => item.path === skillPath);
		if (!skill) throw new Error(`项目 Skill 不存在：${skillPath}`);
		return skill;
	}

	private assertInsideProject(project: Project, targetPath: string) {
		const root = resolve(project.path);
		const target = resolve(targetPath);
		const rel = relative(root, target);
		// 所有删除/创建都必须落在当前项目目录内，防止 renderer 传入任意路径误删全局资源。
		if (rel.startsWith("..") || rel === "" || resolve(root, rel) !== target) {
			throw new Error("资源路径不在项目目录内，已拒绝操作");
		}
	}

	private parseFrontmatter(raw: string) {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const result: Record<string, string> = {};
		if (!match) return result;
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			let value = line.slice(index + 1).trim();
			value = value.replace(/^[\'"]|[\'"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
	}

	private validateSkill(name: string, description: string) {
		const warnings: string[] = [];
		if (!name) warnings.push("缺少 name");
		if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
			warnings.push("name 只能包含小写字母、数字和单个连字符");
		}
		if (name.length > 64) warnings.push("name 超过 64 个字符");
		if (!description) warnings.push("缺少 description，pi 不会加载该 skill");
		if (description.length > 1024) warnings.push("description 超过 1024 个字符");
		return warnings;
	}

	private setFrontmatterBoolean(raw: string, key: string, value: boolean) {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) return `---\n${key}: ${value}\n---\n\n${raw}`;
		const lines = match[1].split(/\r?\n/);
		let changed = false;
		const nextLines = lines.map((line) => {
			if (!line.trim().startsWith(`${key}:`)) return line;
			changed = true;
			return `${key}: ${value}`;
		});
		if (!changed) nextLines.push(`${key}: ${value}`);
		return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
	}

	private normalizeSkillName(value: string) {
		return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	}
}
