package agent

import (
	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/sandbox"
)

// RegisterAllTools registers all MVP tools into the registry.
func RegisterAllTools(
	registry *ToolRegistry,
	sbManager *sandbox.Manager,
	clawlessClient *clawless.Client,
	agentCtx *AgentContext,
) {
	// === Sandbox execution (2) ===
	registerExec(registry, sbManager, agentCtx)
	registerExecBackground(registry, sbManager, agentCtx)

	// === File operations (7) ===
	registerRead(registry, sbManager, agentCtx)
	registerWrite(registry, sbManager, agentCtx)
	registerEdit(registry, sbManager, agentCtx)
	registerLs(registry, sbManager, agentCtx)
	registerGrep(registry, sbManager, agentCtx)
	registerGlob(registry, sbManager, agentCtx)
	registerPatch(registry, sbManager, agentCtx)

	// === Sub-agent (2) ===
	registerSubagent(registry, clawlessClient, agentCtx)
	registerSubagentResult(registry, agentCtx)

	// === Web (2) ===
	registerWebFetch(registry)
	registerWebSearch(registry)

	// === Git (3) ===
	registerGitClone(registry, sbManager, agentCtx)
	registerGitDiff(registry, sbManager, agentCtx)
	registerGitStatus(registry, sbManager, agentCtx)

	// === Memory (2) ===
	registerMemorySearch(registry, clawlessClient, agentCtx)
	registerMemorySave(registry, clawlessClient, agentCtx)

	// === Sandbox install (1) ===
	registerSandboxInstall(registry, sbManager, agentCtx)


	// === Ask question (1) ===
	registerAskQuestion(registry, agentCtx)
}
