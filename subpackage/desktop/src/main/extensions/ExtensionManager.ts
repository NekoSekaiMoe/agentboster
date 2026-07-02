import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings, PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, PiUpdateCheckResult } from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";
import { AGENTBOSTER_EXTENSIONS_DIR, AGENTBOSTER_SETTINGS_FILE } from "../config/agent-paths";

type SettingsProvider = () => AppSettings;

/**
 * 通过 pi CLI 管理已安装扩展，避免桌面端直接改写 pi settings 导致和 CLI 行为不一致。
 * list/remove 都使用 --no-approve，防止配置弹窗因为项目级信任确认而阻塞。
 */
export class ExtensionManager {
	constructor(
		private readonly locator: PiLocator,
		private readonly getSettings: SettingsProvider,
	) {}

	async list(): Promise<PiExtensionListResult> {
		const raw = await this.runPi(["list", "--no-approve"], 20_000);
		const piInstalled = await Promise.all(
			this.parseListOutput(raw).map((extension) => this.enrichExtensionVersion(extension)),
		);

		// 扫描本地自动发现的扩展（~/.agentboster/agent/extensions/ 下的 .ts 文件和目录），
		// pi list 只列出通过 pi install 安装的包，不包含本地文件扩展。
		const localExtensions = await this.scanLocalExtensions();

		// 合并，已通过 pi 安装的优先保留原条目
		const installedPaths = new Set(piInstalled.map((ext) => ext.path));
		const merged = [...piInstalled];
		for (const local of localExtensions) {
			if (!local.path || !installedPaths.has(local.path)) {
				merged.push(local);
			}
		}

				// 读取 disabledExtensions 列表，标记扩展启用/禁用状态
		const disabledExts = await this.getDisabledExtensions();
		for (const ext of merged) {
			ext.enabled = !disabledExts.has(ext.source);
		}
		return { extensions: merged, raw };
	}

	/**
	 * 扫描 ~/.agentboster/agent/extensions/ 目录，发现未被 pi list 列出的本地扩展。
	 * 单文件扩展（.ts 文件）和目录扩展（含 index.ts）都会被识别。
	 */
	private async scanLocalExtensions(): Promise<PiExtensionSummary[]> {
		const extensionsDir = AGENTBOSTER_EXTENSIONS_DIR;
		const result: PiExtensionSummary[] = [];

		let entries: string[];
		try {
			entries = await readdir(extensionsDir);
		} catch {
			return result; // 目录不存在时静默跳过
		}

		for (const entry of entries) {
			if (entry.startsWith(".") || entry === "node_modules" || entry.endsWith(".d.ts")) continue;

			const fullPath = join(extensionsDir, entry);
			let name = entry;
			let source = entry;

			// 处理目录扩展（目录/index.ts）
			if (entry.endsWith(".ts")) {
				// 单文件扩展，去掉 .ts 后缀作为显示名
				name = entry.slice(0, -3);
				source = entry;
			} else {
				// 目录扩展，检查是否有 index.ts
				try {
					await readFile(join(fullPath, "index.ts"), "utf-8");
					name = entry;
					source = entry;
				} catch {
					continue; // 没有 index.ts，跳过
				}
			}

			const isBuiltIn = name.startsWith("pi-deck-");
			result.push({
				id: `local:${source}`,
				source,
				path: extensionsDir,
				scope: "user",
				builtIn: isBuiltIn,
			});
		}

		return result;
	}

	async uninstall(source: string, scope: PiExtensionSummary["scope"] = "user"): Promise<void> {
		const normalized = source.trim();
		if (!normalized) throw new Error("扩展来源不能为空");
		// 阻止卸载 PiDeck 内置扩展（如 pi-deck-file-capture）
		if (source.startsWith("pi-deck-")) {
			throw new Error("PiDeck 内置扩展不可卸载");
		}
		await this.runPi([
			"remove",
			normalized,
			...(scope === "project" ? ["-l"] : []),
			"--no-approve",
		], 30_000);
	}

	async install(source: string): Promise<string> {
		const normalized = source.trim();
		if (!normalized) throw new Error("扩展名称不能为空");
		return this.runPi(["install", normalized, "--no-approve"], 60_000);
	}

	/**
	 * agentboster CLI 暂未实现 self-update 子命令（pi 的 `update pi` 在 agentboster
	 * 不存在）。这里返回固定 no-update 结果，避免 desktop UI 调用时报错。后续若
	 * agentboster CLI 加上 self-update（例如通过 npm 包或独立 updater），
	 * 可以在这里恢复实际的版本比较 + 触发逻辑。
	 */
	async checkPiUpdate(): Promise<PiUpdateCheckResult> {
		try {
			const status = await this.locator.check(this.getSettings().customPiPath);
			return {
				currentVersion: status.version,
				latestVersion: status.version,
				hasUpdate: false,
			};
		} catch (error) {
			return { hasUpdate: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async updatePi(): Promise<PiCliUpdateResult> {
		return {
			command: "(agentboster self-update not supported)",
			output: "agentboster CLI 暂未提供 self-update 子命令；请通过包管理器或重新构建更新。",
			updated: false,
		};
	}

	/**
	 * agentboster CLI 没有 `update --extensions` 子命令。返回 stub 避免运行时报错。
	 * 单个扩展的更新由其 npm 源决定，用户可通过 uninstall+install 重新拉取最新版本。
	 */
	async updateExtensions(): Promise<PiCliUpdateResult> {
		return {
			command: "(agentboster extensions update not supported)",
			output: "agentboster CLI 暂未提供批量扩展更新子命令；请卸载后重装需要更新的扩展。",
			updated: false,
		};
	}

	private async enrichExtensionVersion(extension: PiExtensionSummary): Promise<PiExtensionSummary> {
		if (!extension.source.toLowerCase().startsWith("npm:")) return extension;
		const packageName = extension.source.replace(/^npm:/i, "");
		try {
			const [currentVersion, latestVersion] = await Promise.all([
				this.readInstalledVersion(extension.path),
				this.npmViewVersion(packageName),
			]);
			return {
				...extension,
				currentVersion,
				latestVersion,
				hasUpdate: Boolean(currentVersion && latestVersion && this.compareVersions(latestVersion, currentVersion) > 0),
			};
		} catch (error) {
			return { ...extension, updateError: error instanceof Error ? error.message : String(error) };
		}
	}

	private async readInstalledVersion(path?: string) {
		if (!path) return undefined;
		const raw = await readFile(join(path, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version;
	}

	private npmViewVersion(packageName: string) {
		const invocation = this.locator.createInvocation("npm", ["view", packageName, "version"]);
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix),
					shell: invocation.shell,
					windowsHide: true,
					timeout: 30_000,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						// Electron 启动环境经常缺少用户 shell PATH；通过 PiLocator 补齐 PATH 后仍失败时，把 stderr 透出给设置页。
						reject(new Error((stderr || error.message).trim()));
						return;
					}
					resolve(stdout.trim());
				},
			);
		});
	}

	private toUpdateResult(command: string, output: string, updated: boolean): PiCliUpdateResult {
		return { command, output: output.trim(), updated };
	}

	private compareVersions(a: string, b: string) {
		const left = a.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
		const right = b.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
		const len = Math.max(left.length, right.length);
		for (let index = 0; index < len; index += 1) {
			const diff = (left[index] ?? 0) - (right[index] ?? 0);
			if (diff !== 0) return diff;
		}
		return 0;
	}

	async setEnabled(source: string, enabled: boolean): Promise<void> {
		const settingsPath = AGENTBOSTER_SETTINGS_FILE;
		let raw = "{}";
		try { raw = await readFile(settingsPath, "utf8"); } catch {}
		const settings = JSON.parse(raw);
		const disabled: string[] = settings.disabledExtensions ?? [];
		if (enabled) {
			settings.disabledExtensions = disabled.filter((s) => s !== source);
		} else {
			if (!disabled.includes(source)) {
				settings.disabledExtensions = [...disabled, source];
			}
		}
		await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
	}

	private async getDisabledExtensions(): Promise<Set<string>> {
		const settingsPath = AGENTBOSTER_SETTINGS_FILE;
		try {
			const raw = await readFile(settingsPath, "utf8");
			const settings = JSON.parse(raw);
			return new Set<string>(settings.disabledExtensions ?? []);
		} catch {
			return new Set<string>();
		}
	}

	private async runPi(args: string[], timeout: number, options: { offline?: boolean } = {}) {
		const command = this.locator.resolveCommand(this.getSettings().customPiPath);
		const invocation = this.locator.createInvocation(command, args);
		const env = this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix);
		// list/remove/install 使用离线模式避免配置页被网络和包管理器输出拖慢；update 必须允许联网，
		// 否则 pi 只会返回简化的 Updated packages，无法真正走 npm 更新流程。
		if (options.offline !== false) env.PI_OFFLINE = "1";
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env,
					shell: invocation.shell,
					windowsHide: true,
					timeout,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						const detail = (stderr || error.message).trim();
						reject(new Error(detail || "pi 扩展命令执行失败"));
						return;
					}
					resolve(stdout);
				},
			);
		});
	}

	private parseListOutput(raw: string): PiExtensionSummary[] {
		const result: PiExtensionSummary[] = [];
		let scope: PiExtensionSummary["scope"] = "unknown";
		let pending: PiExtensionSummary | null = null;

		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (/^User packages:/i.test(trimmed)) {
				scope = "user";
				pending = null;
				continue;
			}
			if (/^Project packages:/i.test(trimmed)) {
				scope = "project";
				pending = null;
				continue;
			}

			if (/^(?:npm|file|github|git|https?):/i.test(trimmed)) {
				pending = {
					id: `${scope}:${trimmed}`,
					source: trimmed,
					scope,
				};
				result.push(pending);
				continue;
			}

			if (pending && !pending.path) {
				pending.path = trimmed;
			}
		}

		return result;
	}
}
