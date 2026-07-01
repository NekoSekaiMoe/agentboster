package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
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
				"url":    map[string]any{"type": "string", "description": "Git repository URL"},
				"branch": map[string]any{"type": "string", "description": "Branch to checkout (optional)"},
				"depth":  map[string]any{"type": "integer", "description": "Shallow clone depth (optional)"},
			},
			"required": []string{"url"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			URL    string `json:"url"`
			Branch string `json:"branch"`
			Depth  int    `json:"depth"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
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
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
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
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
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

func registerGitPush(registry *ToolRegistry, sbMgr *sandbox.Manager, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "git_push",
		Description: "Push commits to a remote repository. Before pushing, automatically fetches and rebases. Simple auto-resolvable conflicts are handled automatically; complex conflicts are escalated to the main agent. Never force-push unless explicitly requested. Set auto_commit=true to automatically commit all staged and unstaged changes before push (generates commit message via LLM).",
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
				"auto_commit": map[string]any{
					"type":        "boolean",
					"description": "Auto commit all changes before push (default: false). Generates commit message via LLM.",
					"default":     false,
				},
				"commit_message": map[string]any{
					"type":        "string",
					"description": "Commit message (optional). If not provided and auto_commit is true, message is auto-generated.",
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
			Path          string `json:"path"`
			Remote        string `json:"remote"`
			Branch        string `json:"branch"`
			AutoRebase    bool   `json:"auto_rebase"`
			AutoCommit    bool   `json:"auto_commit"`
			CommitMessage string `json:"commit_message"`
			Force         bool   `json:"force"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
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

		// Auto commit: stage all changes and commit
		var commitMsg string
		if params.AutoCommit {
			// Stage all changes
			addResult, err := sbMgr.Exec(sandboxID, fmt.Sprintf("cd %q && git add -A", params.Path), nil, 15)
			if err != nil || addResult.ExitCode != 0 {
				return &ToolResult{Success: false, Error: "git add failed"}, nil
			}

			commitMsg = params.CommitMessage
			if commitMsg == "" {
				// Generate commit message via LLM
				commitMsg, err = generateCommitMessage(toolCtx, sbMgr, sandboxID, params.Path, client)
				if err != nil {
					slog.Warn("auto_commit: failed to generate message, using fallback", "error", err)
					commitMsg = "chore: auto-commit changes"
				}
			}

			commitCmd := fmt.Sprintf("cd %q && git commit -m %q", params.Path, commitMsg)
			commitResult, err := sbMgr.Exec(sandboxID, commitCmd, nil, 30)
			if err != nil || commitResult.ExitCode != 0 {
				return &ToolResult{Success: false, Error: fmt.Sprintf("git commit failed: %s", commitResult.Stderr)}, nil
			}
		}

		// Auto rebase: fetch + rebase
		if params.AutoRebase {
			rebaseCmd := fmt.Sprintf("cd %q && git fetch %q", params.Path, remote)

			branch := params.Branch
			if branch == "" {
				rebaseCmd += fmt.Sprintf(" && git rebase %q/$(git branch --show-current)", remote)
			} else {
				rebaseCmd += fmt.Sprintf(" && git rebase %q/%q", remote, branch)
			}

			rebaseResult, err := sbMgr.Exec(sandboxID, rebaseCmd, nil, 60)
			if err != nil {
				return &ToolResult{Success: false, Error: fmt.Sprintf("git fetch/rebase error: %v", err)}, nil
			}

			if rebaseResult.ExitCode != 0 {
				checkResult, _ := sbMgr.Exec(sandboxID, fmt.Sprintf("cd %q && git diff --name-only --diff-filter=U", params.Path), nil, 10)
				if checkResult != nil && checkResult.Stdout != "" {
					return &ToolResult{
						Success: false,
						Error:   fmt.Sprintf("Complex rebase conflict detected. Unresolved files: %s. Manual resolution required.", checkResult.Stdout),
						Data:    rebaseResult.Stderr,
					}, nil
				}

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

		// Collect git info for completion notification
		gitInfo := collectGitInfo(toolCtx, sbMgr, sandboxID, params.Path, commitMsg)
		ctx.GitInfo = gitInfo

		resultData := map[string]any{
			"push_output": pushResult.Stdout,
			"git_info":    gitInfo,
		}
		resultJSON, _ := json.Marshal(resultData)

		return &ToolResult{Success: true, Data: string(resultJSON)}, nil
	})
}

// generateCommitMessage generates a commit message via LLM based on the diff.
func generateCommitMessage(ctx context.Context, sbMgr *sandbox.Manager, sandboxID, repoPath string, client *clawless.Client) (string, error) {
	// Get diff summary
	diffResult, err := sbMgr.Exec(sandboxID, fmt.Sprintf("cd %q && git diff --cached --stat", repoPath), nil, 15)
	if err != nil {
		return "", fmt.Errorf("git diff: %v", err)
	}
	if diffResult.ExitCode != 0 || strings.TrimSpace(diffResult.Stdout) == "" {
		return "chore: auto-commit changes", nil
	}

	// Get full diff (truncated)
	fullDiffResult, err := sbMgr.Exec(sandboxID, fmt.Sprintf("cd %q && git diff --cached --no-color | head -200", repoPath), nil, 15)
	if err != nil {
		return "", fmt.Errorf("git diff full: %v", err)
	}

	diffSummary := diffResult.Stdout
	fullDiff := fullDiffResult.Stdout

	prompt := fmt.Sprintf(`Generate a concise git commit message (max 72 chars for subject line) based on the diff summary.
Use conventional commits format: type(scope): description
Types: feat, fix, refactor, docs, test, chore, perf, style

Diff summary:
%s

Diff (truncated):
%s

Return only the commit message, nothing else.`, diffSummary, fullDiff)

	req := clawless.LLMProxyRequest{
		Model: "default",
		Messages: []clawless.Message{
			{Role: "system", Content: "You generate git commit messages. Respond only with the commit message."},
			{Role: "user", Content: prompt},
		},
		Stream: false,
	}

	respData, err := client.LLMProxyRequest(ctx, &req)
	if err != nil {
		return "", fmt.Errorf("LLM proxy: %v", err)
	}

	msg := strings.TrimSpace(string(respData))
	// Clean up: take first line only, trim quotes
	msg = strings.SplitN(msg, "\n", 2)[0]
	msg = strings.Trim(msg, "\"'")

	if msg == "" {
		return "chore: auto-commit changes", nil
	}
	return msg, nil
}

// collectGitInfo collects git metadata after a successful push.
func collectGitInfo(ctx context.Context, sbMgr *sandbox.Manager, sandboxID, repoPath string, commitMsg string) *clawless.GitInfo {
	info := &clawless.GitInfo{
		CommitMessage: commitMsg,
	}

	// Get commit hash
	hashResult, _ := sbMgr.Exec(sandboxID, fmt.Sprintf("cd %q && git rev-parse HEAD", repoPath), nil, 5)
	if hashResult != nil && hashResult.ExitCode == 0 {
		hash := strings.TrimSpace(hashResult.Stdout)
		if len(hash) >= 7 {
			info.CommitHash = hash[:7]
		} else {
			info.CommitHash = hash
		}
	}

	// Get remote URL
	remoteResult, _ := sbMgr.Exec(sandboxID, fmt.Sprintf("cd %q && git remote get-url origin", repoPath), nil, 5)
	if remoteResult != nil && remoteResult.ExitCode == 0 {
		remoteURL := strings.TrimSpace(remoteResult.Stdout)
		info.CompareURL = buildCompareURL(remoteURL, info.CommitHash)
	}

	// Get diff stats
	statResult, _ := sbMgr.Exec(sandboxID, fmt.Sprintf("cd %q && git diff --stat HEAD~1..HEAD 2>/dev/null || echo ''", repoPath), nil, 5)
	if statResult != nil && statResult.ExitCode == 0 && statResult.Stdout != "" {
		info.FilesChanged, info.Insertions, info.Deletions = parseDiffStat(statResult.Stdout)
	}

	return info
}

// buildCompareURL builds a GitHub/GitLab compare URL from a remote URL and commit hash.
func buildCompareURL(remoteURL, commitHash string) string {
	if commitHash == "" {
		return ""
	}

	// Parse org/repo from remote URL
	// Supports: git@github.com:org/repo.git, https://github.com/org/repo.git
	//           git@gitlab.com:org/repo.git, https://gitlab.com/org/repo.git
	var orgRepo string
	if strings.Contains(remoteURL, "@") {
		// SSH format: git@host:org/repo.git
		parts := strings.SplitN(remoteURL, ":", 2)
		if len(parts) == 2 {
			orgRepo = strings.TrimSuffix(parts[1], ".git")
		}
	} else if strings.Contains(remoteURL, "://") {
		// HTTPS format
		u := remoteURL
		u = strings.TrimPrefix(u, "https://")
		u = strings.TrimPrefix(u, "http://")
		// Remove host
		if idx := strings.Index(u, "/"); idx >= 0 {
			orgRepo = strings.TrimSuffix(u[idx+1:], ".git")
		}
	}

	if orgRepo == "" {
		return ""
	}

	if strings.Contains(remoteURL, "github.com") {
		return fmt.Sprintf("https://github.com/%s/compare/%s", orgRepo, commitHash)
	}
	if strings.Contains(remoteURL, "gitlab.com") {
		return fmt.Sprintf("https://gitlab.com/%s/-/compare/%s", orgRepo, commitHash)
	}
	return ""
}

// parseDiffStat parses "3 files changed, 42 insertions(+), 15 deletions(-)" style output.
func parseDiffStat(statOutput string) (filesChanged, insertions, deletions int) {
	lines := strings.Split(statOutput, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if strings.Contains(line, "changed") {
			parts := strings.Split(line, ",")
			for _, part := range parts {
				part = strings.TrimSpace(part)
				if strings.Contains(part, "file") {
					fmt.Sscanf(part, "%d", &filesChanged)
				} else if strings.Contains(part, "insertion") {
					fmt.Sscanf(part, "%d", &insertions)
				} else if strings.Contains(part, "deletion") {
					fmt.Sscanf(part, "%d", &deletions)
				}
			}
			break
		}
	}
	return
}
