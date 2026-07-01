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
	registerExecBatch(registry, sbManager, agentCtx)

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
	registerSubagentResult(registry, clawlessClient, agentCtx)

	// === Web (4) ===
	registerWebFetch(registry)
	registerWebSearch(registry)
	registerWebRendered(registry, sbManager, agentCtx)

	// === Git (4) ===
	registerGitClone(registry, sbManager, agentCtx)
	registerGitDiff(registry, sbManager, agentCtx)
	registerGitStatus(registry, sbManager, agentCtx)
	registerGitPush(registry, sbManager, clawlessClient, agentCtx)

	// === Memory (2) ===
	registerMemorySearch(registry, clawlessClient, agentCtx)
	registerMemorySave(registry, clawlessClient, agentCtx)

	// === Knowledge Base (1) ===
	registerKnowledgeSearch(registry, clawlessClient, agentCtx)

	// === Vault (1) ===
	registerVaultList(registry, clawlessClient)

	// === Task Summary (2) ===
	registerTaskSummary(registry, clawlessClient, agentCtx)
	registerTaskProgress(registry, clawlessClient, agentCtx)

	// === File Delivery (1) ===
	registerDeliverFiles(registry, sbManager, clawlessClient, agentCtx)

	// === Sandbox install (1) ===
	registerSandboxInstall(registry, sbManager, agentCtx)

	// === Ask question (1) ===
	registerAskQuestion(registry, agentCtx)

	// === Sandbox skills (1) ===
	registerSandboxSkills(registry, sbManager, agentCtx)

	// === Sandbox media (1) ===
	registerSandboxMedia(registry, sbManager, agentCtx)

	// === CodeAct (1) ===
	registerCodeAct(registry, sbManager, clawlessClient, agentCtx)

	// === MCP bridge (1, gated) ===
	// P1.2: only register when agent config has mcp_enabled=true. The
	// daemon default is off so agents without explicit configuration
	// do not expose this tool.
	if agentCtx.AgentConfig != nil && agentCtx.AgentConfig.MCPEnabled {
		registerMCPCall(registry, clawlessClient, agentCtx, agentCtx.AgentConfig.MCPServers)
	}

	// === Browser automation (P2: tools_browser_v2) ===
	// Full Playwright-backed browser_* toolset. Tool names mirror the
	// serverless-side browser MCP tools (lib/mcp/tools/browser.ts) so
	// storageState profiles interop across sides. Available to trusted
	// users; routed to LXC via needsPersistence + permission_profile=browser.
	registerBrowserToolsV2(registry, sbManager, agentCtx)

	// === Desktop automation (4) ===
	// X11 desktop in the sandbox for GUI app debugging (Electron/Tauri/Qt/GTK).
	// desktop_screenshot provisions Xvfb + icewm + x11vnc + noVNC on first call;
	// user opens the live desktop via sandbox.public_port(6080) + /vnc.html.
	// desktop_click/type/key inject via xdotool so vision-capable models can
	// act on what they see in the screenshot.
	registerDesktopScreenshot(registry, sbManager, agentCtx)
	registerDesktopClick(registry, sbManager, agentCtx)
	registerDesktopType(registry, sbManager, agentCtx)
	registerDesktopKey(registry, sbManager, agentCtx)

	// === Sandbox lifecycle (1) ===
	// Explicit teardown when the user asks to destroy the project sandbox.
	registerSandboxDestroy(registry, sbManager, agentCtx)
}
