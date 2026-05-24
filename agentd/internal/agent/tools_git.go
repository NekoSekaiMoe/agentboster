package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/clawless/agentd/internal/sandbox"
)

// safeShellArg matches characters that are safe to pass as shell arguments.
var safeShellArg = regexp.MustCompile(`^[a-zA-Z0-9_./:@=+,-]+$`)

func registerGitClone(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "git_clone",
		Description: "Clone a git repository into the sandbox workspace.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url":      map[string]any{"type": "string", "description": "Git repository URL"},
				"branch":   map[string]any{"type": "string", "description": "Branch to checkout (optional)"},
				"depth":    map[string]any{"type": "integer", "description": "Shallow clone depth (optional)"},
			},
			"required": []string{"url"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			URL    string `json:"url"`
			Branch string `json:"branch"`
			Depth  int    `json:"depth"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		if !safeShellArg.MatchString(params.URL) {
			return &ToolResult{Success: false, Error: "invalid characters in git URL"}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := "git clone"
		if params.Depth > 0 {
			cmd += fmt.Sprintf(" --depth %d", params.Depth)
		}
		if params.Branch != "" {
			if !safeShellArg.MatchString(params.Branch) {
				return &ToolResult{Success: false, Error: "invalid characters in branch name"}, nil
			}
			cmd += fmt.Sprintf(" --branch %s", params.Branch)
		}
		cmd += fmt.Sprintf(" %q repo", params.URL)

		result, err := sbMgr.Exec(sandboxID, cmd, nil, 120)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("git clone error: %v", err)}, nil
		}

		return &ToolResult{Success: result.ExitCode == 0, Data: result.Stdout, Error: result.Stderr}, nil
	})
}

func registerGitDiff(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "git_diff",
		Description: "Show git diff in the sandbox workspace.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "Path to git repo (relative to workspace)", "default": "."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		if !safeShellArg.MatchString(params.Path) {
			return &ToolResult{Success: false, Error: "invalid characters in path"}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := fmt.Sprintf("cd %q && git diff", params.Path)
		result, err := sbMgr.Exec(sandboxID, cmd, nil, 30)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("git diff error: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: result.Stdout}, nil
	})
}

func registerGitStatus(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "git_status",
		Description: "Show git status in the sandbox workspace.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "Path to git repo (relative to workspace)", "default": "."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		if !safeShellArg.MatchString(params.Path) {
			return &ToolResult{Success: false, Error: "invalid characters in path"}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := fmt.Sprintf("cd %q && git status", params.Path)
		result, err := sbMgr.Exec(sandboxID, cmd, nil, 15)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("git status error: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: result.Stdout}, nil
	})
}

func registerGitPush(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "git_push",
		Description: "Push commits to a remote repository. Before pushing, automatically fetches and rebases. Simple auto-resolvable conflicts are handled automatically; complex conflicts are escalated to the main agent. Never force-push unless explicitly requested.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{
					"type":        "string",
					"description": "Path to git repo (relative to workspace)",
					"default":     ".",
				},
				"remote": map[string]any{
					"type":        "string",
					"description": "Remote name (default: origin)",
					"default":     "origin",
				},
				"branch": map[string]any{
					"type":        "string",
					"description": "Branch to push (default: current branch)",
				},
				"auto_rebase": map[string]any{
					"type":        "boolean",
					"description": "Auto fetch+rebase before push (default: true)",
					"default":     true,
				},
				"force": map[string]any{
					"type":        "boolean",
					"description": "Force push (default: false). Only use when explicitly requested by the user.",
					"default":     false,
				},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path       string `json:"path"`
			Remote     string `json:"remote"`
			Branch     string `json:"branch"`
			AutoRebase bool   `json:"auto_rebase"`
			Force      bool   `json:"force"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		if !safeShellArg.MatchString(params.Path) {
			return &ToolResult{Success: false, Error: "invalid characters in path"}, nil
		}
		if params.Remote != "" && !safeShellArg.MatchString(params.Remote) {
			return &ToolResult{Success: false, Error: "invalid characters in remote name"}, nil
		}
		if params.Branch != "" && !safeShellArg.MatchString(params.Branch) {
			return &ToolResult{Success: false, Error: "invalid characters in branch name"}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		remote := params.Remote
		if remote == "" {
			remote = "origin"
		}

		// Auto rebase: fetch + rebase
		if params.AutoRebase {
			rebaseCmd := fmt.Sprintf("cd %q && git fetch %q", params.Path, remote)

			// Determine target branch for rebase
			branch := params.Branch
			if branch == "" {
				// Use current branch
				rebaseCmd += fmt.Sprintf(" && git rebase %q/$(git branch --show-current)", remote)
			} else {
				rebaseCmd += fmt.Sprintf(" && git rebase %q/%q", remote, branch)
			}

			rebaseResult, err := sbMgr.Exec(sandboxID, rebaseCmd, nil, 60)
			if err != nil {
				return &ToolResult{Success: false, Error: fmt.Sprintf("git fetch/rebase error: %v", err)}, nil
			}

			// Check for rebase conflicts
			if rebaseResult.ExitCode != 0 {
				// Check if there are unresolved conflicts
				checkResult, _ := sbMgr.Exec(sandboxID, fmt.Sprintf("cd %q && git diff --name-only --diff-filter=U", params.Path), nil, 10)
				if checkResult != nil && checkResult.Stdout != "" {
					// Complex conflict — escalate to main agent
					return &ToolResult{
						Success: false,
						Error:   fmt.Sprintf("Complex rebase conflict detected. Unresolved files: %s. Manual resolution required.", checkResult.Stdout),
						Data:    rebaseResult.Stderr,
					}, nil
				}

				// Try auto-resolve: attempt git rebase --continue
				continueResult, _ := sbMgr.Exec(sandboxID, fmt.Sprintf("cd %q && git rebase --continue", params.Path), nil, 30)
				if continueResult != nil && continueResult.ExitCode != 0 {
					return &ToolResult{
						Success: false,
						Error:   fmt.Sprintf("Rebase conflict could not be auto-resolved. Please escalate to main agent.\n%s", rebaseResult.Stderr),
					}, nil
				}
			}
		}

		// Push
		pushCmd := fmt.Sprintf("cd %q && git push", params.Path)
		if remote != "" {
			pushCmd += " " + remote
		}
		if params.Branch != "" {
			pushCmd += " " + params.Branch
		}
		if params.Force {
			pushCmd += " --force"
		}

		pushResult, err := sbMgr.Exec(sandboxID, pushCmd, nil, 60)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("git push error: %v", err)}, nil
		}

		if pushResult.ExitCode != 0 {
			return &ToolResult{Success: false, Error: pushResult.Stderr, Data: pushResult.Stdout}, nil
		}

		return &ToolResult{Success: true, Data: pushResult.Stdout}, nil
	})
}