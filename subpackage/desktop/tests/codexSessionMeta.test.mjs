import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync("src/shared/codexSessionMeta.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "codexSessionMeta.ts",
	});
	return sandbox.exports;
}

test("detects Codex Desktop subagent metadata", () => {
	const { getCodexSessionThreadInfo } = loadModule();

	const info = getCodexSessionThreadInfo({
		id: "child-session-id",
		session_id: "parent-thread-id",
		thread_source: "subagent",
		parent_thread_id: "parent-thread-id",
		agent_role: "worker",
		agent_nickname: "Darwin",
		source: {
			subagent: {
				thread_spawn: {
					parent_thread_id: "parent-thread-id",
					depth: 1,
					agent_nickname: "Darwin",
					agent_role: "worker",
				},
			},
		},
	});

	assert.deepEqual(JSON.parse(JSON.stringify(info)), {
		threadSource: "subagent",
		parentThreadId: "parent-thread-id",
		agentRole: "worker",
		agentNickname: "Darwin",
	});
});

test("treats Codex Desktop user sessions as parent sessions", () => {
	const { getCodexSessionThreadInfo } = loadModule();

	const info = getCodexSessionThreadInfo({
		id: "parent-thread-id",
		session_id: "parent-thread-id",
		thread_source: "user",
		source: "vscode",
	});

	assert.deepEqual(JSON.parse(JSON.stringify(info)), {
		threadSource: "user",
	});
	assert.equal(info.parentThreadId, undefined);
	assert.equal(info.agentRole, undefined);
	assert.equal(info.agentNickname, undefined);
});

test("does not treat user session with parent_thread_id as subagent", () => {
	const { getCodexSessionThreadInfo } = loadModule();

	// 某些 Codex 版本中 user session 也可能带 parent_thread_id（自身 ID）
	// thread_source 明确为 "user" 时即使有 parent_thread_id 也不应判为子代理
	const info = getCodexSessionThreadInfo({
		id: "parent-thread",
		session_id: "parent-thread",
		thread_source: "user",
		parent_thread_id: "parent-thread",
		source: "vscode",
	});

	assert.equal(info.threadSource, "user");
	assert.equal(info.parentThreadId, undefined);
	assert.equal(info.agentRole, undefined);
	assert.equal(info.agentNickname, undefined);
});
