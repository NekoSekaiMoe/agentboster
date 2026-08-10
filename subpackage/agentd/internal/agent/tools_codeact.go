package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

const CodeActSystemPrompt = `You are operating in CodeAct mode. Instead of calling tools directly, you write and execute code to accomplish tasks.

## How CodeAct Works
1. You write your reasoning/thinking in plain text
2. You write code in code blocks (bash, js, python)
3. The system executes your code and returns the output
4. You analyze the output and decide next steps
5. When done, output <end_task>

## Code Block Format
Use one of these language tags:
- ` + "```bash" + ` for shell commands
- ` + "```js" + ` for JavaScript (executed with node)
- ` + "```python" + ` for Python

## Rules
- Write ONE code block per response (the first one will be executed)
- After seeing execution output, you can write another code block
- If code fails, analyze the error and try a fix
- Use console.log() in JS or print() in Python to output results
- For bash, output is whatever the command prints
- When your task is complete, output <end_task>
- You have a limited number of turns — be efficient

## Self-Debugging
When code fails:
1. Read the error message carefully
2. Check if commands/files exist: which <cmd>, ls -la <path>
3. Check environment: env | head -20
4. Check permissions: ls -la, stat <file>
5. Fix the issue and try again

## Workspace
- Your working directory is /workspace
- Skills are in /workspace/skills/
- Downloads go to /workspace/downloads/
- Session state is in /workspace/sessions/
- Outputs go to /workspace/outputs/
`

func registerCodeAct(registry *ToolRegistry, sbMgr *sandbox.Manager, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "codeact",
		Description: `Execute a CodeAct session: LLM generates code → sandbox executes → observe output → self-correct loop.

Use this for complex multi-step tasks where you need to:
- Debug issues by writing and running diagnostic scripts
- Chain multiple commands with conditional logic
- Process data iteratively
- Set up development environments

The session runs up to max_turns iterations. Each turn:
1. You write thinking + one code block
2. System executes the code
3. You see the output and decide next steps
4. Output <end_task> when done`,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"task": map[string]any{
					"type":        "string",
					"description": "The task to accomplish via code execution",
				},
				"max_turns": map[string]any{
					"type":        "integer",
					"description": "Maximum number of code execution turns. Default: 10",
					"default":     10,
				},
				"model": map[string]any{
					"type":        "string",
					"description": "LLM model to use. Default: inherit from parent",
				},
			},
			"required": []string{"task"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Task     string `json:"task"`
			MaxTurns int    `json:"max_turns"`
			Model    string `json:"model"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		if params.MaxTurns <= 0 {
			params.MaxTurns = 10
		}
		if params.MaxTurns > 30 {
			params.MaxTurns = 30 // hard cap
		}

		model := params.Model
		if model == "" {
			model = ctx.Model
		}

		sandboxID := ctx.SnapshotSandboxID()
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available for codeact"}, nil
		}

		// Build the task prompt
		taskPrompt := fmt.Sprintf("Task: %s\n\nYou are in a sandbox at /workspace/. Write code to accomplish this task. Output <end_task> when done.", params.Task)

		session := &CodeActSession{
			ID:        fmt.Sprintf("codeact_%d", timeNow()),
			SandboxID: sandboxID,
			Messages: []Message{
				{Role: "user", Content: taskPrompt},
			},
			MaxTurns: params.MaxTurns,
			Model:    model,
			Client:   client,
			SbMgr:    sbMgr,
		}

		result, err := RunCodeActSession(toolCtx, session, CodeActSystemPrompt)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("codeact session failed: %v", err)}, nil
		}

		// Format the result
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("CodeAct session completed (reason: %s, turns: %d)\n\n", result.EndReason, len(result.Turns)))

		for _, turn := range result.Turns {
			sb.WriteString(fmt.Sprintf("--- Turn %d ---\n", turn.Turn))
			if turn.Thinking != "" {
				sb.WriteString(fmt.Sprintf("Thinking: %s\n", turn.Thinking))
			}
			for i, block := range turn.CodeBlocks {
				sb.WriteString(fmt.Sprintf("Code [%s]:\n%s\n", block.Lang, block.Code))
				if i < len(turn.Results) {
					r := turn.Results[i]
					if r.Output != "" {
						sb.WriteString(fmt.Sprintf("Output:\n%s\n", r.Output))
					}
					if r.Error {
						sb.WriteString(fmt.Sprintf("Error (exit code %d)\n", r.ExitCode))
					}
				}
			}
			sb.WriteString("\n")
		}

		if result.Error != "" {
			sb.WriteString(fmt.Sprintf("Error: %s\n", result.Error))
		}

		return &ToolResult{
			Success: result.EndReason == "end_task",
			Data:    sb.String(),
		}, nil
	})
}

func timeNow() int64 {
	return time.Now().Unix()
}
