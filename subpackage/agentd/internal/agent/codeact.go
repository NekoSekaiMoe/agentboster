package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

// CodeActSession represents a single CodeAct interaction session.
type CodeActSession struct {
	ID        string
	SandboxID string
	Messages  []Message
	MaxTurns  int
	TurnCount int
	Model     string
	Client    *clawless.Client
	SbMgr     *sandbox.Manager
}

// CodeActTurn records a single turn of CodeAct interaction.
type CodeActTurn struct {
	Turn       int             `json:"turn"`
	Thinking   string          `json:"thinking"`
	CodeBlocks []CodeBlock     `json:"code_blocks"`
	Results    []CodeActResult `json:"results"`
	Timestamp  time.Time       `json:"timestamp"`
}

// CodeBlock represents a parsed code block from LLM output.
type CodeBlock struct {
	Lang string `json:"lang"` // "bash" or "js"
	Code string `json:"code"`
}

// CodeActResult is the result of executing a code block.
type CodeActResult struct {
	Output   string `json:"output"`
	Error    bool   `json:"error"`
	ExitCode int    `json:"exit_code"`
}

// CodeActSessionResult is the final result of a CodeAct session.
type CodeActSessionResult struct {
	SessionID string        `json:"session_id"`
	Turns     []CodeActTurn `json:"turns"`
	Messages  []Message     `json:"messages"`
	EndReason string        `json:"end_reason"` // "end_task", "max_turns", "error"
	Error     string        `json:"error,omitempty"`
}

const (
	endTaskMarker   = "<end_task>"
	maxDefaultTurns = 10
	codeBlockRegex  = "(?s)```(js|javascript|bash|shell|sh|python|py)\\s*\\n(.*?)```"
)

var codeBlockRe = regexp.MustCompile(codeBlockRegex)

// parseCodeBlocks extracts code blocks from LLM response text.
func parseCodeBlocks(response string) (thinking string, blocks []CodeBlock) {
	matches := codeBlockRe.FindAllStringSubmatch(response, -1)
	for _, m := range matches {
		lang := normalizeLang(m[1])
		code := strings.TrimSpace(m[2])
		blocks = append(blocks, CodeBlock{Lang: lang, Code: code})
	}
	thinking = codeBlockRe.ReplaceAllString(response, "")
	thinking = strings.TrimSpace(thinking)
	return
}

// normalizeLang normalizes language tags to "bash" or "js".
func normalizeLang(tag string) string {
	switch strings.ToLower(tag) {
	case "bash", "shell", "sh":
		return "bash"
	case "js", "javascript":
		return "js"
	case "python", "py":
		return "bash" // python code blocks are executed via python3 in bash
	default:
		return "bash"
	}
}

// hasEndTask checks if the response contains the end-of-task marker.
func hasEndTask(response string) bool {
	return strings.Contains(response, endTaskMarker)
}

// stripEndTask removes the end_task marker from text.
func stripEndTask(text string) string {
	return strings.ReplaceAll(text, endTaskMarker, "")
}

// RunCodeActSession runs a complete CodeAct interaction session.
// Loop: LLM generates code → sandbox executes → observation → repeat.
func RunCodeActSession(
	ctx context.Context,
	session *CodeActSession,
	systemPrompt string,
) (*CodeActSessionResult, error) {

	result := &CodeActSessionResult{
		SessionID: session.ID,
		Turns:     make([]CodeActTurn, 0),
	}

	for session.TurnCount < session.MaxTurns {
		session.TurnCount++

		slog.Info("CodeAct: turn", "turn", session.TurnCount, "session", session.ID)

		// Build messages with system prompt
		allMessages := buildMessagesWithSystem(systemPrompt, session.Messages)

		// Call LLM
		llmResp, err := callLLMForCodeAct(ctx, session.Client, session.Model, allMessages)
		if err != nil {
			result.EndReason = "error"
			result.Error = fmt.Sprintf("LLM call failed at turn %d: %v", session.TurnCount, err)
			result.Messages = session.Messages
			return result, nil
		}

		// Check for end_task marker
		hasEnd := hasEndTask(llmResp.Content)

		// Strip end_task from content before storing
		cleanContent := stripEndTask(llmResp.Content)

		// Add assistant message
		session.Messages = append(session.Messages, Message{
			Role:    "assistant",
			Content: cleanContent,
		})

		// Parse code blocks
		thinking, codeBlocks := parseCodeBlocks(cleanContent)

		turn := CodeActTurn{
			Turn:       session.TurnCount,
			Thinking:   thinking,
			CodeBlocks: codeBlocks,
			Results:    make([]CodeActResult, 0),
			Timestamp:  time.Now(),
		}

		// If no code blocks and has end_task → session complete
		if len(codeBlocks) == 0 && hasEnd {
			result.Turns = append(result.Turns, turn)
			result.EndReason = "end_task"
			result.Messages = session.Messages
			return result, nil
		}

		// If no code blocks and no end_task → inject observation asking for action
		if len(codeBlocks) == 0 {
			observation := "[你没有执行任何动作。如需结束请输出 <end_task>，否则请编写代码执行操作。]"
			session.Messages = append(session.Messages, Message{
				Role:    "user",
				Content: observation,
			})
			result.Turns = append(result.Turns, turn)
			continue
		}

		// Execute code blocks
		var outputParts []string
		executionFailed := false

		for _, block := range codeBlocks {
			execResult := executeCodeBlock(ctx, session, block)
			turn.Results = append(turn.Results, execResult)

			if execResult.Error {
				outputParts = append(outputParts, fmt.Sprintf("[⚠ 执行错误]\n%s", execResult.Output))
				executionFailed = true
				break // stop executing subsequent blocks on error
			} else if execResult.Output != "" {
				outputParts = append(outputParts, fmt.Sprintf("[执行输出]\n%s", execResult.Output))
			} else {
				outputParts = append(outputParts, "[执行完成，无输出]")
			}
		}

		result.Turns = append(result.Turns, turn)

		// Build observation
		observation := strings.Join(outputParts, "\n\n")

		// If execution failed, inject diagnostic hints
		if executionFailed {
			diagnostic := generateDiagnosticHint(codeBlocks, turn.Results)
			observation = observation + "\n\n" + diagnostic
		}

		// Add turn status
		remaining := session.MaxTurns - session.TurnCount
		turnStatus := fmt.Sprintf("[📊 轮次状态: 第 %d/%d 轮，剩余 %d 轮]", session.TurnCount, session.MaxTurns, remaining)
		if remaining <= 1 {
			turnStatus += "\n[⚠ 即将达到最大轮次，请尽快完成操作]"
		}
		observation = observation + "\n\n" + turnStatus

		session.Messages = append(session.Messages, Message{
			Role:    "user",
			Content: observation,
		})

		// If has end_task after executing code → session complete
		if hasEnd {
			result.EndReason = "end_task"
			result.Messages = session.Messages
			return result, nil
		}
	}

	// Max turns reached
	result.EndReason = "max_turns"
	result.Messages = session.Messages
	return result, nil
}

// executeCodeBlock executes a single code block in the sandbox.
func executeCodeBlock(ctx context.Context, session *CodeActSession, block CodeBlock) CodeActResult {
	var cmd string
	switch block.Lang {
	case "js":
		// Write JS to temp file and execute with node
		cmd = fmt.Sprintf("cat > /tmp/codeact_script.js << 'SCRIPT_EOF'\n%s\nSCRIPT_EOF\nnode /tmp/codeact_script.js 2>&1", block.Code)
	case "bash":
		cmd = block.Code
	default:
		cmd = block.Code
	}

	execResult, err := session.SbMgr.Exec(session.SandboxID, cmd, nil, 30)
	if err != nil {
		return CodeActResult{
			Output:   err.Error(),
			Error:    true,
			ExitCode: -1,
		}
	}

	return CodeActResult{
		Output:   execResult.Stdout,
		Error:    execResult.ExitCode != 0,
		ExitCode: execResult.ExitCode,
	}
}

// generateDiagnosticHint generates diagnostic suggestions when code execution fails.
func generateDiagnosticHint(blocks []CodeBlock, results []CodeActResult) string {
	var failedBlock CodeBlock
	for i, r := range results {
		if r.Error {
			failedBlock = blocks[i]
			break
		}
	}

	hints := []string{"[🔧 诊断提示] 代码执行失败。建议检查以下几点："}

	// Check for common patterns in the failed code
	code := failedBlock.Code

	// Check for missing commands
	if strings.Contains(code, "npm ") || strings.Contains(code, "npx ") {
		hints = append(hints, "- npm/npx 命令可能未安装。尝试: node --version && npm --version")
	}
	if strings.Contains(code, "pip ") || strings.Contains(code, "python3 ") {
		hints = append(hints, "- Python/pip 可能未安装。尝试: python3 --version && pip --version")
	}
	if strings.Contains(code, "go ") || strings.Contains(code, "golang") {
		hints = append(hints, "- Go 可能未安装。尝试: go version")
	}

	// Check for file operations
	if strings.Contains(code, "cat ") || strings.Contains(code, "ls ") || strings.Contains(code, "cd ") {
		hints = append(hints, "- 文件/目录可能不存在。尝试: ls -la /workspace/")
	}

	// Check for permission issues
	if strings.Contains(code, "Permission denied") || strings.Contains(code, "EACCES") {
		hints = append(hints, "- 权限不足。尝试: ls -la 检查文件权限，或使用 chmod")
	}

	// Check for port conflicts
	if strings.Contains(code, "listen") || strings.Contains(code, "port") || strings.Contains(code, ":3000") || strings.Contains(code, ":8080") {
		hints = append(hints, "- 端口可能被占用。尝试: ss -tlnp | grep <port>")
	}

	// Check for network issues
	if strings.Contains(code, "curl ") || strings.Contains(code, "wget ") || strings.Contains(code, "fetch") {
		hints = append(hints, "- 网络连接可能不可用。尝试: ping -c 1 8.8.8.8")
	}

	// Generic hints
	hints = append(hints, "- 检查环境变量: env | head -20")
	hints = append(hints, "- 检查工作目录: pwd && ls -la")

	return strings.Join(hints, "\n")
}

// buildMessagesWithSystem prepends system prompt to messages.
func buildMessagesWithSystem(systemPrompt string, messages []Message) []Message {
	all := make([]Message, 0, len(messages)+1)
	all = append(all, Message{Role: "system", Content: systemPrompt})
	all = append(all, messages...)
	return all
}

// callLLMForCodeAct calls the LLM via ClawLess proxy.
func callLLMForCodeAct(ctx context.Context, client *clawless.Client, model string, messages []Message) (*LLMResponse, error) {
	clawlessMsgs := make([]clawless.Message, len(messages))
	for i, m := range messages {
		clawlessMsgs[i] = clawless.Message{Role: m.Role, Content: m.Content}
	}

	req := clawless.LLMProxyRequest{
		Model:    model,
		Messages: clawlessMsgs,
		Stream:   false,
	}

	respData, err := client.LLMProxyRequest(ctx, &req)
	if err != nil {
		return nil, fmt.Errorf("LLM proxy request: %w", err)
	}

	var proxyResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}

	if err := json.Unmarshal(respData, &proxyResp); err != nil {
		return &LLMResponse{Content: string(respData)}, nil
	}

	if len(proxyResp.Choices) == 0 {
		return nil, fmt.Errorf("no choices in LLM response")
	}

	return &LLMResponse{Content: proxyResp.Choices[0].Message.Content}, nil
}
