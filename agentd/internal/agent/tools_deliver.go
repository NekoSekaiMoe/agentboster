package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/sandbox"
)

func registerDeliverFiles(registry *ToolRegistry, sbMgr *sandbox.Manager, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "deliver_files",
		Description: "Package and deliver files from the sandbox to the user. Uploads to cloud storage and returns a download link included in the task completion notification. Use this when: (1) the task produces output files like reports, builds, or artifacts, (2) the environment has no git and you need to deliver modified files, (3) the user explicitly asks for file download. For single files, delivers directly. For multiple files or directories, creates a .tar.gz archive.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"paths": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "File or directory paths to deliver (relative to /workspace). Directories are archived as .tar.gz.",
				},
				"format": map[string]any{
					"type":        "string",
					"enum":        []string{"auto", "tar.gz", "diff"},
					"description": "Delivery format. auto: single file=direct, multiple=tar.gz. tar.gz: always archive. diff: git diff patch. Default: auto.",
					"default":     "auto",
				},
				"message": map[string]any{
					"type":        "string",
					"description": "Optional delivery note to include in the completion notification.",
				},
			},
			"required": []string{"paths"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Paths   []string `json:"paths"`
			Format  string   `json:"format"`
			Message string   `json:"message"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if len(params.Paths) == 0 {
			return &ToolResult{Success: false, Error: "paths cannot be empty"}, nil
		}
		if params.Format == "" {
			params.Format = "auto"
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		// Resolve paths and determine delivery strategy
		absPaths := make([]string, len(params.Paths))
		for i, p := range params.Paths {
			absPaths[i] = "/workspace/" + p
		}

		var archivePath string
		var fileName string
		var err error

		switch params.Format {
		case "diff":
			archivePath, err = deliverDiff(toolCtx, sbMgr, sandboxID, absPaths)
			fileName = "changes.patch"
		case "tar.gz":
			archivePath, fileName, err = deliverTarGz(toolCtx, sbMgr, sandboxID, absPaths)
		case "auto":
			if len(absPaths) == 1 {
				// Check if it's a directory
				info, statErr := statSandboxPath(toolCtx, sbMgr, sandboxID, absPaths[0])
				if statErr != nil {
					return &ToolResult{Success: false, Error: fmt.Sprintf("path not found: %s", absPaths[0])}, nil
				}
				if info.IsDir() {
					archivePath, fileName, err = deliverTarGz(toolCtx, sbMgr, sandboxID, absPaths)
				} else {
					archivePath = absPaths[0]
					fileName = filepath.Base(absPaths[0])
				}
			} else {
				archivePath, fileName, err = deliverTarGz(toolCtx, sbMgr, sandboxID, absPaths)
			}
		default:
			return &ToolResult{Success: false, Error: fmt.Sprintf("unknown format: %s", params.Format)}, nil
		}

		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("prepare delivery: %v", err)}, nil
		}

		// Read the file content from sandbox
		content, err := readFileFromSandbox(toolCtx, sbMgr, sandboxID, archivePath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("read file: %v", err)}, nil
		}

		// Upload to ClawLess Blob storage
		uploadResult, err := client.UploadFile(toolCtx, ctx.SessionID, fileName, content, 7*24*time.Hour)
		if err != nil {
			slog.Warn("deliver_files: upload failed", "error", err)
			return &ToolResult{Success: false, Error: fmt.Sprintf("upload: %v", err)}, nil
		}

		// Store delivery info in AgentContext for the completion notification
		ctx.DeliveryURL = uploadResult.URL
		ctx.DeliveryFiles = []string{fileName}
		ctx.DeliverySize = uploadResult.Size

		slog.Info("deliver_files: success",
			"file", fileName,
			"size", uploadResult.Size,
			"url", uploadResult.URL,
		)

		return &ToolResult{
			Success: true,
			Data: fmt.Sprintf("Files delivered: %s (%d bytes)\nDownload URL: %s",
				fileName, uploadResult.Size, uploadResult.URL),
		}, nil
	})
}

func deliverDiff(ctx context.Context, sbMgr *sandbox.Manager, sandboxID string, paths []string) (string, error) {
	timestamp := time.Now().Format("20060102-150405")
	patchPath := fmt.Sprintf("/tmp/delivery-%s.patch", timestamp)

	// Build git diff command
	pathStr := strings.Join(paths, " ")
	cmd := fmt.Sprintf("cd /workspace && git diff --no-color -- %s > %s 2>/dev/null || diff -rN %s /dev/null > %s 2>/dev/null", pathStr, patchPath, pathStr, patchPath)

	result, err := sbMgr.Exec(sandboxID, cmd, nil, 30)
	if err != nil {
		return "", fmt.Errorf("generate diff: %v", err)
	}
	if result.ExitCode != 0 && result.Stdout == "" {
		return "", fmt.Errorf("diff generation failed: %s", result.Stderr)
	}

	return patchPath, nil
}

func deliverTarGz(ctx context.Context, sbMgr *sandbox.Manager, sandboxID string, paths []string) (string, string, error) {
	timestamp := time.Now().Format("20060102-150405")
	archivePath := fmt.Sprintf("/tmp/delivery-%s.tar.gz", timestamp)
	fileName := fmt.Sprintf("delivery-%s.tar.gz", timestamp)

	// Build tar command — use -C /workspace and relative paths
	pathStr := strings.Join(paths, " ")
	cmd := fmt.Sprintf("tar -czf %s -C /workspace %s", archivePath, pathStr)

	result, err := sbMgr.Exec(sandboxID, cmd, nil, 60)
	if err != nil {
		return "", "", fmt.Errorf("create archive: %v", err)
	}
	if result.ExitCode != 0 {
		return "", "", fmt.Errorf("tar failed: %s", result.Stderr)
	}

	return archivePath, fileName, nil
}

func statSandboxPath(ctx context.Context, sbMgr *sandbox.Manager, sandboxID, path string) (os.FileInfo, error) {
	cmd := fmt.Sprintf("stat -c '%%F' %s", path)
	result, err := sbMgr.Exec(sandboxID, cmd, nil, 5)
	if err != nil {
		return nil, err
	}
	// If stat succeeds, the file exists
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("path does not exist: %s", path)
	}
	// Return a minimal FileInfo — we only need IsDir()
	return &sandboxFileInfo{isDir: strings.Contains(result.Stdout, "directory")}, nil
}

type sandboxFileInfo struct {
	isDir bool
}

func (f *sandboxFileInfo) Name() string       { return "" }
func (f *sandboxFileInfo) Size() int64        { return 0 }
func (f *sandboxFileInfo) Mode() os.FileMode  { return 0 }
func (f *sandboxFileInfo) ModTime() time.Time { return time.Time{} }
func (f *sandboxFileInfo) IsDir() bool        { return f.isDir }
func (f *sandboxFileInfo) Sys() any           { return nil }

func readFileFromSandbox(ctx context.Context, sbMgr *sandbox.Manager, sandboxID, path string) ([]byte, error) {
	// Read file content using base64 encoding to handle binary files safely
	cmd := fmt.Sprintf("base64 %s", path)
	result, err := sbMgr.Exec(sandboxID, cmd, nil, 30)
	if err != nil {
		return nil, fmt.Errorf("read file: %v", err)
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("read failed: %s", result.Stderr)
	}

	content, err := decodeBase64(result.Stdout)
	if err != nil {
		return nil, fmt.Errorf("decode: %v", err)
	}
	return content, nil
}

func decodeBase64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	return base64.StdEncoding.DecodeString(s)
}
