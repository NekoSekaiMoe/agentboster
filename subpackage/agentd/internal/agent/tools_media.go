package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

func registerSandboxMedia(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "sandbox_media",
		Description: `Manage media files in the sandbox workspace.
Media files are stored in /workspace/downloads/{photos,videos,documents}/.
Actions: list, info, cleanup

Note: To save a new media file, write it directly to /workspace/downloads/{category}/ using the write tool.`,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action": map[string]any{
					"type":        "string",
					"description": "Action: list, info, cleanup",
					"enum":        []string{"list", "info", "cleanup"},
				},
				"category": map[string]any{
					"type":        "string",
					"description": "Filter by category: photos, videos, documents. Default: all",
				},
				"retention_days": map[string]any{
					"type":        "integer",
					"description": "Days to retain files for cleanup. Default: 3",
					"default":     3,
				},
			},
			"required": []string{"action"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Action        string `json:"action"`
			Category      string `json:"category"`
			RetentionDays int    `json:"retention_days"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		if params.RetentionDays <= 0 {
			params.RetentionDays = 3
		}

		sbPath, err := getSandboxWorkspace(sbMgr, ctx.SnapshotSandboxID())
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		mgr := sandbox.NewMediaManager(sbPath)

		switch params.Action {
		case "list":
			var cat sandbox.MediaCategory
			if params.Category != "" {
				cat = sandbox.MediaCategory(params.Category)
			}
			files := mgr.ListMedia(cat)
			if len(files) == 0 {
				return &ToolResult{Success: true, Data: "No media files found."}, nil
			}
			var sb strings.Builder
			sb.WriteString(fmt.Sprintf("Media files (%d):\n", len(files)))
			for _, f := range files {
				rel, _ := filepath.Rel(sbPath, f.Path)
				sb.WriteString(fmt.Sprintf("- [%s] %s (%d bytes, %s)\n", f.Category, rel, f.Size, f.CreatedAt.Format("2006-01-02 15:04")))
			}
			return &ToolResult{Success: true, Data: sb.String()}, nil

		case "info":
			var cat sandbox.MediaCategory
			if params.Category != "" {
				cat = sandbox.MediaCategory(params.Category)
			}
			files := mgr.ListMedia(cat)
			var totalSize int64
			for _, f := range files {
				totalSize += f.Size
			}
			return &ToolResult{Success: true, Data: fmt.Sprintf("Media summary:\n- Total files: %d\n- Total size: %d bytes (%.1f MB)\n- Categories: photos, videos, documents\n- Storage path: /workspace/downloads/",
				len(files), totalSize, float64(totalSize)/(1024*1024))}, nil

		case "cleanup":
			removed := mgr.CleanupExpired(params.RetentionDays)
			return &ToolResult{Success: true, Data: fmt.Sprintf("Cleanup complete. Removed %d expired files (retention: %d days).", removed, params.RetentionDays)}, nil

		default:
			return &ToolResult{Success: false, Error: fmt.Sprintf("unknown action: %s", params.Action)}, nil
		}
	})
}

// saveMediaFile is a helper for tools that need to save media bytes to the sandbox.
// It writes data to /workspace/downloads/{category}/filename.
func saveMediaFile(sbMgr *sandbox.Manager, sandboxID, workspacePath, filename, category string, data []byte) (string, error) {
	catDir := filepath.Join(workspacePath, "downloads", category)
	if err := os.MkdirAll(catDir, 0o755); err != nil {
		return "", fmt.Errorf("create media dir: %w", err)
	}

	safeName := sanitizeMediaFilename(filename)
	destPath := filepath.Join(catDir, safeName)

	// Docker-backed sandboxes need writes to go through the container.
	sb, err := sbMgr.Status(sandboxID)
	if err != nil {
		return "", err
	}

	if sandbox.IsDockerSandbox(sb.Type) {
		encoded := base64Encode(data)
		cmd := fmt.Sprintf("echo '%s' | base64 -d > /workspace/downloads/%s/%s", encoded, category, safeName)
		result, execErr := sbMgr.Exec(sandboxID, cmd, nil, 30)
		if execErr != nil {
			return "", fmt.Errorf("docker media save failed: %v", execErr)
		}
		if result.ExitCode != 0 {
			return "", fmt.Errorf("docker media save failed: %s", result.Stderr)
		}
		return destPath, nil
	}

	// Direct write for host-backed persistent sandboxes.
	if err := os.WriteFile(destPath, data, 0o640); err != nil {
		return "", fmt.Errorf("write media file: %w", err)
	}
	return destPath, nil
}

func sanitizeMediaFilename(name string) string {
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "\\", "_")
	name = strings.ReplaceAll(name, "..", "_")
	if len(name) > 200 {
		name = name[:200]
	}
	return name
}

func base64Encode(data []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var result strings.Builder
	for i := 0; i < len(data); i += 3 {
		b1 := data[i]
		b2 := byte(0)
		b3 := byte(0)
		if i+1 < len(data) {
			b2 = data[i+1]
		}
		if i+2 < len(data) {
			b3 = data[i+2]
		}
		result.WriteByte(alphabet[b1>>2])
		result.WriteByte(alphabet[((b1&0x3)<<4)|(b2>>4)])
		if i+1 < len(data) {
			result.WriteByte(alphabet[((b2&0xf)<<2)|(b3>>6)])
		} else {
			result.WriteByte('=')
		}
		if i+2 < len(data) {
			result.WriteByte(alphabet[b3&0x3f])
		} else {
			result.WriteByte('=')
		}
	}
	return result.String()
}
