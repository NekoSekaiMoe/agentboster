//go:build linux
// +build linux

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/clawless/agentd/internal/sandbox"
)

func registerSandboxSnapshot(registry *ToolRegistry, sbManager *sandbox.Manager, agentCtx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "sandbox_snapshot",
		Description: "Create, list, restore, or delete snapshots of the current chroot sandbox workspace. Snapshots are tar.gz archives stored on disk. Only works with chroot sandboxes. Actions: create, list, restore, delete.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action": map[string]any{
					"type":        "string",
					"description": "Action to perform: create, list, restore, delete",
					"enum":        []string{"create", "list", "restore", "delete"},
				},
				"name": map[string]any{
					"type":        "string",
					"description": "Snapshot name (for create action). Optional — a timestamp-based name is generated if omitted.",
				},
				"snapshot_id": map[string]any{
					"type":        "string",
					"description": "Snapshot ID (for restore and delete actions)",
				},
			},
			"required": []string{"action"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Action     string `json:"action"`
			Name       string `json:"name"`
			SnapshotID string `json:"snapshot_id"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := agentCtx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no active sandbox for this session"}, nil
		}

		switch params.Action {
		case "create":
			name := params.Name
			if name == "" {
				name = fmt.Sprintf("snapshot-%s", agentCtx.TaskState.CompactedAt)
				if name == "" {
					name = fmt.Sprintf("snap-%d", len(agentCtx.TaskState.KeyDecisions))
				}
			}
			snap, err := sbManager.Snapshot(sandboxID, name)
			if err != nil {
				return &ToolResult{Success: false, Error: fmt.Sprintf("create snapshot: %v", err)}, nil
			}
			slog.Info("tool: snapshot created", "snapshot_id", snap.ID, "sandbox_id", sandboxID, "size", snap.Size)
			return &ToolResult{
				Success: true,
				Data:    fmt.Sprintf("Snapshot created.\nID: %s\nName: %s\nSize: %d bytes\nSandbox: %s", snap.ID, snap.Name, snap.Size, sandboxID),
			}, nil

		case "list":
			snapshots := sbManager.ListSnapshots(sandboxID)
			if len(snapshots) == 0 {
				return &ToolResult{Success: true, Data: "No snapshots found for this sandbox."}, nil
			}
			var result string
			result = fmt.Sprintf("Snapshots for sandbox %s:\n\n", sandboxID)
			for _, snap := range snapshots {
				result += fmt.Sprintf("- ID: %s | Name: %s | Size: %d bytes | Created: %s\n", snap.ID, snap.Name, snap.Size, snap.CreatedAt.Format("2006-01-02 15:04:05"))
			}
			return &ToolResult{Success: true, Data: result}, nil

		case "restore":
			if params.SnapshotID == "" {
				return &ToolResult{Success: false, Error: "snapshot_id is required for restore action"}, nil
			}
			if err := sbManager.RestoreSnapshot(params.SnapshotID); err != nil {
				return &ToolResult{Success: false, Error: fmt.Sprintf("restore snapshot: %v", err)}, nil
			}
			slog.Info("tool: snapshot restored", "snapshot_id", params.SnapshotID, "sandbox_id", sandboxID)
			return &ToolResult{
				Success: true,
				Data:    fmt.Sprintf("Snapshot %s restored to sandbox %s.\nNote: A backup of the previous workspace was created before restore.", params.SnapshotID, sandboxID),
			}, nil

		case "delete":
			if params.SnapshotID == "" {
				return &ToolResult{Success: false, Error: "snapshot_id is required for delete action"}, nil
			}
			if err := sbManager.DeleteSnapshot(params.SnapshotID); err != nil {
				return &ToolResult{Success: false, Error: fmt.Sprintf("delete snapshot: %v", err)}, nil
			}
			slog.Info("tool: snapshot deleted", "snapshot_id", params.SnapshotID)
			return &ToolResult{
				Success: true,
				Data:    fmt.Sprintf("Snapshot %s deleted.", params.SnapshotID),
			}, nil

		default:
			return &ToolResult{Success: false, Error: fmt.Sprintf("unknown action: %s", params.Action)}, nil
		}
	})
}
