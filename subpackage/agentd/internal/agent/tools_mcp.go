package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// registerMCPCall registers the mcp_call tool.
//
// P1.2: This tool bridges agentd to MCP servers hosted on the web app.
// It is registered conditionally — only when the agent config has
// mcp_enabled=true. This is enforced by RegisterAllTools accepting the
// agent config and skipping registration when the flag is off (default).
//
// The tool delegates actual execution to clawless.Client.MCPExec, which
// POSTs to /api/agentd/v1/tools/mcp-exec on the web layer. That route
// re-checks mcp_enabled and the server allowlist as defense-in-depth.
func registerMCPCall(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext, allowedServers []string) {
	// Build a set of allowed servers for fast lookup. Empty list (when
	// mcp_enabled is true but mcp_servers is unset) means "all builtins".
	allowed := make(map[string]bool, len(allowedServers))
	for _, s := range allowedServers {
		allowed[s] = true
	}

	registry.Register(ToolDefinition{
		Name:        "mcp_call",
		Description: "Call a tool on an MCP (Model Context Protocol) server hosted by the AgentBoster web app. Use this to access integrations like GitHub, Firecrawl, Context7, etc. Pass the server name, tool name, and arguments object.",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"server": map[string]any{
					"type":        "string",
					"description": "MCP server name (e.g., \"github\", \"firecrawl\", \"context7\", \"web\", \"browser\")",
				},
				"tool": map[string]any{
					"type":        "string",
					"description": "Tool name on the server (e.g., \"github_create_issue\", \"firecrawl_scrape\")",
				},
				"args": map[string]any{
					"type":                 "object",
					"description":          "Arguments object for the tool; shape depends on the tool",
					"additionalProperties": true,
				},
			},
			"required": []string{"server", "tool"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Server string         `json:"server"`
			Tool   string         `json:"tool"`
			Args   map[string]any `json:"args"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if params.Server == "" || params.Tool == "" {
			return &ToolResult{Success: false, Error: "server and tool are required"}, nil
		}

		// Local allowlist check (in addition to the web layer's).
		if len(allowed) > 0 && !allowed[params.Server] {
			return &ToolResult{
				Success: false,
				Error:   fmt.Sprintf("MCP server %q is not in this agent's allowlist", params.Server),
			}, nil
		}

		if client == nil {
			return &ToolResult{Success: false, Error: "clawless client not wired"}, nil
		}

		callCtx, cancel := context.WithTimeout(toolCtx, 30*time.Second)
		defer cancel()

		slog.Info("mcp_call invoking",
			"server", params.Server,
			"tool", params.Tool,
			"session_id", ctx.SessionID,
		)

		result, err := client.MCPExec(callCtx, params.Server, params.Tool, params.Args, ctx.AgentID, ctx.SessionID)
		if err != nil {
			slog.Warn("mcp_call transport failed",
				"server", params.Server,
				"tool", params.Tool,
				"error", err,
			)
			return &ToolResult{
				Success: false,
				Error:   fmt.Sprintf("MCP transport error: %v", err),
			}, nil
		}
		if !result.Success {
			return &ToolResult{Success: false, Error: result.Error}, nil
		}

		return &ToolResult{Success: true, Data: result.Data}, nil
	})
}
