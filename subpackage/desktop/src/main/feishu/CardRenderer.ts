/**
 * CardRenderer v5 — RunState → 飞书 interactive 卡片 JSON
 *
 * v5 设计简化，与 PiDeck 界面风格统一：
 * - 无彩色 header，无 hr 分割线，干净的消息流
 * - 活动轨迹紧凑排列，去掉标题
 * - 思考过程用小字，工具调用简洁
 * - 底部简单标注状态
 */

import type { Block, RunState, ToolEntry, TrailEntry } from "./CardRunState";
import { markdownToCardElements } from "./rich-text";

const OUTPUT_MAX = 15_000;
const THINKING_MAX = 2_000;
const TRAIL_ENTRIES_MAX = 20;

export interface RenderOptions {
	stopHint?: string;
}

export function renderRunCard(state: RunState, opts: RenderOptions = {}): object {
	const elements: object[] = [];
	const isRunning = state.terminal === "running";

	// ── 1. 活动轨迹（去掉标题，紧凑展示） ──
	elements.push(renderTrail(state.trail, isRunning));

	// ── 2. 思考过程 ──
	if (state.reasoning.content) {
		elements.push(renderThinking(state.reasoning.content, state.reasoning.active));
	}

	// ── 3. 正在执行的操作 ──
	const runningTools = state.blocks.filter(
		(b) => b.kind === "tool" && b.tool.status === "running",
	);
	for (const b of runningTools) {
		if (b.kind === "tool") {
			elements.push(renderRunningTool(b.tool));
		}
	}

	// ── 4. 输出正文 ──
	if (state.outputText.trim()) {
		elements.push(...renderOutput(state.outputText, isRunning));
	}

	// ── 5. 已完成的工具 ──
	const doneTools = state.blocks.filter(
		(b) => b.kind === "tool" && b.tool.status !== "running",
	);
	if (doneTools.length > 0) {
		elements.push(renderDoneTools(doneTools));
	}

	// ── 6. 终态提示 ──
	if (state.terminal === "interrupted") {
		elements.push({ tag: "markdown", content: "⏹ 已被中断" });
	} else if (state.terminal === "error" && state.errorMsg) {
		elements.push({ tag: "markdown", content: `❌ 失败: ${state.errorMsg}` });
	}

	// ── 7. 底部状态 ──
	elements.push(renderFooter(state, isRunning, opts.stopHint));

	return {
		config: { wide_screen_mode: true, update_multi: true },
		elements,
	};
}

// ========== 区域渲染 ==========

/** 活动轨迹 — 一行一条，去掉标题，仅保留时间线 */
function renderTrail(trail: TrailEntry[], isRunning: boolean): object {
	let entries = trail;
	let hidden = 0;
	if (entries.length > TRAIL_ENTRIES_MAX) {
		hidden = entries.length - TRAIL_ENTRIES_MAX;
		entries = entries.slice(-TRAIL_ENTRIES_MAX);
	}

	const lines: string[] = [];
	if (entries.length === 0) {
		lines.push(isRunning ? "_等待 Agent 启动..._" : "_无记录_");
	} else {
		if (hidden > 0) lines.push(`_…前面 ${hidden} 条_`);
		for (const e of entries) {
			const time = fmt(e.timestamp);
			const icon = e.status === "running" ? "🔄" : e.status === "error" ? "❌" : "✅";
			let line = `\`${time}\` ${icon} ${e.text}`;
			if (e.detail) line += ` — ${e.detail}`;
			lines.push(line);
		}
	}

	return { tag: "markdown", content: lines.join("\n") };
}

/** 思考过程 — notation 小字 */
function renderThinking(content: string, active: boolean): object {
	const display = content.length > THINKING_MAX
		? content.slice(0, THINKING_MAX) + "\n\n…（已截断）"
		: content;

	const title = active ? "**💭 思考中**" : "**💭 思考过程**";
	return { tag: "markdown", content: `${title}\n${display}`, text_size: "notation" };
}

/** 正在运行的工具 */
function renderRunningTool(tool: ToolEntry): object {
	const preview = toolInputPreview(tool);
	const lines: string[] = [];
	lines.push(`**🔧 正在调用 \`${tool.name}\``);
	if (preview) lines.push(`\`${preview}\``);
	return { tag: "markdown", content: lines.join("\n") };
}

/** 输出正文 */
function renderOutput(text: string, streaming: boolean): object[] {
	const display = text.length > OUTPUT_MAX
		? text.slice(0, OUTPUT_MAX) + "\n\n…（已截断）"
		: text;
	return markdownToCardElements(display);
}

/** 已完成的工具列表 */
function renderDoneTools(blocks: Block[]): object {
	const tools = blocks
		.filter((b) => b.kind === "tool")
		.map((b) => (b as { kind: "tool"; tool: ToolEntry }).tool);

	const MAX = 8;
	let hidden = 0;
	let shown = tools;
	if (tools.length > MAX) {
		hidden = tools.length - MAX;
		shown = tools.slice(0, MAX);
	}

	const lines: string[] = [];
	for (const t of shown) {
		const icon = t.status === "error" ? "❌" : "✅";
		const preview = toolInputPreview(t);
		const previewPart = preview ? ` — \`${preview}\`` : "";
		lines.push(`${icon} **${t.name}**${previewPart}`);
	}
	if (hidden > 0) lines.push(`_…还有 ${hidden} 个_`);

	return { tag: "markdown", content: lines.join("\n") };
}

/** 底部状态 — 简洁一行 */
function renderFooter(state: RunState, isRunning: boolean, stopHint?: string): object {
	const parts: string[] = [];

	if (isRunning) {
		if (state.footer === "thinking") {
			parts.push("🧠 思考中");
		} else if (state.footer === "tool_running") {
			const rt = [...state.blocks].reverse().find(
				(b) => b.kind === "tool" && b.tool.status === "running",
			);
			if (rt?.kind === "tool") parts.push(`🔧 调用 \`${rt.tool.name}\``);
			else parts.push("🔧 调用工具");
		} else if (state.footer === "streaming") {
			parts.push("✍️ 输出中");
		} else {
			parts.push("⏳ 处理中");
		}

		if (stopHint) parts.push(stopHint);
	} else {
		if (state.meta.durationMs !== undefined) {
			parts.push(`⏱ ${(state.meta.durationMs / 1000).toFixed(1)}s`);
		}
		parts.push("✅ 完成");
	}

	return { tag: "note", elements: [{ tag: "plain_text", content: parts.join("  |  ") }] };
}

// ========== 工具函数 ==========

function toolInputPreview(tool: ToolEntry): string {
	const input = tool.input;
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	if (tool.name === "read" && typeof obj.filePath === "string") return clip(obj.filePath, 80);
	if (tool.name === "bash" && typeof obj.command === "string") return clip(obj.command, 80);
	if (tool.name === "write" && typeof obj.filePath === "string") return clip(obj.filePath, 80);
	if (tool.name === "edit" && typeof obj.filePath === "string") return clip(obj.filePath, 80);
	if (tool.name === "grep" && typeof obj.pattern === "string") return clip(obj.pattern, 80);
	if (typeof obj.command === "string") return clip(obj.command, 80);
	if (typeof obj.file_path === "string") return clip(obj.file_path, 80);
	if (typeof obj.path === "string") return clip(obj.path, 80);
	if (typeof obj.pattern === "string") return clip(obj.pattern, 80);
	return "";
}

function fmt(ts: number): string {
	const d = new Date(ts);
	return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function p2(n: number): string {
	return n.toString().padStart(2, "0");
}

function clip(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max) + "…";
}
