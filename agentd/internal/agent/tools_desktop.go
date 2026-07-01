package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/clawless/agentd/internal/agent/desktop"
	"github.com/clawless/agentd/internal/sandbox"
)

// registerDesktopScreenshot exposes desktop_screenshot — captures the
// Xvfb framebuffer as a base64 PNG and returns it for vision-capable
// models. On first call, EnsureDesktop provisions the full X11 +
// icewm + x11vnc + noVNC stack inside the sandbox (idempotent; large
// apt install only fires once per sandbox lifetime).
//
// The tool also reports the noVNC HTTP path so the model can tell the
// user how to open the live desktop in a browser via sandbox.public_port.
func registerDesktopScreenshot(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "desktop_screenshot",
		Description: "Capture the X11 desktop inside the sandbox as a base64 PNG. " +
			"Use this to debug GUI applications (Electron / Tauri / Qt / GTK) running in the persistent LXC sandbox — " +
			"the vision-capable model can read the screenshot and reason about window state, layout, and error dialogs. " +
			"On first call, the full desktop stack (Xvfb + icewm + x11vnc + noVNC) is provisioned automatically; " +
			"subsequent calls are fast. To let the user view the live desktop in their browser, " +
			"expose the noVNC port with sandbox.public_port and share the returned /vnc.html URL.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		// Resolve the current sandbox id from the agent context.
		// Mirrors how browser tools pick up their sandbox target.
		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "desktop_screenshot requires an active sandbox (none in agent context)"}, nil
		}

		b64, err := desktop.Screenshot(sbMgr, sandboxID)
		if err != nil {
			// EnsureDesktop / Screenshot already format the error with
			// any AGENTD_DESKTOP_INSTALL_HINT the install script emitted,
			// so the LLM can self-heal via sandbox.exec + retry.
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_screenshot: %v", err)}, nil
		}

		// Return a structured JSON payload. agentd's own CodeAct loop
		// treats ToolResult.Data as plain text (the base64 string is
		// opaque to it), but when called through the Web workflow
		// dispatch path the wrapper layer (lib/workflow/agent/tools/
		// execute/desktop.ts) unpacks this JSON and re-emits the image
		// as an AI SDK image content block — so vision-capable models
		// reached via CLI / IM / scheduled sessions see the screenshot.
		payload, _ := json.Marshal(map[string]any{
			"image":      "data:image/png;base64," + string(b64),
			"format":     "png",
			"display":    desktop.Display(),
			"novnc_port": desktop.WebPort(),
			"novnc_path": "/vnc.html",
			"novnc_hint": fmt.Sprintf("To open the live desktop in a browser, expose port %d via sandbox.public_port and open the returned URL with path /vnc.html.", desktop.WebPort()),
		})
		return &ToolResult{Success: true, Data: string(payload)}, nil
	})
}
