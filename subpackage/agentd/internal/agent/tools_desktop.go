package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent/desktop"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
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

// registerDesktopClick exposes desktop_click — inject a mouse click at
// (x, y) on the Xvfb display via xdotool. Useful for vision-capable
// models that read a desktop_screenshot and decide where to click.
func registerDesktopClick(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "desktop_click",
		Description: "Click at (x, y) on the sandbox desktop. " +
			"Coordinates are in X11 framebuffer pixels (top-left origin); call desktop_screenshot first to see the current layout and pick coordinates. " +
			"button: 1=left (default), 2=middle, 3=right, 4=wheel-up, 5=wheel-down. click_count: 1 (default), 2=double, 3=triple. " +
			"Uses xdotool (XTest extension), independent of whether a noVNC client is connected.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"x":           map[string]any{"type": "integer", "description": "X coordinate (pixels from left)."},
				"y":           map[string]any{"type": "integer", "description": "Y coordinate (pixels from top)."},
				"button":      map[string]any{"type": "integer", "description": "Mouse button (1=left, 2=middle, 3=right, 4=wheel-up, 5=wheel-down). Default 1.", "default": 1},
				"click_count": map[string]any{"type": "integer", "description": "Number of clicks (1-3). Default 1.", "default": 1},
			},
			"required": []string{"x", "y"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "desktop_click requires an active sandbox"}, nil
		}
		var params struct {
			X          int `json:"x"`
			Y          int `json:"y"`
			Button     int `json:"button"`
			ClickCount int `json:"click_count"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if err := desktop.Click(sbMgr, sandboxID, params.X, params.Y, params.Button, params.ClickCount); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_click: %v", err)}, nil
		}
		return &ToolResult{Success: true, Data: fmt.Sprintf("clicked at (%d, %d) button=%d count=%d", params.X, params.Y, orDefault(params.Button, 1), orDefault(params.ClickCount, 1))}, nil
	})
}

// registerDesktopType exposes desktop_type — type text into the focused
// window. Use after desktop_click focuses an input field.
func registerDesktopType(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "desktop_type",
		Description: "Type text into the currently focused window on the sandbox desktop. " +
			"Use desktop_click first to focus an input field, then desktop_type to enter text. " +
			"Handles UTF-8 and arbitrary characters safely (text is piped to xdotool via stdin, not passed as a shell argument).",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"text":     map[string]any{"type": "string", "description": "Text to type. May contain any characters including newlines."},
				"delay_ms": map[string]any{"type": "integer", "description": "Per-keystroke delay in ms (0-1000). Default 0 (as fast as possible).", "default": 0},
			},
			"required": []string{"text"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "desktop_type requires an active sandbox"}, nil
		}
		var params struct {
			Text    string `json:"text"`
			DelayMs int    `json:"delay_ms"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if err := desktop.Type(sbMgr, sandboxID, params.Text, params.DelayMs); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_type: %v", err)}, nil
		}
		return &ToolResult{Success: true, Data: fmt.Sprintf("typed %d chars", len(params.Text))}, nil
	})
}

// registerDesktopKey exposes desktop_key — press a key or key combo
// (e.g. "Return", "ctrl+c", "Alt+F4", "ctrl+shift+t"). Keysyms follow
// X11/xdotool naming.
func registerDesktopKey(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "desktop_key",
		Description: "Press a key or key combo on the sandbox desktop. " +
			"Examples: \"Return\" (Enter), \"Escape\", \"ctrl+c\", \"Alt+F4\", \"ctrl+shift+t\", \"Tab\", \"BackSpace\", \"space\". " +
			"Keys follow xdotool/X11 naming (see /usr/include/X11/keysymdef.h, strip the XK_ prefix). " +
			"Multiple keys joined with '+' are pressed simultaneously. Allowed chars: letters, digits, +, -, _.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"keysym": map[string]any{"type": "string", "description": "Key or combo, e.g. \"Return\", \"ctrl+c\", \"Alt+F4\"."},
			},
			"required": []string{"keysym"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "desktop_key requires an active sandbox"}, nil
		}
		var params struct {
			Keysym string `json:"keysym"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if err := desktop.Key(sbMgr, sandboxID, params.Keysym); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_key: %v", err)}, nil
		}
		return &ToolResult{Success: true, Data: fmt.Sprintf("pressed: %s", params.Keysym)}, nil
	})
}

// orDefault returns v if non-zero, else def. Small helper for building
// result strings without pulling in a generic clamp util.
func orDefault(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}
