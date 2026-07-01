package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/clawless/agentd/internal/clawless"
)

func registerVaultList(registry *ToolRegistry, client *clawless.Client) {
	registry.Register(ToolDefinition{
		Name:        "vault_list",
		Description: "List available vault key names. Values are not returned and cannot be read by the agent.",
		MinUserType: "unknown",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		keys, err := client.ListVaultKeys(toolCtx)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("vault list: %v", err)}, nil
		}
		if len(keys) == 0 {
			return &ToolResult{Success: true, Data: "(vault is empty)"}, nil
		}
		return &ToolResult{Success: true, Data: strings.Join(keys, "\n")}, nil
	})
}
