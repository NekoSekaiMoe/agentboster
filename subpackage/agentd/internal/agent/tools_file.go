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

func registerRead(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "read",
		Description: "Read a file from the sandbox workspace. Returns file content.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "File path (relative to workspace)"},
				"offset": map[string]any{"type": "integer", "description": "Line offset to start reading", "default": 0},
				"limit":  map[string]any{"type": "integer", "description": "Number of lines to read", "default": 0},
			},
			"required": []string{"path"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path   string `json:"path"`
			Offset int    `json:"offset"`
			Limit  int    `json:"limit"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sbPath, err := getSandboxWorkspace(sbMgr, ctx.SnapshotSandboxID())
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		fullPath, err := safePath(sbPath, params.Path)
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}
		data, err := os.ReadFile(fullPath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("read file: %v", err)}, nil
		}

		content := string(data)
		if params.Offset > 0 || params.Limit > 0 {
			lines := strings.Split(content, "\n")
			start := params.Offset
			end := len(lines)
			if params.Limit > 0 {
				end = start + params.Limit
				if end > len(lines) {
					end = len(lines)
				}
			}
			if start < len(lines) {
				content = strings.Join(lines[start:end], "\n")
			} else {
				content = ""
			}
		}

		return &ToolResult{Success: true, Data: content}, nil
	})
}

func registerWrite(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "write",
		Description: "Write content to a file in the sandbox workspace. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":    map[string]any{"type": "string", "description": "File path (relative to workspace)"},
				"content": map[string]any{"type": "string", "description": "File content to write"},
			},
			"required": []string{"path", "content"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sbPath, err := getSandboxWorkspace(sbMgr, ctx.SnapshotSandboxID())
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		fullPath, err := safePath(sbPath, params.Path)
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}
		dir := filepath.Dir(fullPath)
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("create dir: %v", err)}, nil
		}
		if err := os.WriteFile(fullPath, []byte(params.Content), 0o640); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("write file: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: fmt.Sprintf("Wrote %d bytes to %s", len(params.Content), params.Path)}, nil
	})
}

func registerEdit(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "edit",
		Description: "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":    map[string]any{"type": "string", "description": "File path (relative to workspace)"},
				"oldText": map[string]any{"type": "string", "description": "Exact text to find and replace"},
				"newText": map[string]any{"type": "string", "description": "Replacement text"},
			},
			"required": []string{"path", "oldText", "newText"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path    string `json:"path"`
			OldText string `json:"oldText"`
			NewText string `json:"newText"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sbPath, err := getSandboxWorkspace(sbMgr, ctx.SnapshotSandboxID())
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		fullPath, err := safePath(sbPath, params.Path)
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}
		data, err := os.ReadFile(fullPath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("read file: %v", err)}, nil
		}

		content := string(data)
		if !strings.Contains(content, params.OldText) {
			return &ToolResult{Success: false, Error: fmt.Sprintf("oldText not found in %s", params.Path)}, nil
		}

		newContent := strings.Replace(content, params.OldText, params.NewText, 1)
		if err := os.WriteFile(fullPath, []byte(newContent), 0o640); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("write file: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: fmt.Sprintf("Edited %s", params.Path)}, nil
	})
}

func registerLs(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "ls",
		Description: "List files and directories in the sandbox workspace.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "Directory path (relative to workspace)", "default": "."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path string `json:"path"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sbPath, err := getSandboxWorkspace(sbMgr, ctx.SnapshotSandboxID())
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		fullPath, err := safePath(sbPath, params.Path)
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}
		entries, err := os.ReadDir(fullPath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("list dir: %v", err)}, nil
		}

		var result strings.Builder
		for _, entry := range entries {
			prefix := "f"
			if entry.IsDir() {
				prefix = "d"
			}
			result.WriteString(fmt.Sprintf("%s  %s\n", prefix, entry.Name()))
		}

		return &ToolResult{Success: true, Data: result.String()}, nil
	})
}

func registerGrep(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "grep",
		Description: "Search for a pattern in files. Uses grep -r. Returns matching lines with file paths and line numbers.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "Search pattern (regex)"},
				"path":    map[string]any{"type": "string", "description": "Directory to search (relative to workspace)", "default": "."},
			},
			"required": []string{"pattern"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Pattern string `json:"pattern"`
			Path    string `json:"path"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := ctx.SnapshotSandboxID()
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := fmt.Sprintf("grep -rn %q %q 2>/dev/null || echo 'no matches'", params.Pattern, params.Path)
		result, err := sbMgr.Exec(sandboxID, cmd, nil, 30)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("grep error: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: result.Stdout}, nil
	})
}

func registerGlob(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "glob",
		Description: "Find files matching a glob pattern (e.g., **/*.go, *.py).",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "Glob pattern (e.g., **/*.go)"},
				"path":    map[string]any{"type": "string", "description": "Base directory (relative to workspace)", "default": "."},
			},
			"required": []string{"pattern"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Pattern string `json:"pattern"`
			Path    string `json:"path"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sbPath, err := getSandboxWorkspace(sbMgr, ctx.SnapshotSandboxID())
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		basePath, err := safePath(sbPath, params.Path)
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		matches, err := filepath.Glob(filepath.Join(basePath, params.Pattern))
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("glob error: %v", err)}, nil
		}

		var result strings.Builder
		for _, m := range matches {
			rel, _ := filepath.Rel(sbPath, m)
			result.WriteString(rel + "\n")
		}

		return &ToolResult{Success: true, Data: result.String()}, nil
	})
}

func registerPatch(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "patch",
		Description: "Apply a unified diff patch to a file. The patch must be in unified diff format.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":  map[string]any{"type": "string", "description": "File path to patch (relative to workspace)"},
				"patch": map[string]any{"type": "string", "description": "Unified diff patch content"},
			},
			"required": []string{"path", "patch"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path  string `json:"path"`
			Patch string `json:"patch"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := ctx.SnapshotSandboxID()
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		// Write patch to temp file, apply with patch command
		applyCmd := fmt.Sprintf("cat > /tmp/agentd-patch.diff << 'PATCH_EOF'\n%s\nPATCH_EOF\npatch -p0 -i /tmp/agentd-patch.diff %q", params.Patch, params.Path)
		result, err := sbMgr.Exec(sandboxID, applyCmd, nil, 30)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("patch error: %v", err)}, nil
		}

		return &ToolResult{Success: result.ExitCode == 0, Data: result.Stdout, Error: result.Stderr}, nil
	})
}

// getSandboxWorkspace returns the workspace path for the current sandbox.
func getSandboxWorkspace(sbMgr *sandbox.Manager, sandboxID string) (string, error) {
	if sandboxID == "" {
		return "", fmt.Errorf("no sandbox available")
	}
	sb, err := sbMgr.Status(sandboxID)
	if err != nil {
		return "", fmt.Errorf("sandbox not found: %v", err)
	}
	return sb.Path + "/workspace", nil
}

// safePath joins a user-supplied relative path with the sandbox workspace and
// validates that the resolved path does not escape the workspace boundary.
func safePath(workspace, userPath string) (string, error) {
	clean := filepath.Clean(filepath.Join(workspace, userPath))
	if !strings.HasPrefix(clean, filepath.Clean(workspace)+string(os.PathSeparator)) && clean != filepath.Clean(workspace) {
		return "", fmt.Errorf("path traversal denied: %q escapes workspace", userPath)
	}
	return clean, nil
}
