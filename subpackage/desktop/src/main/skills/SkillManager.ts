import { shell } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
	CreatePiSkillInput,
	PiSkillListResult,
	PiSkillLocation,
	PiSkillSummary,
} from "../../shared/types";
import { AGENTBOSTER_SKILLS_DIR } from "../config/agent-paths";

const SKILL_FILE = "SKILL.md";

/**
 * 管理 agentboster 全局 Skill 目录。
 * 第一版仅操作全局目录，不触碰项目级 .agentboster/.agents skills，避免误删项目资产或绕过 trusted project 规则。
 */
export class SkillManager {
	private readonly locations: PiSkillLocation[];

	constructor(home = homedir()) {
		this.locations = [
			{
				id: "pi-global",
				label: "~/.agentboster/agent/skills",
				path: AGENTBOSTER_SKILLS_DIR,
				rootMarkdownEnabled: true,
			},
			{
				id: "agents-global",
				label: "~/.agents/skills",
				path: join(home, ".agents", "skills"),
				rootMarkdownEnabled: false,
			},
		];
	}

	async list(): Promise<PiSkillListResult> {
		const skills = (
			await Promise.all(this.locations.map((location) => this.scanLocation(location)))
		).flat();
		return { locations: this.locations, skills };
	}

	async create(input: CreatePiSkillInput): Promise<PiSkillSummary> {
		const location = this.requireLocation(input.locationId);
		const name = this.normalizeSkillName(input.name);
		const description = input.description.trim();
		if (!name) throw new Error("Skill 名称只能包含小写字母、数字和连字符");
		if (!description) throw new Error("Skill 描述不能为空");

		const skillDir = join(location.path, name);
		if (existsSync(skillDir)) throw new Error(`Skill 已存在：${name}`);
		await mkdir(skillDir, { recursive: true });
		const skillPath = join(skillDir, SKILL_FILE);
		await writeFile(
			skillPath,
			`---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n# ${name}\n\n## Usage\n\nDescribe when and how to use this skill.\n`,
			"utf8",
		);
		return this.readSkill(skillPath, location, "directory");
	}

	async toggle(skillPath: string, enabled: boolean): Promise<PiSkillSummary> {
		const skill = await this.findByPath(skillPath);
		const raw = await readFile(skill.path, "utf8");
		const next = this.setFrontmatterBoolean(raw, "disable-model-invocation", !enabled);
		await writeFile(skill.path, next, "utf8");
		return this.findByPath(skill.path);
	}

	async delete(skillPath: string): Promise<void> {
		const skill = await this.findByPath(skillPath);
		// 目录型 skill 删除整个目录；根 markdown skill 仅删除单个 md 文件。
		await rm(skill.type === "directory" ? skill.dir : skill.path, {
			recursive: true,
			force: true,
		});
	}

	async openFolder(skillPath?: string): Promise<void> {
		if (!skillPath) {
			await mkdir(this.locations[0].path, { recursive: true });
			await shell.openPath(this.locations[0].path);
			return;
		}
		const skill = await this.findByPath(skillPath);
		await shell.openPath(skill.dir);
	}

	private async scanLocation(location: PiSkillLocation): Promise<PiSkillSummary[]> {
		await mkdir(location.path, { recursive: true });
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
		return skills.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async collectDirectorySkills(
		dir: string,
		location: PiSkillLocation,
		out: PiSkillSummary[],
	) {
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
			dir: type === "directory" ? dirname(skillPath) : dirname(skillPath),
			sourceId: location.id,
			sourceLabel: location.label,
			type,
			enabled: frontmatter["disable-model-invocation"] !== "true",
			valid: warnings.length === 0,
			warnings,
		};
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
			value = value.replace(/^['\"]|['\"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
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

	private normalizeSkillName(value: string) {
		return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	}

	private requireLocation(id: PiSkillLocation["id"]) {
		const location = this.locations.find((item) => item.id === id);
		if (!location) throw new Error(`未知 Skill 位置：${id}`);
		return location;
	}

	private async findByPath(skillPath: string) {
		const { skills } = await this.list();
		const skill = skills.find((item) => item.path === skillPath);
		if (!skill) throw new Error(`Skill 不存在：${skillPath}`);
		return skill;
	}
}
