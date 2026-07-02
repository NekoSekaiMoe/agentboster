import type { AgentTab, SessionSummary } from "../../shared/types";

const DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT = 5;

export type ProjectChildItem =
	| {
			type: "agent";
			key: string;
			agent: AgentTab;
			sortAt: number;
			/** 该 Agent 对应的会话来源（历史会话激活时从 SessionSummary 传递） */
			source?: "pi" | "codex" | "claude" | "opencode";
			codexSubagents: SessionSummary[];
	  }
	| {
			type: "session";
			key: string;
			session: SessionSummary;
			sortAt: number;
			codexSubagents: SessionSummary[];
	  };

export type ProjectAgentSessionDisplay = {
	children: ProjectChildItem[];
	visibleChildren: ProjectChildItem[];
	hiddenChildCount: number;
};

// 会话文件路径可能来自扫描器或 Agent 状态回写，比较时统一分隔符和大小写，避免同一历史会话重复显示/重复激活。
export function normalizeSessionPathForCompare(sessionPath?: string) {
	return sessionPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isSameSessionPath(left?: string, right?: string) {
	const normalizedLeft = normalizeSessionPathForCompare(left);
	const normalizedRight = normalizeSessionPathForCompare(right);
	return Boolean(
		normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
	);
}

function getSessionKey(sessionPath?: string) {
	return normalizeSessionPathForCompare(sessionPath);
}

function getCodexParentKey(session: SessionSummary) {
	return session.codexSessionId ?? session.id;
}

function getAgentSortAt(agent: AgentTab, sessionByKey: Map<string, SessionSummary>) {
	const sessionKey = getSessionKey(agent.sessionPath);
	// 历史会话激活成 Agent 后仍按原会话更新时间排序；全新 Agent 没有历史文件时按创建时间排到最新。
	return sessionKey ? (sessionByKey.get(sessionKey)?.updatedAt ?? agent.createdAt) : agent.createdAt;
}

function chooseAgentForSession(current: AgentTab, candidate: AgentTab) {
	// 如果异常状态下同一个 sessionPath 已经产生多个 Agent，UI 只保留一个：优先保留更新创建的运行态，避免继续暴露重复入口。
	if (candidate.createdAt !== current.createdAt) {
		return candidate.createdAt > current.createdAt ? candidate : current;
	}
	return candidate.status === "running" ? candidate : current;
}

export function getProjectAgentSessionDisplay({
	agents,
	sessions,
	visibleChildCount,
}: {
	agents: AgentTab[];
	sessions: SessionSummary[];
	visibleChildCount?: number;
}): ProjectAgentSessionDisplay {
	const sessionByKey = new Map<string, SessionSummary>();
	const unkeyedSessions: SessionSummary[] = [];
	const codexSubagentsByParent = new Map<string, SessionSummary[]>();
	const parentCandidateSessions = sessions.filter(
		(session) => session.codexThreadSource !== "subagent",
	);
	const parentCodexIds = new Set(
		parentCandidateSessions.map(getCodexParentKey).filter(Boolean),
	);
	for (const session of sessions) {
		if (
			session.codexThreadSource === "subagent" &&
			session.codexParentThreadId &&
			parentCodexIds.has(session.codexParentThreadId)
		) {
			const children = codexSubagentsByParent.get(session.codexParentThreadId) ?? [];
			children.push(session);
			codexSubagentsByParent.set(session.codexParentThreadId, children);
			continue;
		}
		const sessionKey = getSessionKey(session.filePath);
		if (sessionKey) sessionByKey.set(sessionKey, session);
		else unkeyedSessions.push(session);
	}

	const agentBySessionKey = new Map<string, AgentTab>();
	const unkeyedAgents: AgentTab[] = [];
	for (const agent of agents) {
		const sessionKey = getSessionKey(agent.sessionPath);
		if (!sessionKey) {
			unkeyedAgents.push(agent);
			continue;
		}
		const current = agentBySessionKey.get(sessionKey);
		agentBySessionKey.set(
			sessionKey,
			current ? chooseAgentForSession(current, agent) : agent,
		);
	}

	const children: ProjectChildItem[] = [
		...unkeyedAgents.map<ProjectChildItem>((agent) => ({
			type: "agent",
			key: `agent:${agent.id}`,
			agent,
			sortAt: agent.createdAt,
			codexSubagents: [],
		})),
		...[...agentBySessionKey.entries()].map<ProjectChildItem>(
			([sessionKey, agent]) => {
				const linkedSession = sessionByKey.get(sessionKey);
				return {
					type: "agent",
					key: `session-agent:${sessionKey}`,
					agent,
					sortAt: getAgentSortAt(agent, sessionByKey),
					// 历史会话激活为 Agent 后仍携带来源标记，供侧边栏区分导入会话
					source: linkedSession?.source,
					codexSubagents: linkedSession
						? (codexSubagentsByParent.get(getCodexParentKey(linkedSession)) ?? [])
						: [],
				};
			},
		),
		...[...sessionByKey.entries()]
			.filter(([sessionKey]) => !agentBySessionKey.has(sessionKey))
			.map<ProjectChildItem>(([sessionKey, session]) => ({
				type: "session",
				key: `session:${sessionKey}`,
				session,
				sortAt: session.updatedAt,
				codexSubagents: codexSubagentsByParent.get(getCodexParentKey(session)) ?? [],
			})),
		...unkeyedSessions.map<ProjectChildItem>((session) => ({
			type: "session",
			key: `session-file:${session.filePath}`,
			session,
			sortAt: session.updatedAt,
			codexSubagents: codexSubagentsByParent.get(getCodexParentKey(session)) ?? [],
		})),
	].sort((left, right) => right.sortAt - left.sortAt);

	const limit = visibleChildCount ?? DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT;
	const visibleChildren = children.slice(0, limit);
	return {
		children,
		visibleChildren,
		hiddenChildCount: Math.max(0, children.length - visibleChildren.length),
	};
}
