export type SendShortcut =
	| "enter-send"
	| "ctrl-enter-send"
	| "shift-enter-send";

export type ComposerEnterIntent = "ignore" | "newline" | "send";

import type { ComposerAgentMode } from "@shared/types";

export const PI_DECK_PLAN_MODE_MARKER = "__PI_DECK_PLAN_MODE__";

export type ComposerPromptSubmission = {
	/** 用户在 PiDeck 时间线里看到的原始消息，不能包含桌面端内部控制标记。 */
	message: string;
	/** 仅发给 pi agent/extension 的隐藏消息，用于触发桌面端专属模式。 */
	agentMessage?: string;
};

/**
 * 构造发送给主进程的 composer 快照。
 * Plan 模式依赖 PiDeck 内置 extension 在 pi 的 input 事件里识别隐藏标记；
 * 用户可见消息保持原文，避免会话时间线出现实现细节或控制 token。
 */
export function buildComposerPromptSubmission(
	message: string,
	mode: ComposerAgentMode,
): ComposerPromptSubmission {
	if (mode !== "plan") return { message };

	const visibleInstruction = message.trim() || "请根据已附加的图片或上下文先制定实施计划。";
	return {
		message,
		agentMessage: [
			PI_DECK_PLAN_MODE_MARKER,
			visibleInstruction,
			"",
			"请先只做只读分析，不要修改文件。最后必须输出以 `Plan:` 开头的编号计划，格式如下：",
			"Plan:",
			"1. 第一步",
			"2. 第二步",
		].join("\n"),
	};
}

type ComposerKeyboardState = {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	isComposing?: boolean;
	keyCode?: number;
	which?: number;
	nativeEvent?: {
		isComposing?: boolean;
		keyCode?: number;
		which?: number;
	};
};

/**
 * 归一化输入框 Enter 键意图，避免 React 组件里散落快捷键判断。
 * IME 回车确认会先发出 composing 状态的 Enter，这时必须交给输入法处理，
 * 否则中文输入法里选择英文候选也会被误判为发送消息。
 */
export function getComposerEnterIntent(
	event: ComposerKeyboardState,
	sendShortcut: SendShortcut,
): ComposerEnterIntent {
	if (event.key !== "Enter") return "ignore";
	if (isComposingInput(event)) return "ignore";

	const shouldSend =
		sendShortcut === "enter-send"
			? !event.ctrlKey && !event.metaKey && !event.shiftKey
			: sendShortcut === "ctrl-enter-send"
				? event.ctrlKey || event.metaKey
				: event.shiftKey;

	if (shouldSend) return "send";
	return "newline";
}

function isComposingInput(event: ComposerKeyboardState) {
	// keyCode/which=229 是部分 Chromium/macOS 输入法在 composition 期间的兼容信号。
	return Boolean(
		event.isComposing ||
			event.nativeEvent?.isComposing ||
			event.key === "Process" ||
			event.keyCode === 229 ||
			event.which === 229 ||
			event.nativeEvent?.keyCode === 229 ||
			event.nativeEvent?.which === 229,
	);
}
