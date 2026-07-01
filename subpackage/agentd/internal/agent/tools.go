package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/usertype"
)

// ToolResult is the unified return type for all tool handlers.
type ToolResult struct {
	Success bool   `json:"success"`
	Data    string `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

// ToolDefinition defines a tool for the LLM (OpenAI Function Calling compatible).
type ToolDefinition struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"` // JSON Schema
	MinUserType string `json:"-"`
}

// ToolHandler is the function signature for tool execution.
type ToolHandler func(ctx context.Context, args json.RawMessage) (*ToolResult, error)

// ToolRegistry holds all registered tools.
type ToolRegistry struct {
	disabled map[string]struct{}
	tools    map[string]struct {
		def     ToolDefinition
		handler ToolHandler
	}
}

// NewToolRegistry creates a new tool registry.
func NewToolRegistry(disabledTools ...[]string) *ToolRegistry {
	disabled := make(map[string]struct{})
	if len(disabledTools) > 0 {
		for _, name := range disabledTools[0] {
			if name == "" {
				continue
			}
			disabled[name] = struct{}{}
		}
	}
	return &ToolRegistry{
		disabled: disabled,
		tools: make(map[string]struct {
			def     ToolDefinition
			handler ToolHandler
		}),
	}
}

// Register adds a tool to the registry.
func (r *ToolRegistry) Register(def ToolDefinition, handler ToolHandler) {
	if _, disabled := r.disabled[def.Name]; disabled {
		return
	}
	if def.MinUserType == "" {
		def.MinUserType = string(usertype.User)
	}
	r.tools[def.Name] = struct {
		def     ToolDefinition
		handler ToolHandler
	}{def: def, handler: handler}
}

// Get returns a tool's handler and definition.
func (r *ToolRegistry) Get(name string) (ToolDefinition, ToolHandler, bool) {
	t, ok := r.tools[name]
	if !ok {
		return ToolDefinition{}, nil, false
	}
	return t.def, t.handler, true
}

// Definitions returns all tool definitions (for LLM system prompt).
func (r *ToolRegistry) Definitions() []ToolDefinition {
	defs := make([]ToolDefinition, 0, len(r.tools))
	for _, t := range r.tools {
		defs = append(defs, t.def)
	}
	return defs
}

// Execute runs a tool by name with the given arguments.
func (r *ToolRegistry) Execute(ctx context.Context, name string, args json.RawMessage) (*ToolResult, error) {
	_, handler, ok := r.Get(name)
	if !ok {
		return &ToolResult{Success: false, Error: fmt.Sprintf("unknown tool: %s", name)}, nil
	}
	return handler(ctx, args)
}

// parseArgs is a generic helper that unmarshals tool arguments.
// Returns the parsed struct, or a ToolResult error if parsing fails.
func parseArgs[T any](args json.RawMessage) (T, *ToolResult) {
	var zero T
	var params T
	if err := json.Unmarshal(args, &params); err != nil {
		return zero, &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}
	}
	return params, nil
}

// unmarshalToolArgs is a convenience wrapper that unmarshals into dest and returns
// a ToolResult error on failure. Use when the struct is defined locally in the handler.
func unmarshalToolArgs(args json.RawMessage, dest any) *ToolResult {
	if err := json.Unmarshal(args, dest); err != nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}
	}
	return nil
}
