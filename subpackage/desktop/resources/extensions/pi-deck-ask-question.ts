/**
 * PiDeck Ask Question Extension
 *
 * 注册 ask_question 工具，让 LLM 可以向用户提问并从桌面端 UI 获取回答。
 * 使用 pi RPC Extension UI Protocol（ctx.ui.select/confirm/input/editor）实现用户交互，
 * 桌面端处理 extension_ui_request/response 协议循环。
 *
 * 支持的提问类型：
 *   - select：选项选择
 *   - confirm：是/否确认
 *   - input：单行文本输入
 *   - editor：多行文本输入（类似于 ctx.ui.editor）
 *
 * 覆盖 ctx.hasUI 检查，非交互模式下跳过；
 * UI 调用包 try-catch 处理用户取消场景。
 *
 * @packageDocumentation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description: [
			"Ask the user to provide input, make a selection, or confirm an action.",
			"The tool blocks until the user responds through the desktop UI.",
			"Use this when you need the user to make a decision, choose between options, or provide text input.",
		].join(" "),
		promptSnippet: "Ask the user a question and wait for a response",
		promptGuidelines: [
			"Use ask_question when you need the user to choose an option (type:select with options list), confirm an action (type:confirm), provide text input (type:input), or write multi-line content (type:editor).",
			"Use ask_question instead of guessing when the user's intent is ambiguous.",
			"Always provide clear options for type:select; options are required for select.",
		],
		parameters: Type.Object({
			type: StringEnum(["select", "confirm", "input", "editor"], {
				description: "Type of question to ask",
			}),
			question: Type.String({
				description: "The question or prompt to show to the user",
			}),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "Options for select type questions",
				}),
			),
			placeholder: Type.Optional(
				Type.String({
					description: "Placeholder text for input/editor type questions",
				}),
			),
			prefill: Type.Optional(
				Type.String({
					description: "Prefill text for input/editor type questions",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 非交互模式下（headless 场景），不阻塞直接返回提示。
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "ask_question 无法执行：当前环境不支持交互式 UI。",
						},
					],
					details: { question: params.question, type: params.type, answered: false },
				};
			}

			// 选择题必须有选项
			if (
				params.type === "select" &&
				(!Array.isArray(params.options) || params.options.length === 0)
			) {
				return {
					content: [
						{
							type: "text",
							text: "ask_question 未执行：select 类型必须提供 options。",
						},
					],
					details: {
						question: params.question,
						type: params.type,
						answered: false,
						error: "select requires non-empty options",
					},
				};
			}

			try {
				let answer: string | boolean | undefined | null;

				if (params.type === "select") {
					const selected = await ctx.ui.select(params.question, params.options!);
					answer = selected;
				} else if (params.type === "confirm") {
					// 描述留空，question 本身已是完整提示
					const confirmed = await ctx.ui.confirm(params.question, params.question);
					answer = confirmed;
				} else if (params.type === "editor") {
					// editor 是多行编辑，prefill 作为初始内容；备用回退到 input。
					const text = await ctx.ui.editor(params.question, params.prefill ?? "");
					answer = text;
				} else {
					// input 类型
					const text = await ctx.ui.input(params.question, params.placeholder ?? "");
					answer = text;
				}

				return {
					content: [
						{
							type: "text",
							text: `用户回答: ${JSON.stringify(answer)}`,
						},
					],
					details: {
						question: params.question,
						type: params.type,
						answer,
						answered: answer !== undefined && answer !== null,
					},
				};
			} catch {
				// 用户取消（cancelled: true）会触发框架层抛出；返回干净的错误结果，不崩工具。
				return {
					content: [
						{
							type: "text",
							text: `用户取消了提问: ${params.question}`,
						},
					],
					details: {
						question: params.question,
						type: params.type,
						answer: null,
						answered: false,
						cancelled: true,
					},
				};
			}
		},
	});
}
