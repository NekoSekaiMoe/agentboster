import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModelCardModule() {
	const source = readFileSync("src/main/feishu/ModelPickerCard.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, { filename: "ModelPickerCard.ts" });
	return sandbox.exports;
}

test("builds Feishu model picker card grouped by provider", () => {
	const { buildModelPickerCard } = loadModelCardModule();
	const card = buildModelPickerCard({
		current: "openai/gpt-4o",
		models: [
			{ provider: "openai", id: "gpt-4o", name: "GPT-4o" },
			{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
			{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
		],
	});

	assert.equal(card.config.wide_screen_mode, true);
	assert.equal(card.header.title.content, "切换模型");
	assert.equal(card.elements[1].content, "**openai**");
	assert.equal(card.elements[3].content, "**anthropic**");
	const actions = card.elements.filter((el) => el.tag === "action").flatMap((el) => el.actions);
	assert.equal(actions.length, 3);
	assert.equal(actions[0].type, "default");
	assert.equal(actions[1].type, "primary");
	assert.deepEqual(JSON.parse(JSON.stringify(actions[2].value)), {
		action: "pideck.set_model",
		provider: "anthropic",
		modelId: "claude-sonnet-4",
	});
});

test("parses only PiDeck model switch card actions", () => {
	const { parseModelActionValue } = loadModelCardModule();

	assert.deepEqual(JSON.parse(JSON.stringify(parseModelActionValue({ action: "pideck.set_model", provider: "openai", modelId: "gpt-4o" }))), {
		provider: "openai",
		modelId: "gpt-4o",
	});
	assert.equal(parseModelActionValue({ action: "other", provider: "openai", modelId: "gpt-4o" }), undefined);
	assert.equal(parseModelActionValue({ action: "pideck.set_model", provider: "", modelId: "gpt-4o" }), undefined);
});
