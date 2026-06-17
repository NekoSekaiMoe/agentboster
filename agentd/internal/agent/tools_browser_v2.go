//go:build linux
// +build linux

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/clawless/agentd/internal/agent/browser"
	"github.com/clawless/agentd/internal/sandbox"
	"github.com/clawless/agentd/internal/security/l0_rules"
)

// P2 browser tools (v2): replaced the legacy browser_act (tools_browser.go v1).
//
// This implementation routes through a long-lived in-sandbox Playwright
// helper (see internal/agent/browser). Tools mirror the serverless-side
// browser_* MCP tools (lib/mcp/tools/browser.ts) 1:1 in name and shape so
// the model can use the same workflow on both sides and storageState
// profiles interop across serverless ↔ agentd.
//
// Profile semantics (resolveProfile) also mirror the serverless side:
// explicit profile > agent-scoped profile > "default".

const (
	browserDefaultTimeoutSec = 30
	browserMaxTimeoutSec     = 120
	browserDefaultTextLimit  = 20000
	browserDefaultHtmlLimit  = 50000
)

// registerBrowserToolsV2 wires up the full browser_* tool set, replacing
// the legacy registerBrowserAct.
func registerBrowserToolsV2(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registerBrowserNavigate(registry, sbMgr, ctx)
	registerBrowserClick(registry, sbMgr, ctx)
	registerBrowserType(registry, sbMgr, ctx)
	registerBrowserGetText(registry, sbMgr, ctx)
	registerBrowserGetHtml(registry, sbMgr, ctx)
	registerBrowserScreenshot(registry, sbMgr, ctx)
	registerBrowserEvaluate(registry, sbMgr, ctx)
	registerBrowserSaveState(registry, sbMgr, ctx)
	registerBrowserLoadState(registry, sbMgr, ctx)
	registerBrowserListProfiles(registry, sbMgr, ctx)
	registerBrowserClose(registry, sbMgr, ctx)
}

// resolveProfile mirrors lib/mcp/browser/pool.ts resolveProfile.
// Explicit profile wins; otherwise scope to the agent; else "default".
func resolveProfile(profile, agentID string) string {
	if p := strings.TrimSpace(profile); p != "" {
		return p
	}
	if a := strings.TrimSpace(agentID); a != "" {
		return "agent:" + a
	}
	return "default"
}

func clampTimeoutSec(v int) int {
	if v <= 0 {
		return browserDefaultTimeoutSec
	}
	if v > browserMaxTimeoutSec {
		return browserMaxTimeoutSec
	}
	return v
}

// validateHTTPURL is reused from tools_web_rendered.go (package-level helper).

// helperResultToToolResult converts the helper envelope's inner data into a
// success ToolResult. On error from CallBridge, returns a failure ToolResult.
func bridgeCallToToolResult(
	sbMgr *sandbox.Manager,
	ctx *AgentContext,
	method, path string,
	body []byte,
	timeoutSec int,
) (*ToolResult, error) {
	data, err := browser.CallBridge(sbMgr, ctx.SandboxID, method, path, body, timeoutSec)
	if err != nil {
		return &ToolResult{Success: false, Error: err.Error()}, nil
	}
	// Pretty-print the data field as the tool's Data payload.
	pretty, perr := json.MarshalIndent(data, "", "  ")
	if perr != nil {
		return &ToolResult{Success: true, Data: string(data)}, nil
	}
	return &ToolResult{Success: true, Data: string(pretty)}, nil
}

// ── Tool: browser_navigate ──────────────────────────────────────────

func registerBrowserNavigate(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "browser_navigate",
		Description: "Open an HTTP(S) URL in a reusable headless browser page inside the sandbox. " +
			"Supports persistent profiles for resuming logged-in sessions across calls. " +
			"First call in a sandbox boots a Playwright helper (~30-60s for node.js + playwright install on first use, cached afterwards).",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url": map[string]any{
					"type":        "string",
					"description": "HTTP(S) URL to open",
				},
				"profile": map[string]any{
					"type":        "string",
					"description": "Profile name to scope cookies/localStorage. Defaults to agent:<agent_id>. Reuse the same profile after browser_save_state to resume a logged-in session.",
				},
				"user_agent": map[string]any{
					"type":        "string",
					"description": "Override User-Agent for this page. Defaults to a realistic desktop Chrome UA.",
				},
				"wait_until": map[string]any{
					"type":        "string",
					"enum":        []string{"commit", "domcontentloaded", "load", "networkidle"},
					"description": "Wait condition. Default: domcontentloaded.",
				},
				"timeout_ms": map[string]any{
					"type":        "number",
					"description": fmt.Sprintf("Navigation timeout in milliseconds. Default %d, max %d.", browserDefaultTimeoutSec*1000, browserMaxTimeoutSec*1000),
				},
				"width":  map[string]any{"type": "number", "description": "Viewport width (default 1280)."},
				"height": map[string]any{"type": "number", "description": "Viewport height (default 720)."},
			},
			"required": []string{"url"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			URL       string `json:"url"`
			Profile   string `json:"profile"`
			UserAgent string `json:"user_agent"`
			WaitUntil string `json:"wait_until"`
			TimeoutMs int    `json:"timeout_ms"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if err := validateHTTPURL(params.URL); err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}
		if ctx.SandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available; browser_* tools require an LXC sandbox (route via sandbox_hint=lxc, permission_profile=browser)"}, nil
		}

		body, _ := json.Marshal(map[string]any{
			"url":         params.URL,
			"profile":     resolveProfile(params.Profile, ctx.AgentID),
			"user_agent":  params.UserAgent,
			"wait_until":  params.WaitUntil,
			"timeout_ms":  params.TimeoutMs,
			"width":       params.Width,
			"height":      params.Height,
		})
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/navigate", body, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// ── Tool: browser_click ─────────────────────────────────────────────

func registerBrowserClick(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_click",
		Description: "Click an element by CSS selector, or click page coordinates (x, y). Requires browser_navigate first.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"selector":    map[string]any{"type": "string", "description": "CSS selector of element to click."},
				"x":           map[string]any{"type": "number", "description": "X coordinate (used when selector is empty)."},
				"y":           map[string]any{"type": "number", "description": "Y coordinate (used when selector is empty)."},
				"button":      map[string]any{"type": "string", "enum": []string{"left", "middle", "right"}, "description": "Mouse button. Default: left."},
				"click_count": map[string]any{"type": "number", "description": "Number of clicks (1-3). Default: 1."},
				"timeout_ms":  map[string]any{"type": "number", "description": "Wait timeout in ms. Default 30000."},
				"profile":     map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Selector   string `json:"selector"`
			X          *float64 `json:"x"`
			Y          *float64 `json:"y"`
			Button     string `json:"button"`
			ClickCount int    `json:"click_count"`
			TimeoutMs  int    `json:"timeout_ms"`
			Profile    string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body, _ := json.Marshal(map[string]any{
			"selector":     params.Selector,
			"x":            params.X,
			"y":            params.Y,
			"button":       params.Button,
			"click_count":  params.ClickCount,
			"timeout_ms":   params.TimeoutMs,
			"profile":      resolveProfile(params.Profile, ctx.AgentID),
		})
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/click", body, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// ── Tool: browser_type ──────────────────────────────────────────────

func registerBrowserType(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_type",
		Description: "Type text into a selector (or the focused element if no selector). Optionally clear first and press Enter.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"text":        map[string]any{"type": "string", "description": "Text to type."},
				"selector":    map[string]any{"type": "string", "description": "CSS selector. If empty, types into focused element."},
				"clear":       map[string]any{"type": "boolean", "description": "Clear the field before typing."},
				"press_enter": map[string]any{"type": "boolean", "description": "Press Enter after typing."},
				"delay_ms":    map[string]any{"type": "number", "description": "Delay between keystrokes (0-1000)."},
				"timeout_ms":  map[string]any{"type": "number", "description": "Wait timeout in ms. Default 30000."},
				"profile":     map[string]any{"type": "string", "description": "Profile name."},
			},
			"required": []string{"text"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Text       string `json:"text"`
			Selector   string `json:"selector"`
			Clear      bool   `json:"clear"`
			PressEnter bool   `json:"press_enter"`
			DelayMs    int    `json:"delay_ms"`
			TimeoutMs  int    `json:"timeout_ms"`
			Profile    string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if strings.TrimSpace(params.Text) == "" {
			return &ToolResult{Success: false, Error: "text is required"}, nil
		}
		body, _ := json.Marshal(map[string]any{
			"text":        params.Text,
			"selector":    params.Selector,
			"clear":       params.Clear,
			"press_enter": params.PressEnter,
			"delay_ms":    params.DelayMs,
			"timeout_ms":  params.TimeoutMs,
			"profile":     resolveProfile(params.Profile, ctx.AgentID),
		})
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/type", body, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// ── Tool: browser_get_text ──────────────────────────────────────────

func registerBrowserGetText(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_get_text",
		Description: "Return visible text from the current page body, or from a selected element.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"selector":   map[string]any{"type": "string", "description": "CSS selector (default: body)."},
				"max_length": map[string]any{"type": "number", "description": "Max characters (default 20000)."},
				"timeout_ms": map[string]any{"type": "number", "description": "Wait timeout in ms."},
				"profile":    map[string]any{"type": "string", "description": "Profile name."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Selector  string `json:"selector"`
			MaxLength int    `json:"max_length"`
			TimeoutMs int    `json:"timeout_ms"`
			Profile   string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		path := fmt.Sprintf("/get-text?selector=%s&max_length=%d&timeout_ms=%d&profile=%s",
			url.QueryEscape(params.Selector),
			params.MaxLength,
			params.TimeoutMs,
			url.QueryEscape(resolveProfile(params.Profile, ctx.AgentID)),
		)
		return bridgeCallToToolResult(sbMgr, ctx, "GET", path, nil, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// ── Tool: browser_get_html ──────────────────────────────────────────

func registerBrowserGetHtml(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_get_html",
		Description: "Return current page HTML, or inner HTML from a selected element.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"selector":   map[string]any{"type": "string", "description": "CSS selector (default: full page)."},
				"max_length": map[string]any{"type": "number", "description": "Max characters (default 50000)."},
				"timeout_ms": map[string]any{"type": "number", "description": "Wait timeout in ms."},
				"profile":    map[string]any{"type": "string", "description": "Profile name."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Selector  string `json:"selector"`
			MaxLength int    `json:"max_length"`
			TimeoutMs int    `json:"timeout_ms"`
			Profile   string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		path := fmt.Sprintf("/get-html?selector=%s&max_length=%d&timeout_ms=%d&profile=%s",
			url.QueryEscape(params.Selector),
			params.MaxLength,
			params.TimeoutMs,
			url.QueryEscape(resolveProfile(params.Profile, ctx.AgentID)),
		)
		return bridgeCallToToolResult(sbMgr, ctx, "GET", path, nil, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// ── Tool: browser_screenshot ────────────────────────────────────────

func registerBrowserScreenshot(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_screenshot",
		Description: "Capture the current page (or a selected element) as PNG/JPEG. Returns base64-encoded image.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"selector":   map[string]any{"type": "string", "description": "CSS selector to capture (default: full page)."},
				"full_page":  map[string]any{"type": "boolean", "description": "Capture full scrollable page."},
				"type":       map[string]any{"type": "string", "enum": []string{"png", "jpeg"}, "description": "Image format. Default: png."},
				"quality":    map[string]any{"type": "number", "description": "JPEG quality 0-100 (only for jpeg)."},
				"timeout_ms": map[string]any{"type": "number", "description": "Wait timeout in ms."},
				"profile":    map[string]any{"type": "string", "description": "Profile name."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Selector  string `json:"selector"`
			FullPage  bool   `json:"full_page"`
			Type      string `json:"type"`
			Quality   int    `json:"quality"`
			TimeoutMs int    `json:"timeout_ms"`
			Profile   string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body, _ := json.Marshal(map[string]any{
			"selector":   params.Selector,
			"full_page":  params.FullPage,
			"type":       params.Type,
			"quality":    params.Quality,
			"timeout_ms": params.TimeoutMs,
			"profile":    resolveProfile(params.Profile, ctx.AgentID),
		})
		// Screenshots may take longer; bump the bridge timeout.
		timeoutSec := clampTimeoutSec(params.TimeoutMs / 1000)
		if timeoutSec < 60 {
			timeoutSec = 60
		}
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/screenshot", body, timeoutSec)
	})
}

// ── Tool: browser_evaluate ──────────────────────────────────────────
//
// browser_evaluate is the one browser_* tool whose output is L0-audited.
// The script's return value (stringified) is fed through Engine.CheckOutput
// — if it matches a leak pattern (system prompt header, credential shape,
// internal path), the call returns an error instead of leaking to the LLM.

func registerBrowserEvaluate(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "browser_evaluate",
		Description: "Evaluate JavaScript in the current page and return a serializable value. " +
			"Output is L0-audited for prompt/credential leakage before being returned.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"script": map[string]any{
					"type":        "string",
					"description": "JavaScript expression or statements. Max 10000 characters.",
				},
				"timeout_ms": map[string]any{"type": "number", "description": "Wait timeout in ms."},
				"profile":    map[string]any{"type": "string", "description": "Profile name."},
			},
			"required": []string{"script"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Script    string `json:"script"`
			TimeoutMs int    `json:"timeout_ms"`
			Profile   string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		trimmed := strings.TrimSpace(params.Script)
		if trimmed == "" {
			return &ToolResult{Success: false, Error: "script is required"}, nil
		}
		if len(trimmed) > 10000 {
			return &ToolResult{Success: false, Error: fmt.Sprintf("script too long: %d > 10000", len(trimmed))}, nil
		}
		body, _ := json.Marshal(map[string]any{
			"script":     params.Script,
			"timeout_ms": params.TimeoutMs,
			"profile":    resolveProfile(params.Profile, ctx.AgentID),
		})
		result, err := browser.CallBridge(sbMgr, ctx.SandboxID, "POST", "/evaluate", body, clampTimeoutSec(params.TimeoutMs/1000))
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		// L0 output audit on the stringified result. The bridge already coerces
		// the value to a JSON-safe shape; we audit the raw JSON bytes.
		auditTarget := string(result)
		if l0 := auditBrowserEvaluate(ctx, auditTarget); l0 != nil && l0.Blocked {
			return &ToolResult{
				Success: false,
				Error:   "browser_evaluate output blocked by L0 rule " + l0.Rule.ID + ": " + l0.Reason,
			}, nil
		}

		pretty, perr := json.MarshalIndent(result, "", "  ")
		if perr != nil {
			return &ToolResult{Success: true, Data: auditTarget}, nil
		}
		return &ToolResult{Success: true, Data: string(pretty)}, nil
	})
}

// auditBrowserEvaluate runs the L0 output rules against the evaluate result.
// Returns the first blocking rule, or nil if the output is clean (or if no
// L0 engine is wired into the context, e.g. in tests).
func auditBrowserEvaluate(ctx *AgentContext, output string) *l0_rules.L0Result {
	if ctx == nil || ctx.L0Engine == nil {
		return nil
	}
	return ctx.L0Engine.CheckOutput(output)
}

// ── Tool: browser_save_state ────────────────────────────────────────

func registerBrowserSaveState(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "browser_save_state",
		Description: "Snapshot the current profile's cookies + localStorage. " +
			"Returns the full storageState JSON so it can be persisted to memory_save for cross-session or cross-side (serverless ↔ agentd) reuse.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"profile": map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Profile string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body, _ := json.Marshal(map[string]any{
			"profile": resolveProfile(params.Profile, ctx.AgentID),
		})
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/save-state", body, browserDefaultTimeoutSec)
	})
}

// ── Tool: browser_load_state ────────────────────────────────────────

func registerBrowserLoadState(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_load_state",
		Description: "Hydrate a profile from a previously-saved storageState JSON blob. Use after serverless restart or to import a profile from the other side.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"profile": map[string]any{"type": "string", "description": "Profile name to register the state under."},
				"state":   map[string]any{"type": "string", "description": "Playwright storageState JSON (as returned by browser_save_state)."},
			},
			"required": []string{"profile", "state"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Profile string `json:"profile"`
			State   string `json:"state"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		profile := strings.TrimSpace(params.Profile)
		if profile == "" {
			return &ToolResult{Success: false, Error: "profile is required"}, nil
		}
		if strings.TrimSpace(params.State) == "" {
			return &ToolResult{Success: false, Error: "state is required"}, nil
		}
		// Validate state parses as JSON with at least a `cookies` field before
		// making the round-trip to the helper.
		var probe map[string]any
		if err := json.Unmarshal([]byte(params.State), &probe); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("state must be valid JSON: %v", err)}, nil
		}
		if _, ok := probe["cookies"]; !ok {
			return &ToolResult{Success: false, Error: "state must be a Playwright storageState object (missing 'cookies' field)"}, nil
		}
		body, _ := json.Marshal(map[string]any{
			"profile": profile,
			"state":   json.RawMessage(params.State),
		})
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/load-state", body, browserDefaultTimeoutSec)
	})
}

// ── Tool: browser_list_profiles ─────────────────────────────────────

func registerBrowserListProfiles(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_list_profiles",
		Description: "List browser profiles cached in the sandbox. Use to check whether a saved login session is available before navigating.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		return bridgeCallToToolResult(sbMgr, ctx, "GET", "/list-profiles", nil, browserDefaultTimeoutSec)
	})
}

// ── Tool: browser_close ─────────────────────────────────────────────

func registerBrowserClose(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_close",
		Description: "Close the current browser session for the profile (drops the in-memory BrowserContext; persisted cookies/localStorage survive on disk).",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"profile": map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Profile string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body, _ := json.Marshal(map[string]any{
			"profile": resolveProfile(params.Profile, ctx.AgentID),
		})
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/close", body, browserDefaultTimeoutSec)
	})
}
