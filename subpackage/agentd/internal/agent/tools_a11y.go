package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	dbushelper "github.com/NekoSekaiMoe/agentboster/subpackage/dbushelper"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent/desktop"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

// a11yHelperBin is the path where install_a11y_helper_from_release
// drops the helper binary. Kept in sync with desktop_install.sh.
const a11yHelperBin = "/usr/local/bin/agentd-a11y-helper"

// execA11yHelper runs the helper binary inside the sandbox with DISPLAY
// + DBUS_SESSION_BUS_ADDRESS sourced from the desktop envFile written
// by startStack. subcommand is one of "snapshot" / "click" / "type" /
// "fill"; args is the trailing argv (ref id, text). The helper prints a
// single JSON object on stdout which we decode into out.
//
// sandboxEnv is appended after sourcing the envFile so callers can
// inject extra vars (currently none, but reserved for future use).
func execA11yHelper(sbMgr *sandbox.Manager, sandboxID, subcommand string, args []string, out any) error {
	argv := append([]string{a11yHelperBin, subcommand}, args...)
	// Single-quote each argv token so values like "click e3" or text
	// containing spaces survive the shell layer unmodified.
	parts := make([]string, len(argv))
	for i, a := range argv {
		parts[i] = a11ySingleQuote(a)
	}
	// Source the envFile if present so the helper sees the a11y bus
	// address. The helper does its own /proc discovery as a fallback,
	// but sourcing the env first is faster and matches the documented
	// contract in desktop.go.
	cmd := fmt.Sprintf(
		`[ -f %s ] && . %s; %s`,
		desktop.EnvFile(), desktop.EnvFile(), strings.Join(parts, " "),
	)
	res, err := desktop.RunScript(sbMgr, sandboxID, cmd, 30)
	if err != nil {
		return fmt.Errorf("exec a11y helper: %w", err)
	}
	stdout := strings.TrimSpace(res)
	if stdout == "" {
		return fmt.Errorf("a11y helper %q produced no output (check stderr in agentd logs)", subcommand)
	}
	if err := json.Unmarshal([]byte(stdout), out); err != nil {
		return fmt.Errorf("parse a11y helper %q output: %w; raw=%q", subcommand, err, truncateForErr(stdout, 200))
	}
	return nil
}

// truncateForErr is a small helper for embedding raw output in error
// messages without leaking megabytes when the helper misbehaves.
// (Kept distinct from the existing truncate in tools_subagent.go,
// which has different semantics — shorter N, different call sites.)
func truncateForErr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// a11ySingleQuote wraps s in single quotes for safe shell interpolation.
// Equivalent to desktop.singleQuote but kept local to avoid exporting a
// generic shell helper from the desktop package.
func a11ySingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// registerDesktopInspect exposes desktop_inspect — return the AT-SPI2
// accessibility tree as a compact text list. Far cheaper than a
// screenshot (1-3k tokens vs 200-600k for a base64 PNG-as-text), and
// returns semantic roles + names + selectors the model can act on
// directly. Pairs with desktop_a11y_click / desktop_a11y_type for
// precise, accessibility-driven GUI automation.
func registerDesktopInspect(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "desktop_inspect",
		Description: "Return the desktop's accessibility tree as a compact text list. " +
			"Each on-screen widget becomes one line: '- push button \"Reload\" [ref=e3] @120,80 28x28'. " +
			"Use refs (eN) from this output with desktop_a11y_click / desktop_a11y_type for precise, " +
			"semantic GUI automation. Much cheaper than desktop_screenshot (no image bytes), and works " +
			"even when the target is off-screen but exposed by the toolkit. " +
			"Falls back gracefully on apps without AT-SPI support (raw X11 apps like xterm return an empty tree).",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{
					"type":        "integer",
					"description": "Max number of nodes to return. Default 300. Hard cap prevents pathological trees (LibreOffice Calc) from hanging.",
					"default":     300,
				},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "desktop_inspect requires an active sandbox"}, nil
		}
		var params struct {
			Limit int `json:"limit"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		// EnsureDesktop brings up the full X11 + D-Bus + at-spi stack
		// on first call (idempotent afterwards). It also runs
		// desktop_install.sh which fetches the helper binary on first
		// use. Both are slow on first invocation (~30-60s) and fast
		// afterwards.
		if err := desktop.EnsureDesktop(sbMgr, sandboxID); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_inspect: %v", err)}, nil
		}

		var snap dbushelper.SnapshotOutput
		helperArgs := []string{}
		if params.Limit > 0 {
			helperArgs = append(helperArgs, "--limit", fmt.Sprintf("%d", params.Limit))
		}
		if err := execA11yHelper(sbMgr, sandboxID, "snapshot", helperArgs, &snap); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_inspect: %v", err)}, nil
		}

		// Surface the text lines to the model — that's the cheap,
		// actionable view. Diagnostics go into Data so a curious caller
		// / logs can see them, but the model gets Lines as the primary
		// content.
		payload := map[string]any{
			"snapshot":   snap.Lines,
			"ref_count":  len(snap.Items),
			"truncated":  snap.Truncated,
			"diagnostics": snap.Diagnostics,
		}
		data, _ := json.Marshal(payload)
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

// registerDesktopA11yClick exposes desktop_a11y_click — invoke the
// AT-SPI Action interface on a snapshot ref. Falls back to a coordinate
// click via desktop_click (xdotool) when AT-SPI cannot reach the target
// (raw-X11 widgets, off-screen elements without an Action interface).
func registerDesktopA11yClick(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "desktop_a11y_click",
		Description: "Click an on-screen widget by its accessibility ref (the eN id from desktop_inspect). " +
			"Routes through the AT-SPI Action interface for precise, semantic interaction. " +
			"If AT-SPI cannot reach the target (raw-X11 apps, widgets without an Action interface), " +
			"automatically falls back to a coordinate click via xdotool using the bounding-box center captured at snapshot time. " +
			"Always call desktop_inspect first to get refs.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"ref": map[string]any{
					"type":        "string",
					"description": "Accessibility ref from desktop_inspect (e.g. \"e3\"). Accepts e3 / E03 / ref=e3 / 3.",
				},
			},
			"required": []string{"ref"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "desktop_a11y_click requires an active sandbox"}, nil
		}
		var params struct {
			Ref string `json:"ref"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		if err := desktop.EnsureDesktop(sbMgr, sandboxID); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_a11y_click: %v", err)}, nil
		}

		var out dbushelper.ActionOutput
		if err := execA11yHelper(sbMgr, sandboxID, "click", []string{params.Ref}, &out); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_a11y_click: %v", err)}, nil
		}

		// Fallback path: helper reported ok=false with a coordinate.
		// Replay via xdotool so the model still gets its click even when
		// AT-SPI can't reach the target (raw-X11 widgets).
		via := "a11y"
		if !out.OK && out.Fallback != nil {
			if err := desktop.Click(sbMgr, sandboxID, int(out.Fallback.X), int(out.Fallback.Y), 1, 1); err != nil {
				return &ToolResult{
					Success: false,
					Error: fmt.Sprintf("desktop_a11y_click: a11y failed (%s) and xdotool fallback also failed: %v",
						out.Error, err),
				}, nil
			}
			via = "xdotool_fallback"
		}

		payload := map[string]any{
			"ok":    out.OK,
			"via":   via,
			"ref":   out.RefID,
			"detail": out.Detail,
		}
		if out.Error != "" {
			payload["a11y_error"] = out.Error
		}
		if out.Fallback != nil {
			payload["fallback"] = out.Fallback
		}
		data, _ := json.Marshal(payload)
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

// registerDesktopA11yType exposes desktop_a11y_type — insert text into
// the editable widget pointed at by an accessibility ref. Falls back to
// a coordinate click + desktop_type when AT-SPI cannot reach the target.
func registerDesktopA11yType(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "desktop_a11y_type",
		Description: "Type text into the editable widget pointed at by an accessibility ref. " +
			"Inserts at the caret via the AT-SPI EditableText interface. " +
			"If AT-SPI cannot reach the target, falls back to clicking the bounding-box center and typing via xdotool. " +
			"Always call desktop_inspect first to get refs.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"ref":  map[string]any{"type": "string", "description": "Accessibility ref from desktop_inspect."},
				"text": map[string]any{"type": "string", "description": "Text to type. UTF-8 safe."},
				"mode": map[string]any{
					"type":        "string",
					"enum":        []string{"insert", "replace"},
					"description": "insert (default) inserts at the caret; replace overwrites the whole field.",
					"default":     "insert",
				},
			},
			"required": []string{"ref", "text"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "desktop_a11y_type requires an active sandbox"}, nil
		}
		var params struct {
			Ref  string `json:"ref"`
			Text string `json:"text"`
			Mode string `json:"mode"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		if err := desktop.EnsureDesktop(sbMgr, sandboxID); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_a11y_type: %v", err)}, nil
		}

		subcommand := "type"
		if params.Mode == "replace" {
			subcommand = "fill"
		}
		var out dbushelper.ActionOutput
		if err := execA11yHelper(sbMgr, sandboxID, subcommand, []string{params.Ref, params.Text}, &out); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("desktop_a11y_type: %v", err)}, nil
		}

		via := "a11y"
		if !out.OK && out.Fallback != nil {
			// Click into the field first, then type via xdotool. This
			// mirrors memoh's editByRef fallback semantics: AT-SPI
			// failure means we don't know the widget's text interface,
			// so the best we can do is focus + paste.
			if err := desktop.Click(sbMgr, sandboxID, int(out.Fallback.X), int(out.Fallback.Y), 1, 1); err != nil {
				return &ToolResult{
					Success: false,
					Error: fmt.Sprintf("desktop_a11y_type: a11y failed (%s) and xdotool click-fallback failed: %v",
						out.Error, err),
				}, nil
			}
			// Clear existing content on replace mode.
			if params.Mode == "replace" {
				_ = desktop.Key(sbMgr, sandboxID, "ctrl+a")
			}
			if err := desktop.Type(sbMgr, sandboxID, params.Text, 0); err != nil {
				return &ToolResult{
					Success: false,
					Error: fmt.Sprintf("desktop_a11y_type: a11y failed (%s) and xdotool type-fallback failed: %v",
						out.Error, err),
				}, nil
			}
			via = "xdotool_fallback"
		}

		payload := map[string]any{
			"ok":    out.OK,
			"via":   via,
			"ref":   out.RefID,
			"detail": out.Detail,
		}
		if out.Error != "" {
			payload["a11y_error"] = out.Error
		}
		if out.Fallback != nil {
			payload["fallback"] = out.Fallback
		}
		data, _ := json.Marshal(payload)
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}
