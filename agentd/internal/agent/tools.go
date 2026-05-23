package agent

import (
	"context"
	"encoding/json"
	"fmt"
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
}

// ToolHandler is the function signature for tool execution.
type ToolHandler func(ctx context.Context, args json.RawMessage) (*ToolResult, error)

// ToolRegistry holds all registered tools.
type ToolRegistry struct {
	tools map[string]struct {
		def    ToolDefinition
		handler ToolHandler
	}
}

// NewToolRegistry creates a new tool registry.
func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{
		tools: make(map[string]struct {
			def      ToolDefinition
			handler  ToolHandler
		}),
	}
}

// Register adds a tool to the registry.
func (r *ToolRegistry) Register(def ToolDefinition, handler ToolHandler) {
	r.tools[def.Name] = struct {
		def      ToolDefinition
		handler  ToolHandler
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
