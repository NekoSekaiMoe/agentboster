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
// The stream endpoint currently returns 501. The underlying
// BackgroundTask model buffers the full output to a log file and the
// status helper tails the last 4KB, so true `tail -f` needs either:
//   - an offset-aware tail helper that tracks per-client read positions
//     against BackgroundTask.OutputBytes, or
//   - a real stdout pipe via a new SandboxProvider.ExecStream method.
//
// Until then, clients poll GET /processes/:id. The wire format of that
// response is stable, so adding the stream later won't break consumers.
package server

import (
	"errors"
	"net/http"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent"
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
			// The response surfaces "polled" so clients know to poll until
			// the SSE stream endpoint is implemented (see file header).
			"streaming": "polled",
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
// helper (TERM → 5s → KILL ladder). Idempotent.
func (s *Server) handleStopProcess(c *gin.Context) {
	id := c.Param("id")
	store := s.agentMgr.GetBGTaskStore()
	if store == nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "process not found"})
		return
	}
	sbMgr := s.agentMgr.GetSandboxManager()
	ok, _ := agent.StopBackground(sbMgr, store, id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "process not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"id": id, "stopped": true}})
}

// handleProcessStream is an SSE endpoint over a process's stdout. See the
// file-header STREAM CAVEAT for why this returns 501 — the polling
// contract from GET /processes/:id is the supported path today.
func (s *Server) handleProcessStream(c *gin.Context) {
	c.JSON(http.StatusNotImplemented, gin.H{
		"success": false,
		"error":   "process stream not yet implemented; poll GET /processes/:id (see processes.go STREAM CAVEAT)",
	})
}

// errProcessNotFound is kept for callers that want a sentinel to compare
// against (none in this file today, but surfaced for future handlers).
var errProcessNotFound = errors.New("process not found")
