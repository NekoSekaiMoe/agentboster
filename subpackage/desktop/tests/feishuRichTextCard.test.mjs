import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadRichTextModule() {
	const source = readFileSync("src/main/feishu/rich-text.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {}, Buffer };
	vm.runInNewContext(outputText, sandbox, { filename: "rich-text.ts" });
	return sandbox.exports;
}

test("markdown interactive cards render pipe tables as table elements", () => {
	const { buildMarkdownCards } = loadRichTextModule();
	const [card] = buildMarkdownCards("# 数据\n\n| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 2 |");
	const elements = card.body.elements;

	assert.equal(elements[0].tag, "table");
	assert.equal(elements[0].columns[0].display_name, "名称");
	assert.deepEqual(JSON.parse(JSON.stringify(elements[0].rows)), [{ col_0: "苹果", col_1: "2" }]);
});
