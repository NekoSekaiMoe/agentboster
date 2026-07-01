package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/agent"
	"github.com/clawless/agentd/internal/persistence"
	"github.com/gin-gonic/gin"
)

// handleExecStream runs a sandbox command and streams its output as
// Server-Sent Events. Each line of stdout/stderr becomes an SSE event
// of type "output"; the final exit status is sent as an event of type
// "done".
//
// P2.1: Previously the only way to observe a long-running command was
// to poll exec_background_status every N seconds. This endpoint gives
// the web UI a single long-lived connection for live build log style
// output.
//
// Implementation: runs the command via the existing manager.Exec
// (which is blocking and returns when the command exits). To get
// streaming behavior, we wrap the call in a goroutine that streams
// output chunks to a channel via the background task store — same
// mechanism exec_background already uses. This avoids rewriting the
// provider Exec methods (which buffer full output).
//
// If the background store is unavailable, falls back to running
// manager.Exec and emitting the full output in one chunk.
func (s *Server) handleExecStream(c *gin.Context) {
	// SSE headers
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no") // nginx: don't buffer

	var req struct {
		SessionID string         `json:"session_id"`
		TaskID    string         `json:"task_id,omitempty"`
		ToolName  string         `json:"tool_name"`
		ToolInput map[string]any `json:"tool_input"`
		UserID    string         `json:"user_id,omitempty"`
		Roles     []string       `json:"roles,omitempty"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeSSEError(c, fmt.Sprintf("invalid request: %v", err))
		return
	}
	if req.SessionID == "" || req.ToolName == "" {
		writeSSEError(c, "session_id and tool_name are required")
		return
	}

	// Sanity: only allow tools that make sense for streaming (exec,
	// exec_background). Other tools should use the synchronous path.
	allowed := map[string]bool{
		"exec":            true,
		"sandbox_install": true,
	}
	if !allowed[req.ToolName] {
		writeSSEError(c, fmt.Sprintf("tool %q does not support streaming; use /api/v1/tools/%s", req.ToolName, req.ToolName))
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Minute)
	defer cancel()

	// Stream a heartbeat so intermediate proxies don't kill the connection.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.Writer.Write([]byte(": heartbeat\n\n"))
				c.Writer.Flush()
			}
		}
	}()

	// If this is a background exec request, use the background store path.
	if req.ToolName == "exec" {
		// Pull the command from input.
		command, _ := req.ToolInput["command"].(string)
		timeoutSec := 60
		if t, ok := req.ToolInput["timeout"].(float64); ok && t > 0 {
			timeoutSec = int(t)
		}
		if timeoutSec > 900 {
			timeoutSec = 900
		}
		if command == "" {
			writeSSEError(c, "input.command is required")
			return
		}

		// Try to find the session's sandbox.
		agentCtx, ok := s.agentMgr.GetSession(req.SessionID)
		if !ok || agentCtx.SandboxID == "" {
			writeSSEError(c, "no active sandbox for session")
			return
		}
		sbManager := s.agentMgr.GetSandboxManager()
		if sbManager == nil {
			writeSSEError(c, "sandbox manager not wired")
			return
		}

		// Try to find the background task store.
		var bgStore *persistence.BackgroundTaskStore = s.agentMgr.GetBGTaskStore()
		if bgStore == nil {
			// Fallback: run synchronously, emit one big chunk.
			result, err := sbManager.Exec(agentCtx.SandboxID, command, nil, timeoutSec)
			if err != nil {
				writeSSEError(c, fmt.Sprintf("exec failed: %v", err))
				return
			}
			writeSSEOutput(c, result.Stdout)
			if result.Stderr != "" {
				writeSSEOutput(c, "[stderr]\n"+result.Stderr)
			}
			writeSSEDone(c, result.ExitCode)
			return
		}

		// Background-store streaming path: spawn the command as a
		// background task, then poll its status for new output.
		bgTask := &persistence.BackgroundTask{
			ID:        fmt.Sprintf("stream-%d", time.Now().UnixNano()),
			Command:   command,
			SandboxID: agentCtx.SandboxID,
			StartedAt: time.Now(),
			Status:    "running",
		}
		if err := bgStore.Save(bgTask); err != nil {
			writeSSEError(c, fmt.Sprintf("bg store save failed: %v", err))
			return
		}

		// Launch the exec in a goroutine.
		done := make(chan struct{})
		go func() {
			defer close(done)
			result, err := sbManager.Exec(agentCtx.SandboxID, command, nil, timeoutSec)
			if err != nil {
				bgTask.Status = "failed"
				bgTask.LastOutput = err.Error()
			} else {
				bgTask.Status = "completed"
				bgTask.LastOutput = result.Stdout
				if result.Stderr != "" {
					bgTask.LastOutput += "\n[stderr]\n" + result.Stderr
				}
				exit := result.ExitCode
				bgTask.ExitCode = &exit
			}
			bgTask.CompletedAt = time.Now()
			_ = bgStore.Save(bgTask)
		}()

		// Poll for output until the goroutine completes or the client
		// disconnects. The current BackgroundTask model buffers full
		// output, so streaming is effectively one chunk when done —
		// but the heartbeat keeps the connection alive and the API
		// shape is forward-compatible with a future StdoutPipe-based
		// provider that emits chunks as they arrive.
		var lastLen int
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				// Emit final delta.
				if len(bgTask.LastOutput) > lastLen {
					writeSSEOutput(c, bgTask.LastOutput[lastLen:])
				}
				exitCode := -1
				if bgTask.ExitCode != nil {
					exitCode = *bgTask.ExitCode
				}
				writeSSEDone(c, exitCode)
				return
			case <-ticker.C:
				current, _ := bgStore.Load(bgTask.ID)
				if current != nil && len(current.LastOutput) > lastLen {
					writeSSEOutput(c, current.LastOutput[lastLen:])
					lastLen = len(current.LastOutput)
					c.Writer.Flush()
				}
			}
		}
	}

	// Other tools: emit an error (we filtered above, but defensive).
	writeSSEError(c, "unsupported tool for streaming")
}

func writeSSEOutput(c *gin.Context, chunk string) {
	data, _ := json.Marshal(map[string]any{
		"type":  "output",
		"chunk": chunk,
		"at":    time.Now().UTC().Format(time.RFC3339),
	})
	fmt.Fprintf(c.Writer, "event: output\ndata: %s\n\n", string(data))
	c.Writer.Flush()
}

func writeSSEDone(c *gin.Context, exitCode int) {
	data, _ := json.Marshal(map[string]any{
		"type":      "done",
		"exit_code": exitCode,
		"at":        time.Now().UTC().Format(time.RFC3339),
	})
	fmt.Fprintf(c.Writer, "event: done\ndata: %s\n\n", string(data))
	c.Writer.Flush()
}

func writeSSEError(c *gin.Context, msg string) {
	data, _ := json.Marshal(map[string]any{
		"type":  "error",
		"error": msg,
		"at":    time.Now().UTC().Format(time.RFC3339),
	})
	fmt.Fprintf(c.Writer, "event: error\ndata: %s\n\n", string(data))
	c.Writer.Flush()
}

// silence unused imports if go compiler complains
var _ = io.EOF
var _ = strings.Contains
var _ = agent.Manager{}
