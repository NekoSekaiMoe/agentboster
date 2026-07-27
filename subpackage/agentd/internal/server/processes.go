//go:build linux

// Package server provides HTTP handlers for the agentd REST API.
//
// processes.go — long-lived process management.
//
// This is the HTTP twin of the CodeAct exec_background tool. Both drive
// the same BackgroundTaskStore via the shared helpers in
// internal/agent/background.go, so a process started from the tool is
// visible to /processes (and vice versa).
//
// Routes:
//
//	POST   /api/v1/processes             — spawn a managed process
//	GET    /api/v1/processes             — list active processes
//	GET    /api/v1/processes/:id         — status + last 4KB of stdout
//	DELETE /api/v1/processes/:id         — stop (TERM, 5s, KILL)
//	GET    /api/v1/processes/:id/stream  — SSE log stream (TODO)
//
// STREAM CAVEAT
//
// The stream endpoint uses SandboxProvider.ExecStream (stream.go) to run
// `tail -F` on the process log file. The stream is real-time, not
// polled. Older minimal providers that return errExecStreamUnsupported
// fall back to a 2s polling loop over StatusBackground — same wire
// format, so clients don't need to detect which path served them.
package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
	"github.com/gin-gonic/gin"
)

// processStartRequest is the body for POST /api/v1/processes. Mirrors the
// exec_background tool's args (sandboxID falls back to the session's).
type processStartRequest struct {
	SessionID string `json:"session_id" binding:"required"`
	SandboxID string `json:"sandbox_id"`
	Command   string `json:"command"   binding:"required"`
}

// handleStartProcess spawns a managed long-lived process.
//
// Delegates to agent.SpawnBackground so the spawn path is shared with the
// exec_background tool. The sandbox comes from the session when the
// request omits sandbox_id (the common case — callers know the session,
// not the sandbox).
func (s *Server) handleStartProcess(c *gin.Context) {
	var req processStartRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	agentCtx, ok := s.agentMgr.GetSession(req.SessionID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "session not found"})
		return
	}

	sbMgr := s.agentMgr.GetSandboxManager()
	if sbMgr == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "sandbox manager unavailable"})
		return
	}

	sandboxID := req.SandboxID
	if sandboxID == "" {
		sandboxID = agentCtx.SandboxID
	}
	if sandboxID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "no sandbox for session; start a sandbox first"})
		return
	}

	result, err := agent.SpawnBackground(sbMgr, agentCtx.BGTaskStore, req.SessionID, sandboxID, req.Command)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"id":         result.Task.ID,
			"pid":        result.Task.PID,
			"log_path":   result.LogPath,
			"session_id": result.Task.SessionID,
			"sandbox_id": result.Task.SandboxID,
			"command":    result.Task.Command,
			"started_at": result.Task.StartedAt.UTC().Format(time.RFC3339),
			// Real-time log stream is available at /processes/:id/stream
			// (SSE over `tail -F`, with a polling fallback). We surface the
			// path so clients know the streaming endpoint without hardcoding;
			// older clients that polled still work, but this is the preferred
			// live-output channel. See handleProcessStream.
			"streaming": "/api/v1/processes/" + result.Task.ID + "/stream",
		},
	})
}

// processListEntry is one row in the GET /processes response. It is the
// BackgroundTask shape plus a transient alive flag from the latest probe.
type processListEntry struct {
	ID         string    `json:"id"`
	SessionID  string    `json:"session_id"`
	SandboxID  string    `json:"sandbox_id"`
	Command    string    `json:"command"`
	PID        int       `json:"pid"`
	Status     string    `json:"status"`
	StartedAt  time.Time `json:"started_at"`
	Alive      bool      `json:"alive"`
	LastOutput string    `json:"last_output"`
}

// handleListProcesses returns every running background task across all
// sessions, each annotated with a fresh liveness probe + log tail. This
// is heavier than a pure store dump (one sandbox exec per task), so UI
// clients should poll at multi-second cadences, not on every render.
func (s *Server) handleListProcesses(c *gin.Context) {
	store := s.agentMgr.GetBGTaskStore()
	if store == nil {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": []processListEntry{}})
		return
	}

	sbMgr := s.agentMgr.GetSandboxManager()
	tasks := store.ListRunning()
	out := make([]processListEntry, 0, len(tasks))
	for _, t := range tasks {
		entry := processListEntry{
			ID: t.ID, SessionID: t.SessionID, SandboxID: t.SandboxID,
			Command: t.Command, PID: t.PID, Status: t.Status,
			StartedAt: t.StartedAt,
		}
		if sbMgr != nil {
			if status, ok := agent.StatusBackground(sbMgr, store, t.ID); ok && status != nil {
				entry.Alive = status.Alive
				entry.LastOutput = status.LastOutput
				entry.Status = status.Task.Status
			}
		}
		out = append(out, entry)
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": out})
}

// handleGetProcess returns status + the last 4KB of stdout for one task.
// Resolves the task's owning session transparently, so callers only need
// the task id (not the session id).
func (s *Server) handleGetProcess(c *gin.Context) {
	id := c.Param("id")
	store := s.agentMgr.GetBGTaskStore()
	if store == nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "process not found"})
		return
	}
	sbMgr := s.agentMgr.GetSandboxManager()
	status, ok := agent.StatusBackground(sbMgr, store, id)
	if !ok || status == nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "process not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"id":          status.Task.ID,
			"session_id":  status.Task.SessionID,
			"sandbox_id":  status.Task.SandboxID,
			"command":     status.Task.Command,
			"pid":         status.Task.PID,
			"status":      status.Task.Status,
			"alive":       status.Alive,
			"started_at":  status.Task.StartedAt.UTC().Format(time.RFC3339),
			"last_output": status.LastOutput,
		},
	})
}

// handleStopProcess stops a managed process via the shared StopBackground
// helper (TERM now → KILL after a grace window, escalated in the
// background). Idempotent for already-stopped tasks.
//
// StopBackground returns (stopped, found). We distinguish:
//   - !found           → 404 (truly unknown id)
//   - found && !stopped → 409 Conflict (id is valid but we can't stop it
//                         right now: no sandbox mgr / no PID). Returning
//                         404 here would hide a real failure from the
//                         caller; 409 signals "the resource exists, the
//                         request is unfulfillable in this state".
func (s *Server) handleStopProcess(c *gin.Context) {
	id := c.Param("id")
	store := s.agentMgr.GetBGTaskStore()
	if store == nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "process not found"})
		return
	}
	sbMgr := s.agentMgr.GetSandboxManager()
	stopped, found := agent.StopBackground(sbMgr, store, id)
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "process not found"})
		return
	}
	if !stopped {
		c.JSON(http.StatusConflict, gin.H{
			"success": false,
			"error":   "process exists but could not be stopped (no sandbox or PID)",
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"id": id, "stopped": true}})
}

// handleProcessStream is an SSE endpoint over a process's stdout. Uses
// the new SandboxProvider.ExecStream (stream.go) to tail the process's
// log file in real time — no polling. The relay ends when the client
// disconnects, the underlying `tail -F` exits (e.g. log file is
// rotated away), or the sandbox manager rejects the request.
//
// If the provider returns IsExecStreamUnsupported, we fall back to a
// 15s polling loop over StatusBackground so older / minimal providers
// still get a useful (if chunkier) stream.
func (s *Server) handleProcessStream(c *gin.Context) {
	id := c.Param("id")
	store := s.agentMgr.GetBGTaskStore()
	if store == nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "process not found"})
		return
	}
	task, ok := store.Load(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "process not found"})
		return
	}

	sbMgr := s.agentMgr.GetSandboxManager()
	if sbMgr == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "sandbox manager unavailable"})
		return
	}

	// SSE headers, matching handleExecStream.
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no") // nginx: don't buffer

	// Bound the whole stream so a forgotten client tab doesn't keep the
	// tail running forever. 15 minutes matches handleExecStream's ceiling.
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Minute)
	defer cancel()

	// Heartbeat so intermediate proxies don't kill the idle connection.
	// `: heartbeat` is an SSE comment — clients ignore it, but the bytes
	// keep the TCP connection from looking dead.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_, _ = c.Writer.Write([]byte(": heartbeat\n\n"))
				c.Writer.Flush()
			}
		}
	}()

	// `tail -F` (capital F) follows the file by name and re-opens it if
	// it's rotated — robust against the log file being moved/truncated.
	// We also print the last 100 lines up front so a fresh SSE consumer
	// sees context, not just bytes from now on.
	tailCmd := fmt.Sprintf("tail -n 100 -F %q 2>/dev/null", task.LogPath)
	handle, err := sbMgr.ExecStream(task.SandboxID, tailCmd, nil)
	if err != nil {
		if sandbox.IsExecStreamUnsupported(err) {
			s.streamProcessByPolling(c, ctx, store, id)
			return
		}
		writeSSEError(c, fmt.Sprintf("stream open failed: %v", err))
		return
	}
	defer handle.Close()

	// Pump bytes from the pipe into SSE `event: output` frames. 4KB is a
	// sane chunk — large enough not to frame every byte separately, small
	// enough that interactive output feels live.
	buf := make([]byte, 4096)
	flusher, _ := c.Writer.(http.Flusher)
	for {
		n, readErr := handle.Stdout.Read(buf)
		if n > 0 {
			encoded := encodeSSEData(buf[:n])
			_, _ = fmt.Fprintf(c.Writer, "event: output\ndata: %s\n\n", encoded)
			if flusher != nil {
				flusher.Flush()
			} else {
				c.Writer.Flush()
			}
		}
		if readErr != nil {
			break
		}
		select {
		case <-ctx.Done():
			break
		default:
		}
	}

	_, _ = c.Writer.Write([]byte("event: done\ndata: {\"type\":\"done\"}\n\n"))
	c.Writer.Flush()
}

// streamProcessByPolling is the fallback when the provider doesn't
// implement ExecStream (none of the built-ins today, but reserved).
// Same SSE wire format as the streaming path — clients don't need to
// know which path served them.
func (s *Server) streamProcessByPolling(
	c *gin.Context,
	ctx context.Context,
	store *agent.BackgroundTaskStoreAlias,
	id string,
) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	var lastOutput string
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sbMgr := s.agentMgr.GetSandboxManager()
			status, ok := agent.StatusBackground(sbMgr, store, id)
			if !ok || status == nil {
				_, _ = c.Writer.Write([]byte("event: done\ndata: {\"type\":\"gone\"}\n\n"))
				c.Writer.Flush()
				return
			}
			if status.LastOutput != lastOutput {
				lastOutput = status.LastOutput
				encoded := encodeSSEData([]byte(lastOutput))
				_, _ = fmt.Fprintf(c.Writer, "event: output\ndata: %s\n\n", encoded)
				c.Writer.Flush()
			}
			if status.Task.Status != "running" {
				_, _ = c.Writer.Write([]byte("event: done\ndata: {\"type\":\"done\"}\n\n"))
				c.Writer.Flush()
				return
			}
		}
	}
}

// encodeSSEData wraps a byte slice as a single SSE data line. SSE spec
// requires newlines in the data to be encoded as separate `data:` lines;
// since tail output contains raw newlines, we split on them and emit one
// data line each. The frame is still terminated by a blank line.
func encodeSSEData(b []byte) string {
	// Trim a single trailing newline so we don't emit an empty final line.
	text := strings.TrimSuffix(string(b), "\n")
	lines := strings.Split(text, "\n")
	return strings.Join(lines, "\ndata: ")
}

// errProcessNotFound is kept for callers that want a sentinel to compare
// against (none in this file today, but surfaced for future handlers).
var errProcessNotFound = errors.New("process not found")
