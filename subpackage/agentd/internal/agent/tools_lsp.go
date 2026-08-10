package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/lsp"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

// registerLSPDefinition registers the lsp_definition tool.
func registerLSPDefinition(registry *ToolRegistry, sbMgr *sandbox.Manager, lspMgr *lsp.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "lsp_definition",
		Description: `Find the definition of a symbol at a position using LSP (Language Server Protocol).
Automatically detects project type, installs the language server if needed, and returns the definition location.
Supports: Rust, Go, C/C++, Python, TypeScript/JavaScript.`,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file": map[string]any{
					"type":        "string",
					"description": "Path to the source file (absolute or relative to sandbox root)",
				},
				"line": map[string]any{
					"type":        "integer",
					"description": "Line number (1-based, as shown in editors)",
				},
				"character": map[string]any{
					"type":        "integer",
					"description": "Character offset in the line (1-based)",
				},
			},
			"required": []string{"file", "line", "character"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			File      string `json:"file"`
			Line      int    `json:"line"`
			Character int    `json:"character"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := ctx.SnapshotSandboxID()
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		// Resolve file path
		filePath := resolveFilePath(ctx.SandboxPath, params.File)
		projectPath := findProjectRootFromFile(filePath)

		// Get or start LSP client
		client, ptype, err := lspMgr.GetOrStart(toolCtx, sandboxID, projectPath)
		if err != nil {
			return &ToolResult{
				Success: false,
				Error:   fmt.Sprintf("LSP unavailable: %v", err),
			}, nil
		}

		// Read file content
		content, err := os.ReadFile(filePath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("failed to read file: %v", err)}, nil
		}

		// Open document in LSP
		fileURI := "file://" + filePath
		if err := client.DidOpen(fileURI, string(content)); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP didOpen failed: %v", err)}, nil
		}
		defer client.DidClose(fileURI)

		// Convert to 0-based for LSP
		lspLine := params.Line - 1
		lspChar := params.Character - 1

		// Request definition
		defCtx, cancel := context.WithTimeout(toolCtx, 10*time.Second)
		defer cancel()

		locations, err := client.Definition(defCtx, fileURI, lspLine, lspChar)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP definition failed: %v", err)}, nil
		}

		if len(locations) == 0 {
			data, _ := json.Marshal(map[string]any{
				"message":     "No definition found",
				"projectType": ptype,
			})
			return &ToolResult{Success: true, Data: string(data)}, nil
		}

		// Format results
		results := make([]map[string]any, len(locations))
		for i, loc := range locations {
			results[i] = map[string]any{
				"uri":       loc.URI,
				"line":      loc.Range.Start.Line + 1, // Convert back to 1-based
				"character": loc.Range.Start.Character + 1,
			}
		}

		data, _ := json.Marshal(map[string]any{
			"locations":   results,
			"projectType": ptype,
		})
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

// registerLSPHover registers the lsp_hover tool.
func registerLSPHover(registry *ToolRegistry, sbMgr *sandbox.Manager, lspMgr *lsp.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "lsp_hover",
		Description: `Get hover information (type, documentation) for a symbol at a position using LSP.
Automatically detects project type and installs the language server if needed.`,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file": map[string]any{
					"type":        "string",
					"description": "Path to the source file",
				},
				"line": map[string]any{
					"type":        "integer",
					"description": "Line number (1-based)",
				},
				"character": map[string]any{
					"type":        "integer",
					"description": "Character offset (1-based)",
				},
			},
			"required": []string{"file", "line", "character"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			File      string `json:"file"`
			Line      int    `json:"line"`
			Character int    `json:"character"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := ctx.SnapshotSandboxID()
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		filePath := resolveFilePath(ctx.SandboxPath, params.File)
		projectPath := findProjectRootFromFile(filePath)

		client, ptype, err := lspMgr.GetOrStart(toolCtx, sandboxID, projectPath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP unavailable: %v", err)}, nil
		}

		content, err := os.ReadFile(filePath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("failed to read file: %v", err)}, nil
		}

		fileURI := "file://" + filePath
		if err := client.DidOpen(fileURI, string(content)); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP didOpen failed: %v", err)}, nil
		}
		defer client.DidClose(fileURI)

		lspLine := params.Line - 1
		lspChar := params.Character - 1

		hoverCtx, cancel := context.WithTimeout(toolCtx, 10*time.Second)
		defer cancel()

		hover, err := client.Hover(hoverCtx, fileURI, lspLine, lspChar)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP hover failed: %v", err)}, nil
		}

		if hover == nil {
			data, _ := json.Marshal(map[string]any{
				"message":     "No hover information",
				"projectType": ptype,
			})
			return &ToolResult{Success: true, Data: string(data)}, nil
		}

		data, _ := json.Marshal(map[string]any{
			"content":     hover.Contents.Value,
			"kind":        hover.Contents.Kind,
			"projectType": ptype,
		})
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

// registerLSPReferences registers the lsp_references tool.
func registerLSPReferences(registry *ToolRegistry, sbMgr *sandbox.Manager, lspMgr *lsp.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "lsp_references",
		Description: `Find all references to a symbol using LSP.
Automatically detects project type and installs the language server if needed.`,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file": map[string]any{
					"type":        "string",
					"description": "Path to the source file",
				},
				"line": map[string]any{
					"type":        "integer",
					"description": "Line number (1-based)",
				},
				"character": map[string]any{
					"type":        "integer",
					"description": "Character offset (1-based)",
				},
				"include_declaration": map[string]any{
					"type":        "boolean",
					"description": "Include the symbol declaration in results (default: true)",
					"default":     true,
				},
			},
			"required": []string{"file", "line", "character"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			File               string `json:"file"`
			Line               int    `json:"line"`
			Character          int    `json:"character"`
			IncludeDeclaration *bool  `json:"include_declaration"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		includeDecl := true
		if params.IncludeDeclaration != nil {
			includeDecl = *params.IncludeDeclaration
		}

		sandboxID := ctx.SnapshotSandboxID()
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		filePath := resolveFilePath(ctx.SandboxPath, params.File)
		projectPath := findProjectRootFromFile(filePath)

		client, ptype, err := lspMgr.GetOrStart(toolCtx, sandboxID, projectPath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP unavailable: %v", err)}, nil
		}

		content, err := os.ReadFile(filePath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("failed to read file: %v", err)}, nil
		}

		fileURI := "file://" + filePath
		if err := client.DidOpen(fileURI, string(content)); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP didOpen failed: %v", err)}, nil
		}
		defer client.DidClose(fileURI)

		lspLine := params.Line - 1
		lspChar := params.Character - 1

		refCtx, cancel := context.WithTimeout(toolCtx, 10*time.Second)
		defer cancel()

		locations, err := client.References(refCtx, fileURI, lspLine, lspChar, includeDecl)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP references failed: %v", err)}, nil
		}

		results := make([]map[string]any, len(locations))
		for i, loc := range locations {
			results[i] = map[string]any{
				"uri":       loc.URI,
				"line":      loc.Range.Start.Line + 1,
				"character": loc.Range.Start.Character + 1,
			}
		}

		data, _ := json.Marshal(map[string]any{
			"references":  results,
			"count":       len(results),
			"projectType": ptype,
		})
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

// registerLSPSymbols registers the lsp_symbols tool.
func registerLSPSymbols(registry *ToolRegistry, sbMgr *sandbox.Manager, lspMgr *lsp.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "lsp_symbols",
		Description: `List all symbols (functions, classes, variables, etc.) in a document using LSP.
Automatically detects project type and installs the language server if needed.`,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file": map[string]any{
					"type":        "string",
					"description": "Path to the source file",
				},
			},
			"required": []string{"file"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			File string `json:"file"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := ctx.SnapshotSandboxID()
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		filePath := resolveFilePath(ctx.SandboxPath, params.File)
		projectPath := findProjectRootFromFile(filePath)

		client, ptype, err := lspMgr.GetOrStart(toolCtx, sandboxID, projectPath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP unavailable: %v", err)}, nil
		}

		content, err := os.ReadFile(filePath)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("failed to read file: %v", err)}, nil
		}

		fileURI := "file://" + filePath
		if err := client.DidOpen(fileURI, string(content)); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP didOpen failed: %v", err)}, nil
		}
		defer client.DidClose(fileURI)

		symCtx, cancel := context.WithTimeout(toolCtx, 10*time.Second)
		defer cancel()

		symbols, err := client.DocumentSymbol(symCtx, fileURI)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("LSP symbols failed: %v", err)}, nil
		}

		data, _ := json.Marshal(map[string]any{
			"symbols":     symbols,
			"projectType": ptype,
		})
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

// resolveFilePath converts a possibly relative path to absolute.
func resolveFilePath(sandboxPath, file string) string {
	if filepath.IsAbs(file) {
		return file
	}
	return filepath.Join(sandboxPath, file)
}

// findProjectRootFromFile walks up from a file path to find the project root.
// It looks for .git, Cargo.toml, go.mod, package.json, etc.
func findProjectRootFromFile(startPath string) string {
	dir := filepath.Dir(startPath)
	for {
		// Check for common project markers
		markers := []string{".git", "Cargo.toml", "go.mod", "package.json", "pyproject.toml", "CMakeLists.txt"}
		for _, marker := range markers {
			if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
				return dir
			}
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			// Reached filesystem root, use the directory containing the file
			return filepath.Dir(startPath)
		}
		dir = parent
	}
}
