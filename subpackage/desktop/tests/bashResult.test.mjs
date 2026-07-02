import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadBashResultModule() {
	const source = readFileSync("src/main/pi/bashResult.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "bashResult.ts",
	});
	return sandbox.exports;
}

test("treats silent commands with non-zero empty output as done", () => {
	const { formatBashToolMessage } = loadBashResultModule();

	const message = formatBashToolMessage({
		command: "code .",
		output: "",
		exitCode: 1,
		excludeFromContext: true,
	});

	assert.equal(message.text, "✓ code .");
	assert.equal(message.meta.status, "done");
	assert.equal(message.meta.isError, false);
	assert.match(message.meta.detailText, /退出码：1/);
});

test("keeps normal non-zero commands as errors", () => {
	const { formatBashToolMessage } = loadBashResultModule();

	const message = formatBashToolMessage({
		command: "npm test",
		output: "failed",
		exitCode: 1,
		excludeFromContext: false,
	});

	assert.equal(message.text, "✗ npm test");
	assert.equal(message.meta.status, "error");
	assert.equal(message.meta.isError, true);
});
