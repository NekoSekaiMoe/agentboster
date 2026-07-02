import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync("src/renderer/src/agentListDisplay.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "agentListDisplay.ts",
	});
	return sandbox.exports;
}

function session(overrides) {
	return {
		id: overrides.filePath,
		filePath: overrides.filePath,
		preview: "",
		updatedAt: overrides.updatedAt ?? 1,
		messageCount: 1,
		source: "codex",
		...overrides,
	};
}

test("groups imported Codex subagent sessions under their parent session", () => {
	const { getProjectAgentSessionDisplay } = loadModule();

	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [
			session({
				filePath: "/sessions/codex_parent.jsonl",
				name: "Parent",
				updatedAt: 10,
				codexThreadSource: "user",
			}),
			session({
				filePath: "/sessions/codex_child.jsonl",
				name: "Reviewer",
				updatedAt: 12,
				codexThreadSource: "subagent",
				codexParentThreadId: "parent-thread",
			}),
		].map((item, index) =>
			index === 0 ? { ...item, id: "parent-thread" } : item,
		),
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.name, "Parent");
	assert.equal(display.children[0].codexSubagents.length, 1);
	assert.equal(display.children[0].codexSubagents[0].name, "Reviewer");
});
