import type { AvailableModel } from "../../shared/types";

const MAX_MODEL_BUTTONS = 18;
const BUTTONS_PER_ROW = 3;
const MODEL_ACTION = "pideck.set_model";

type ModelPickerInput = {
	current: string;
	models: AvailableModel[];
};

type ModelAction = {
	provider: string;
	modelId: string;
};

type CardButton = {
	tag: "button";
	text: { tag: "plain_text"; content: string };
	type: "default" | "primary";
	value: { action: string; provider: string; modelId: string };
};

export function buildModelPickerCard({ current, models }: ModelPickerInput) {
	const shown = models.slice(0, MAX_MODEL_BUTTONS);
	const hidden = Math.max(0, models.length - shown.length);
	const elements: object[] = [
		{ tag: "markdown", content: `当前模型：\`${current}\`` },
	];

	for (const [provider, providerModels] of groupByProvider(shown)) {
		elements.push({ tag: "markdown", content: `**${provider}**` });
		for (const row of chunk(providerModels, BUTTONS_PER_ROW)) {
			elements.push({
				tag: "action",
				layout: "flow",
				actions: row.map((model) => modelButton(model, current)),
			});
		}
	}

	const note = hidden > 0
		? `已显示前 ${shown.length} 个模型；其余 ${hidden} 个仍可手动发送 /model provider/modelId 切换。`
		: "点击按钮即可切换当前会话模型。";
	elements.push({ tag: "note", elements: [{ tag: "plain_text", content: note }] });

	return {
		config: { wide_screen_mode: true, update_multi: true },
		header: { title: { tag: "plain_text", content: "切换模型" }, template: "blue" },
		elements,
	};
}

export function parseModelActionValue(value: unknown): ModelAction | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (v.action !== MODEL_ACTION) return undefined;
	if (typeof v.provider !== "string" || !v.provider.trim()) return undefined;
	if (typeof v.modelId !== "string" || !v.modelId.trim()) return undefined;
	return { provider: v.provider, modelId: v.modelId };
}

function modelButton(model: AvailableModel, current: string): CardButton {
	const fullId = `${model.provider}/${model.id}`;
	const isCurrent = current === fullId;
	return {
		tag: "button",
		text: { tag: "plain_text", content: `${isCurrent ? "✓ " : ""}${model.name || model.id}` },
		type: isCurrent ? "default" : "primary",
		value: { action: MODEL_ACTION, provider: model.provider, modelId: model.id },
	};
}

function groupByProvider(models: AvailableModel[]): Array<[string, AvailableModel[]]> {
	const groups = new Map<string, AvailableModel[]>();
	for (const model of models) {
		const list = groups.get(model.provider) ?? [];
		list.push(model);
		groups.set(model.provider, list);
	}
	return Array.from(groups.entries());
}

function chunk<T>(items: T[], size: number): T[][] {
	const rows: T[][] = [];
	for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
	return rows;
}
