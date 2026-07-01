package agent

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/usertype"
)

func TestToolRegistryDisabledToolIsNotRegistered(t *testing.T) {
	registry := NewToolRegistry([]string{"exec"})
	registry.Register(ToolDefinition{Name: "exec"}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Success: true}, nil
	})

	if _, _, ok := registry.Get("exec"); ok {
		t.Fatalf("disabled tool should not be registered")
	}
}

func TestToolDefaultMinUserTypeRequiresUser(t *testing.T) {
	registry := NewToolRegistry()
	registry.Register(ToolDefinition{Name: "exec"}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Success: true}, nil
	})

	def, _, ok := registry.Get("exec")
	if !ok {
		t.Fatalf("tool not registered")
	}
	if def.MinUserType != string(usertype.User) {
		t.Fatalf("expected default min user type user, got %q", def.MinUserType)
	}
	if usertype.CanUse(nil, def.MinUserType) {
		t.Fatalf("unknown user should not be allowed to execute default user tool")
	}
}
