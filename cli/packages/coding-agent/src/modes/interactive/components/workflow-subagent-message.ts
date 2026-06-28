import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@agentboster-cli/tui";
import type { CustomMessage, WorkflowSubagentEventDetails } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

type SubagentMessage = CustomMessage<WorkflowSubagentEventDetails>;

function getBackground(event: WorkflowSubagentEventDetails | undefined) {
	if (!event) return "customMessageBg" as const;
	if (event.event === "started") return "toolPendingBg" as const;
	if (event.event === "completed") return "toolSuccessBg" as const;
	return "toolErrorBg" as const;
}

function getTitle(event: WorkflowSubagentEventDetails | undefined): string {
	if (!event) return "Sub-agent";
	if (event.event === "started") return `${event.subagentName} started`;
	if (event.event === "completed") return `${event.subagentName} completed`;
	return `${event.subagentName} failed`;
}

function getCollapsedSummary(event: WorkflowSubagentEventDetails | undefined): string {
	if (!event) return "Sub-agent event";
	if (event.event === "started") return `Running task: ${event.task}`;
	if (event.event === "completed") return event.summary?.trim() || "Completed";
	return event.error?.trim() || "Failed";
}

export class WorkflowSubagentMessageComponent extends Box {
	private readonly message: SubagentMessage;
	private readonly markdownTheme: MarkdownTheme;
	private expanded = false;

	constructor(message: SubagentMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg(getBackground(message.details), t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const event = this.message.details;
		const label = theme.fg("toolTitle", `\x1b[1m[subagent]\x1b[22m ${getTitle(event)}`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (!event) {
			this.addChild(
				new Markdown(typeof this.message.content === "string" ? this.message.content : "Sub-agent event", 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			return;
		}

		if (this.expanded) {
			const detailLines = [
				`**Agent:** ${event.subagentName}`,
				`**State:** ${event.event}`,
				`**Task:** ${event.task}`,
			];
			if (event.modelId) {
				detailLines.push(`**Model:** ${event.modelId}`);
			}
			if (typeof event.steps === "number") {
				detailLines.push(`**Steps:** ${event.steps}`);
			}
			if (event.summary) {
				detailLines.push("", "**Summary**", "", event.summary);
			}
			if (event.error) {
				detailLines.push("", "**Error**", "", event.error);
			}
			this.addChild(
				new Markdown(detailLines.join("\n"), 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			return;
		}

		this.addChild(
			new Text(
				theme.fg("customMessageText", `${getCollapsedSummary(event)} (`) +
					theme.fg("dim", keyText("app.tools.expand")) +
					theme.fg("customMessageText", " to expand)"),
				0,
				0,
			),
		);
	}
}
