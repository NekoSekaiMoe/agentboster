//go:build linux
// +build linux

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent/browser"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security/l0_rules"
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
	registerBrowserInspect(registry, sbMgr, ctx)
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
	registerBrowserSelectOption(registry, sbMgr, ctx)
	registerBrowserHover(registry, sbMgr, ctx)
	registerBrowserUpload(registry, sbMgr, ctx)
	registerBrowserTabNew(registry, sbMgr, ctx)
	registerBrowserTabSwitch(registry, sbMgr, ctx)
	registerBrowserTabClose(registry, sbMgr, ctx)
	registerBrowserTabList(registry, sbMgr, ctx)
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
//
// body may be nil (GET), []byte (pre-serialized JSON), or any json-marshalable
// value (map/struct) which is marshalled here. This keeps call sites concise.
func bridgeCallToToolResult(
	sbMgr *sandbox.Manager,
	ctx *AgentContext,
	method, path string,
	body any,
	timeoutSec int,
) (*ToolResult, error) {
	var raw []byte
	switch v := body.(type) {
	case nil:
		raw = nil
	case []byte:
		raw = v
	case json.RawMessage:
		raw = v
	default:
		buf, err := json.Marshal(v)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("marshal request body: %v", err)}, nil
		}
		raw = buf
	}
	data, err := browser.CallBridge(sbMgr, ctx.SnapshotSandboxID(), method, path, raw, timeoutSec)
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
		if ctx.SnapshotSandboxID() == "" {
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

// locatorStrategyProperties is the shared JSON-Schema fragment describing
// the selector-strategy parameters accepted by browser_click / browser_type
// (and usable as a scope hint by browser_inspect). Mirrors the serverless
// side so the model can reuse the same workflow on both sides.
//
// Priority order (handled by the helper):
//   selector > role (+role_name) > label > placeholder > text
func locatorStrategyProperties() map[string]any {
	return map[string]any{
		"selector": map[string]any{
			"type":        "string",
			"description": "CSS / Playwright selector. Highest priority when present. Use when you have a stable id, [data-testid], or tag+name.",
		},
		"role": map[string]any{
			"type":        "string",
			"description": "ARIA role (button, link, textbox, checkbox, ...). Maps to Playwright getByRole. Robust against dynamic class names.",
			"enum":        []string{"button", "link", "textbox", "checkbox", "radio", "menuitem", "option", "switch", "tab", "combobox", "listbox", "slider", "searchbox", "spinbutton"},
		},
		"role_name": map[string]any{
			"type":        "string",
			"description": "Accessible name to disambiguate the role (e.g. role=button, role_name=Login).",
		},
		"role_exact": map[string]any{
			"type":        "boolean",
			"description": "Match role_name exactly (default: substring match).",
		},
		"label": map[string]any{
			"type":        "string",
			"description": "Form field label (visible <label> or aria-label). Best for inputs. Maps to getByLabel.",
		},
		"label_exact": map[string]any{"type": "boolean", "description": "Match label exactly."},
		"placeholder": map[string]any{
			"type":        "string",
			"description": "Input placeholder text. Maps to getByPlaceholder.",
		},
		"placeholder_exact": map[string]any{"type": "boolean", "description": "Match placeholder exactly."},
		"text": map[string]any{
			"type":        "string",
			"description": "Visible text content. Maps to getByText. Less precise than role+name (avoid if the page has duplicate strings).",
		},
		"text_exact": map[string]any{"type": "boolean", "description": "Match text exactly."},
		"frame_chain": map[string]any{
			"type":        "array",
			"items":       map[string]any{"type": "string"},
			"description": "Selectors for nested iframes, outer-to-inner. Each entry is resolved as a frameLocator inside the previous one. Same-origin shadow DOM is handled automatically by Playwright's CSS engine and does NOT need this.",
		},
	}
}

// locatorStrategyParams is the struct mirror of locatorStrategyProperties.
// Fields are pointers where distinguishing "omitted" from "zero" matters.
type locatorStrategyParams struct {
	Selector         string   `json:"selector"`
	Role             string   `json:"role"`
	RoleName         string   `json:"role_name"`
	RoleExact        *bool    `json:"role_exact"`
	Label            string   `json:"label"`
	LabelExact       *bool    `json:"label_exact"`
	Placeholder      string   `json:"placeholder"`
	PlaceholderExact *bool    `json:"placeholder_exact"`
	Text             string   `json:"text"`
	TextExact        *bool    `json:"text_exact"`
	FrameChain       []string `json:"frame_chain"`
}

// toMap serializes non-empty strategy fields into a JSON body. Used by
// browser_click/browser_type when calling the helper.
func (p locatorStrategyParams) toMap() map[string]any {
	m := map[string]any{
		"selector":    p.Selector,
		"role":        p.Role,
		"role_name":   p.RoleName,
		"label":       p.Label,
		"placeholder": p.Placeholder,
		"text":        p.Text,
		"frame_chain": p.FrameChain,
	}
	if p.RoleExact != nil {
		m["role_exact"] = *p.RoleExact
	}
	if p.LabelExact != nil {
		m["label_exact"] = *p.LabelExact
	}
	if p.PlaceholderExact != nil {
		m["placeholder_exact"] = *p.PlaceholderExact
	}
	if p.TextExact != nil {
		m["text_exact"] = *p.TextExact
	}
	return m
}

func registerBrowserClick(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	props := locatorStrategyProperties()
	props["x"] = map[string]any{"type": "number", "description": "X coordinate (used when no selector strategy is given)."}
	props["y"] = map[string]any{"type": "number", "description": "Y coordinate (used when no selector strategy is given)."}
	props["button"] = map[string]any{"type": "string", "enum": []string{"left", "middle", "right"}, "description": "Mouse button. Default: left."}
	props["click_count"] = map[string]any{"type": "number", "description": "Number of clicks (1-3). Default: 1."}
	props["timeout_ms"] = map[string]any{"type": "number", "description": "Wait timeout in ms. Default 30000."}
	props["profile"] = map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."}

	registry.Register(ToolDefinition{
		Name: "browser_click",
		Description: "Click an element. Provide ONE of these targeting strategies (priority: selector > role+role_name > label > placeholder > text), " +
			"or page coordinates (x, y). Prefer role+role_name or label over selector when the page uses dynamic CSS classes (e.g. Tailwind). " +
			"Run browser_inspect first to discover the recommended strategy for each element. Requires browser_navigate first.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type":       "object",
			"properties": props,
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			locatorStrategyParams
			X          *float64 `json:"x"`
			Y          *float64 `json:"y"`
			Button     string   `json:"button"`
			ClickCount int      `json:"click_count"`
			TimeoutMs  int      `json:"timeout_ms"`
			Profile    string   `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body := params.locatorStrategyParams.toMap()
		body["x"] = params.X
		body["y"] = params.Y
		body["button"] = params.Button
		body["click_count"] = params.ClickCount
		body["timeout_ms"] = params.TimeoutMs
		body["profile"] = resolveProfile(params.Profile, ctx.AgentID)
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/click", body, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// ── Tool: browser_type ──────────────────────────────────────────────

func registerBrowserType(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	props := locatorStrategyProperties()
	// type uses `text` for the value to type, so the locator-strategy `text`
	// parameter is intentionally removed to avoid collision.
	delete(props, "text")
	delete(props, "text_exact")
	props["text"] = map[string]any{"type": "string", "description": "Text to type into the target element."}
	props["clear"] = map[string]any{"type": "boolean", "description": "Clear the field before typing."}
	props["press_enter"] = map[string]any{"type": "boolean", "description": "Press Enter after typing."}
	props["delay_ms"] = map[string]any{"type": "number", "description": "Delay between keystrokes (0-1000)."}
	props["timeout_ms"] = map[string]any{"type": "number", "description": "Wait timeout in ms. Default 30000."}
	props["profile"] = map[string]any{"type": "string", "description": "Profile name."}

	registry.Register(ToolDefinition{
		Name: "browser_type",
		Description: "Type text into a target element. Provide ONE targeting strategy (selector > role+role_name > label > placeholder); " +
			"if none given, types into the currently focused element. For form fields, prefer `label` or `placeholder` over `selector` " +
			"(more robust against dynamic CSS). Run browser_inspect first to discover labels/placeholders.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type":       "object",
			"properties": props,
			"required":   []string{"text"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			locatorStrategyParams
			Text       string `json:"text"`
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
		// Strip the locator-strategy `text` field — type() reserves it for
		// the value to type. The bridge's resolveLocator handles the other
		// strategies (selector/role/label/placeholder) for target lookup.
		body := params.locatorStrategyParams.toMap()
		delete(body, "text")
		delete(body, "text_exact")
		body["text"] = params.Text
		body["clear"] = params.Clear
		body["press_enter"] = params.PressEnter
		body["delay_ms"] = params.DelayMs
		body["timeout_ms"] = params.TimeoutMs
		body["profile"] = resolveProfile(params.Profile, ctx.AgentID)
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
		result, err := browser.CallBridge(sbMgr, ctx.SnapshotSandboxID(), "POST", "/evaluate", body, clampTimeoutSec(params.TimeoutMs/1000))
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

// ── Tool: browser_inspect ───────────────────────────────────────────
//
// Cuts the token cost of "where do I click?" / "what's the selector?"
// workflows. Instead of pulling the full HTML via browser_get_html and
// parsing it mentally, the model calls browser_inspect and gets a compact
// list of interactive elements with pre-computed selector strategies:
// role+name, label, placeholder, and a CSS fallback. The recommended
// strategy for each element is the most stable one available (id/testid
// > name > role+name > label > placeholder > positional).

func registerBrowserInspect(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "browser_inspect",
		Description: "List interactive elements on the current page (a, button, input, select, textarea, and elements with ARIA roles), " +
			"with pre-computed targeting strategies for each: CSS selector, ARIA role+name, label, placeholder. " +
			"Use this BEFORE browser_click/browser_type when you don't already know a stable selector — it dramatically reduces mis-clicks on " +
			"pages with dynamic CSS classes (e.g. Tailwind). Output is compact (no HTML markup).",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"selector": map[string]any{
					"type":        "string",
					"description": "CSS scope to limit the scan (default: body). Useful for inspecting a specific dialog or section.",
				},
				"limit": map[string]any{
					"type":        "number",
					"description": "Max elements to return (default 200, hard cap 500).",
				},
				"include_hidden": map[string]any{
					"type":        "boolean",
					"description": "Include elements outside the viewport or hidden by CSS (default: false).",
				},
				"profile": map[string]any{"type": "string", "description": "Profile name."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Selector      string `json:"selector"`
			Limit         int    `json:"limit"`
			IncludeHidden bool   `json:"include_hidden"`
			Profile       string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body, _ := json.Marshal(map[string]any{
			"selector":       params.Selector,
			"limit":          params.Limit,
			"include_hidden": params.IncludeHidden,
			"profile":        resolveProfile(params.Profile, ctx.AgentID),
		})
		// Inspect runs a single in-page evaluate; default timeout is plenty.
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/inspect", body, browserDefaultTimeoutSec)
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

// registerBrowserSelectOption exposes browser_select_option — wraps
// Playwright's Locator.selectOption, supporting both single-select
// (value) and multi-select (values). Only applies to <select>, and
// <input type=checkbox|radio> for the latter case.
func registerBrowserSelectOption(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	props := locatorStrategyProperties()
	props["value"] = map[string]any{
		"type":        "string",
		"description": "Single option value to select. Mutually exclusive with values. Use this for normal <select>.",
	}
	props["values"] = map[string]any{
		"type":        "array",
		"items":       map[string]any{"type": "string"},
		"description": "Multiple option values (for <select multiple> or a group of same-named checkboxes). Ignored if value is set.",
	}
	props["timeout_ms"] = map[string]any{"type": "number", "description": "Wait timeout in ms. Default 30000."}
	props["profile"] = map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."}

	registry.Register(ToolDefinition{
		Name: "browser_select_option",
		Description: "Select option(s) on a <select>, or check <input type=checkbox|radio> elements matched by the locator. " +
			"Provide ONE locator strategy (selector/role/label/placeholder) to target the element, " +
			"and either value (single) or values (array). For <select>, value is the option's value attribute. " +
			"Requires browser_navigate first.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type":       "object",
			"properties": props,
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			locatorStrategyParams
			Value     string   `json:"value"`
			Values    []string `json:"values"`
			TimeoutMs int      `json:"timeout_ms"`
			Profile   string   `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body := params.locatorStrategyParams.toMap()
		if len(params.Values) > 0 {
			body["values"] = params.Values
		} else {
			body["value"] = params.Value
		}
		body["timeout_ms"] = params.TimeoutMs
		body["profile"] = resolveProfile(params.Profile, ctx.AgentID)
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/select-option", body, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// registerBrowserHover exposes browser_hover — wraps Playwright's
// Locator.hover. Useful for triggering hover-only menus, tooltips, and
// lazy-loaded panels.
func registerBrowserHover(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	props := locatorStrategyProperties()
	props["modifiers"] = map[string]any{
		"type":        "array",
		"items":       map[string]any{"type": "string", "enum": []string{"Shift", "Control", "Alt", "Meta"}},
		"description": "Modifier keys to hold during hover.",
	}
	props["timeout_ms"] = map[string]any{"type": "number", "description": "Wait timeout in ms. Default 30000."}
	props["profile"] = map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."}

	registry.Register(ToolDefinition{
		Name: "browser_hover",
		Description: "Hover over an element (locator strategy required). Triggers hover-only UI such as dropdown menus, tooltips, " +
			"and lazy image loading. Run browser_inspect first to pick a stable locator. Requires browser_navigate first.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type":       "object",
			"properties": props,
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			locatorStrategyParams
			Modifiers []string `json:"modifiers"`
			TimeoutMs int      `json:"timeout_ms"`
			Profile   string   `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body := params.locatorStrategyParams.toMap()
		body["modifiers"] = params.Modifiers
		body["timeout_ms"] = params.TimeoutMs
		body["profile"] = resolveProfile(params.Profile, ctx.AgentID)
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/hover", body, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// registerBrowserUpload exposes browser_upload — wraps Playwright's
// Locator.setInputFiles. Supports both filesystem paths (preferred for
// binary files already in the sandbox) and inline text payloads.
func registerBrowserUpload(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	props := locatorStrategyProperties()
	props["paths"] = map[string]any{
		"type":        "string",
		"description": "Comma-separated absolute paths inside the sandbox (e.g. \"/workspace/in.csv,/workspace/in2.csv\").",
	}
	props["paths_array"] = map[string]any{
		"type":        "array",
		"items":       map[string]any{"type": "string"},
		"description": "Array form of paths (use when paths contain commas).",
	}
	props["payload"] = map[string]any{
		"type":        "string",
		"description": "Inline text payload (UTF-8). Use with name. For binary, write the file to a sandbox path first and use paths.",
	}
	props["name"] = map[string]any{
		"type":        "string",
		"description": "Filename when using payload. Required with payload.",
	}
	props["mime"] = map[string]any{
		"type":        "string",
		"description": "MIME type when using payload (default application/octet-stream).",
	}
	props["timeout_ms"] = map[string]any{"type": "number", "description": "Wait timeout in ms. Default 30000."}
	props["profile"] = map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."}

	registry.Register(ToolDefinition{
		Name: "browser_upload",
		Description: "Upload file(s) into an <input type=file> element matched by a locator strategy. " +
			"Use paths (filesystem) for binary; use payload+name for small in-memory text files. " +
			"Requires browser_navigate first.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type":       "object",
			"properties": props,
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			locatorStrategyParams
			Paths     string   `json:"paths"`
			PathsArr  []string `json:"paths_array"`
			Payload   string   `json:"payload"`
			Name      string   `json:"name"`
			Mime      string   `json:"mime"`
			TimeoutMs int      `json:"timeout_ms"`
			Profile   string   `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body := params.locatorStrategyParams.toMap()
		body["paths"] = params.Paths
		body["paths_array"] = params.PathsArr
		body["payload"] = params.Payload
		body["name"] = params.Name
		body["mime"] = params.Mime
		body["timeout_ms"] = params.TimeoutMs
		body["profile"] = resolveProfile(params.Profile, ctx.AgentID)
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/upload", body, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// registerBrowserTabNew exposes browser_tab_new — opens a new tab in the
// current profile's BrowserContext. Subsequent browser_* calls operate on
// the new tab until browser_tab_switch is used.
func registerBrowserTabNew(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_tab_new",
		Description: "Open a new browser tab in the current profile and switch to it. Returns the new tabId. Optionally navigate it to a URL. Subsequent browser_* calls target this new tab.",
		MinUserType:  "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url":        map[string]any{"type": "string", "description": "URL to navigate the new tab to. Default: about:blank."},
				"timeout_ms": map[string]any{"type": "number", "description": "Navigation timeout in ms. Default 30000."},
				"profile":    map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			URL       string `json:"url"`
			TimeoutMs int    `json:"timeout_ms"`
			Profile   string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body := map[string]any{
			"url":        params.URL,
			"timeout_ms": params.TimeoutMs,
			"profile":    resolveProfile(params.Profile, ctx.AgentID),
		}
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/tab-new", body, clampTimeoutSec(params.TimeoutMs/1000))
	})
}

// registerBrowserTabSwitch exposes browser_tab_switch — makes an existing
// tabId the active tab for subsequent browser_* calls.
func registerBrowserTabSwitch(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_tab_switch",
		Description: "Switch the active tab for subsequent browser_* calls. Use browser_tab_list to discover tab ids.",
		MinUserType:  "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tab_id":  map[string]any{"type": "string", "description": "Tab id returned by browser_tab_new or browser_tab_list."},
				"profile": map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."},
			},
			"required": []string{"tab_id"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			TabID   string `json:"tab_id"`
			Profile string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body := map[string]any{
			"tab_id":  params.TabID,
			"profile": resolveProfile(params.Profile, ctx.AgentID),
		}
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/tab-switch", body, browserDefaultTimeoutSec)
	})
}

// registerBrowserTabClose exposes browser_tab_close — closes a tab. If it
// was the active tab, falls back to the next remaining tab (or a fresh
// blank tab if it was the last one — the BrowserContext always has one).
func registerBrowserTabClose(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_tab_close",
		Description: "Close a browser tab. Defaults to the current tab. The profile always retains at least one tab so subsequent browser_* calls keep working.",
		MinUserType:  "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tab_id":  map[string]any{"type": "string", "description": "Tab id to close. If omitted, closes the current tab."},
				"profile": map[string]any{"type": "string", "description": "Profile name (defaults to current agent profile)."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			TabID   string `json:"tab_id"`
			Profile string `json:"profile"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		body := map[string]any{
			"tab_id":  params.TabID,
			"profile": resolveProfile(params.Profile, ctx.AgentID),
		}
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/tab-close", body, browserDefaultTimeoutSec)
	})
}

// registerBrowserTabList exposes browser_tab_list — enumerates tabs in
// the current profile (id, url, title, current flag).
func registerBrowserTabList(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_tab_list",
		Description: "List all tabs in the current profile with their id, URL, title, and which is currently active. Use after browser_tab_new to capture ids.",
		MinUserType:  "trusted",
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
		body := map[string]any{
			"profile": resolveProfile(params.Profile, ctx.AgentID),
		}
		return bridgeCallToToolResult(sbMgr, ctx, "POST", "/tab-list", body, browserDefaultTimeoutSec)
	})
}
