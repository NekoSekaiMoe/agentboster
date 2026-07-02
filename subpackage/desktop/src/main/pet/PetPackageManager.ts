import { app } from "electron";
import { readFile, stat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, extname } from "node:path";
import type { PetManifest } from "../../shared/types";
import clawdSprite from "../../../build/pets/clawd-3/spritesheet.webp?asset";
import cacheCapySprite from "../../../build/pets/cache-capy/spritesheet.webp?asset";
import duoSprite from "../../../build/pets/duo/spritesheet.webp?asset";
import octohackSprite from "../../../build/pets/octohack/spritesheet.webp?asset";
import fangjiaSprite from "../../../build/pets/fangjia/spritesheet.webp?asset";

/**
 * PetPackageManager —— 内置 + petdex 双轨宠物包管理。
 * spritesheet 转 data: URL（避免 http→file:// 跨域）。
 */

function mimeOf(p: string): string {
	const ext = extname(p).toLowerCase();
	const map: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif" };
	return map[ext] ?? "application/octet-stream";
}

async function toDataUrl(p: string): Promise<string | null> {
	try {
		const buf = await readFile(p);
		return `data:${mimeOf(p)};base64,${buf.toString("base64")}`;
	} catch { return null; }
}

async function fileExists(p: string): Promise<boolean> {
	try { return (await stat(p)).isFile(); } catch { return false; }
}

type PetDexManifest = { id: string; displayName?: string; description?: string; spritesheetPath: string };

export class PetPackageManager {
	// 内置宠物包：随应用打包，优先级高于同名 petdex 社区包（list 中 byId 去重时先放入）。
	// 限定这 5 个为默认可选项，避免随机占盘与体积膨胀。
	private readonly builtin = [
		{ id: "clawd", displayName: "Clawd", description: "A tiny pixel Clawd companion made from your sticker GIFs.", spritePath: clawdSprite },
		{ id: "cache-capy", displayName: "Cache Capy", description: "A calm capybara carrying a tiny cache box for patient builds.", spritePath: cacheCapySprite },
		{ id: "duo", displayName: "Duo", description: "Learning companion with expressive chibi sprite poses.", spritePath: duoSprite },
		{ id: "octohack", displayName: "OctoHack", description: "A tiny Octocat-inspired chibi digital pet with a black cat head, cream face, whiskers, tentacle limbs, and a blue-dotted tentacle tail.", spritePath: octohackSprite },
		{ id: "fangjia", displayName: "FangJia", description: "FangJia is the mascot of switchbase.vip.", spritePath: fangjiaSprite },
	];

	async list(): Promise<PetManifest[]> {
		const byId = new Map<string, PetManifest>();

		// 内置包
		for (const m of this.builtin) {
			const url = await toDataUrl(m.spritePath);
			if (url) byId.set(m.id, { id: m.id, displayName: m.displayName, description: m.description, source: "builtin", spritesheetUrl: url });
		}

		// petdex 社区包：~/.codex/pets/<name>/pet.json
		const petsRoot = join(app.getPath("home"), ".codex", "pets");
		let entries: Dirent[] = [];
		try { entries = await readdir(petsRoot, { withFileTypes: true }); } catch { /* 目录不存在 */ }

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = join(petsRoot, entry.name);
			try {
				const raw = await readFile(join(dir, "pet.json"), "utf8");
				const json = JSON.parse(raw) as PetDexManifest;
				if (!json.id || !json.spritesheetPath) continue;
				const spriteAbs = join(dir, json.spritesheetPath);
				if (!(await fileExists(spriteAbs))) continue;
				if (byId.has(json.id)) continue; // 内置优先
				const url = await toDataUrl(spriteAbs);
				if (url) byId.set(json.id, { id: json.id, displayName: json.displayName ?? json.id, description: json.description, source: "petdex", spritesheetUrl: url });
			} catch { /* 单个包失败不影响整体 */ }
		}

		return [...byId.values()];
	}

	async get(id: string): Promise<PetManifest | null> {
		return (await this.list()).find(m => m.id === id) ?? null;
	}
}
