package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/clawless/agentd/internal/sandbox"
)

func registerSandboxInstall(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "sandbox_install",
		Description: "Install packages or tools in the sandbox. Supports apt, pip, npm, go install, etc.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"packages": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "List of packages to install"},
				"manager":  map[string]any{"type": "string", "description": "Package manager: apt, pip, npm, go. Default: auto-detect", "default": "auto"},
			},
			"required": []string{"packages"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Packages []string `json:"packages"`
			Manager  string   `json:"manager"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		manager := params.Manager
		if manager == "auto" {
			manager = "apt" // default
		}

		// Validate all package names to prevent command injection
		for _, pkg := range params.Packages {
			if !safeShellArg.MatchString(pkg) {
				return &ToolResult{Success: false, Error: fmt.Sprintf("invalid characters in package name: %q", pkg)}, nil
			}
		}

		var cmd string
		switch manager {
		case "apt":
			cmd = fmt.Sprintf("apt-get update && apt-get install -y %s", joinPackages(params.Packages))
		case "pip":
			cmd = fmt.Sprintf("pip install %s", joinPackages(params.Packages))
		case "npm":
			cmd = fmt.Sprintf("npm install -g %s", joinPackages(params.Packages))
		case "go":
			cmd = fmt.Sprintf("go install %s", joinPackages(params.Packages))
		default:
			return &ToolResult{Success: false, Error: fmt.Sprintf("unknown package manager: %s", manager)}, nil
		}

		result, err := sbMgr.Exec(sandboxID, cmd, nil, 300)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("install error: %v", err)}, nil
		}

		return &ToolResult{Success: result.ExitCode == 0, Data: result.Stdout, Error: result.Stderr}, nil
	})
}

func registerAskQuestion(registry *ToolRegistry, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "ask_question",
		Description: `Ask the user a question during execution. Use this to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices
4. Offer choices to the user about what direction to take.

Supports multiple questions in one call, each with options. The user's answers are returned as arrays of labels.`,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"questions": map[string]any{
					"type":        "array",
					"description": "Questions to ask (1-4 questions per call)",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"question": map[string]any{
								"type":        "string",
								"description": "Complete question to ask the user",
							},
							"header": map[string]any{
								"type":        "string",
								"description": "Very short label for the question (max 30 chars)",
							},
							"options": map[string]any{
								"type":        "array",
								"description": "Available choices (2-4 options recommended)",
								"items": map[string]any{
									"type": "object",
									"properties": map[string]any{
										"label":       map[string]any{"type": "string", "description": "Display text (1-5 words, concise)"},
										"description": map[string]any{"type": "string", "description": "Explanation of choice"},
									},
									"required": []string{"label"},
								},
							},
							"multiple": map[string]any{
								"type":        "boolean",
								"description": "Allow selecting multiple choices. Default: false",
								"default":     false,
							},
						},
						"required": []string{"question", "options"},
					},
				},
			},
			"required": []string{"questions"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Questions []struct {
				Question string `json:"question"`
				Header   string `json:"header"`
				Options  []struct {
					Label       string `json:"label"`
					Description string `json:"description"`
				} `json:"options"`
				Multiple bool `json:"multiple"`
			} `json:"questions"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		if len(params.Questions) == 0 {
			return &ToolResult{Success: false, Error: "no questions provided"}, nil
		}

		// Get the question service from the agent context
		svc := ctx.QuestionService
		if svc == nil {
			return &ToolResult{Success: false, Error: "question service not available"}, nil
		}

		// Convert to QuestionPrompt
		prompts := make([]QuestionPrompt, len(params.Questions))
		for i, q := range params.Questions {
			opts := make([]QuestionOption, len(q.Options))
			for j, o := range q.Options {
				opts[j] = QuestionOption{Label: o.Label, Description: o.Description}
			}
			prompts[i] = QuestionPrompt{
				Question: q.Question,
				Header:   q.Header,
				Options:  opts,
				Multiple: q.Multiple,
				Custom:   true,
			}
		}

		// Ask (fire-and-forget, answer comes via clawless callback)
		err := svc.Ask(toolCtx, ctx.SessionID, prompts)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("question failed: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: "Question sent to user. Answer will be delivered via callback."}, nil
	})
}

func joinPackages(pkgs []string) string {
	result := ""
	for i, p := range pkgs {
		if i > 0 {
			result += " "
		}
		result += p
	}
	return result
}
