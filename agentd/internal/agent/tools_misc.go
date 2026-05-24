package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/clawless/agentd/internal/clawless"
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
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		manager := params.Manager
		if manager == "auto" {
			manager = "apt" // default
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

func registerNotifyUser(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "notify_user",
		Description: "Send a notification message to the user. Use this to report progress, ask for input, or escalate issues.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"message": map[string]any{"type": "string", "description": "Message to send to the user"},
				"level":   map[string]any{"type": "string", "description": "Notification level: info, warning, error. Default: info", "default": "info"},
			},
			"required": []string{"message"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Message string `json:"message"`
			Level   string `json:"level"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		slog.Info("notify_user", "level", params.Level, "message", params.Message)

		// In Phase 5, this would send via ClawLess API to the user's chat platform
		// For now, log and return success
		return &ToolResult{
			Success: true,
			Data:    fmt.Sprintf("Notification sent [%s]: %s", params.Level, params.Message),
		}, nil
	})
}

func registerAskQuestion(registry *ToolRegistry, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "ask_question",
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
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
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

		// Ask and wait for response
		answers, err := svc.Ask(toolCtx, ctx.SessionID, prompts)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("question failed: %v", err)}, nil
		}

		// Format answers
		result := "User answered:\n"
		for i, prompt := range params.Questions {
			if i < len(answers) {
				result += fmt.Sprintf("- %s: %s\n", prompt.Question, formatAnswers(answers[i]))
			}
		}

		return &ToolResult{Success: true, Data: result}, nil
	})
}

func formatAnswers(answers []string) string {
	if len(answers) == 0 {
		return "(no answer)"
	}
	result := ""
	for i, a := range answers {
		if i > 0 {
			result += ", "
		}
		result += a
	}
	return result
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
