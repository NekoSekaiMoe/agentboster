/**
 * SessionScanner — desktop 列出 / 重命名 / 删除远端会话的客户端。
 *
 * 历史版本基于本地文件系统（扫描 `~/.pi/agent/sessions/*.jsonl`），
 * 但 agentboster CLI 是 Web backend 的瘦客户端：会话的真源（source of
 * truth）在 Web 的 `sessions` 数据库表，本地只是 tmp 镜像，退出即清。
 *
 * 本类改为通过 Web API 操作：
 *   - list:   GET  /api/cli/sessions
 *   - rename: PATCH /api/cli/sessions/[id]  { title }
 *   - delete: DELETE /api/cli/sessions/[id]
 *
 * 凭据从 `~/.agentboster/config.json` 读取（与 agentboster CLI 共享，
 * 由 `agentboster login` 写入；参见
 * subpackage/cli/packages/agentboster-adapter/src/auth.ts）。
 *
 * `projectPath` 参数保留在 list() 签名中是为了兼容旧 IPC，但 Web 没有
 * 项目维度的过滤概念（一个用户的所有会话都属于同一个 web 账号），
 * 因此该参数被忽略，desktop UI 需要在前端自行做客户端过滤。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppLogger } from "../logging/AppLogger.js";
import type { SessionSummary } from "../../shared/types";

const SCOPE = "session-scanner";
const logger = new AppLogger();

interface AgentbosterConfig {
	url?: string;
	token?: string;
	username?: string;
}

interface RemoteSession {
	id: string;
	title: string | null;
	channel: string | null;
	model: string | null;
	totalTokens: number | null;
	createdAt: string;
	updatedAt: string;
}

export class SessionScanner {
	/**
	 * 读取 ~/.agentboster/config.json。文件不存在或解析失败都返回 null
	 * （未登录状态，desktop UI 应引导用户去跑 `agentboster login`）。
	 */
	private readConfig(): AgentbosterConfig | null {
		const home = process.env.AGENTBOSTER_HOME ?? join(homedir(), ".agentboster");
		const path = join(home, "config.json");
		if (!existsSync(path)) return null;
		try {
			return JSON.parse(readFileSync(path, "utf8")) as AgentbosterConfig;
		} catch (error) {
			logger.warn(SCOPE, "failed to parse ~/.agentboster/config.json", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	private async request(
		path: string,
		init: RequestInit = {},
	): Promise<Response> {
		const config = this.readConfig();
		if (!config?.url || !config?.token) {
			throw new Error(
				"Not logged in: ~/.agentboster/config.json missing or has no token. Run `agentboster login` in a terminal first.",
			);
		}
		const base = config.url.replace(/\/+$/, "");
		const url = `${base}${path}`;
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${config.token}`);
		if (init.body && !headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}
		return fetch(url, { ...init, headers });
	}

	async list(_projectPath?: string): Promise<SessionSummary[]> {
		let resp: Response;
		try {
			resp = await this.request("/api/cli/sessions?limit=100");
		} catch (error) {
			logger.warn(SCOPE, "list request failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
		if (!resp.ok) {
			logger.warn(SCOPE, "list request non-ok", { status: resp.status });
			return [];
		}
		const data = (await resp.json()) as { sessions?: RemoteSession[] };
		const sessions = data.sessions ?? [];
		return sessions.map((s) => this.adapt(s)).sort(
			(a, b) => b.updatedAt - a.updatedAt,
		);
	}

	async rename(sessionId: string, newName: string): Promise<void> {
		const resp = await this.request(`/api/cli/sessions/${encodeURIComponent(sessionId)}`, {
			method: "PATCH",
			body: JSON.stringify({ title: newName }),
		});
		if (!resp.ok) {
			const text = await resp.text().catch(() => "");
			throw new Error(
				`rename session ${sessionId} failed: ${resp.status} ${text}`,
			);
		}
	}

	async delete(sessionId: string): Promise<void> {
		const resp = await this.request(
			`/api/cli/sessions/${encodeURIComponent(sessionId)}`,
			{ method: "DELETE" },
		);
		if (!resp.ok) {
			const text = await resp.text().catch(() => "");
			throw new Error(
				`delete session ${sessionId} failed: ${resp.status} ${text}`,
			);
		}
	}

	/**
	 * Web API session → desktop SessionSummary。filePath/id 都填 web 的
	 * session id，desktop UI 历史上用 filePath 做唯一 key。messageCount
	 * Web 端没暴露，先填 0（UI 主要显示 updatedAt 和 title）。
	 */
	private adapt(s: RemoteSession): SessionSummary {
		const updatedAtMs = Date.parse(s.updatedAt).valueOf();
		return {
			id: s.id,
			filePath: s.id,
			projectPath: undefined,
			name: s.title ?? undefined,
			preview: s.model ?? "",
			updatedAt: Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now(),
			messageCount: 0,
			source: "pi",
		};
	}
}
