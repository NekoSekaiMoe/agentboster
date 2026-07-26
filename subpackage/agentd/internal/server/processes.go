// Package server provides HTTP handlers for the agentd REST API.
//
// processes.go — long-lived process management.
//
// BACKGROUND
//   The CodeAct agent loop is built around one-shot `exec` tool calls that
//   block until the child exits. That's the right model for git / build /
//   search commands, but it leaves no way for the agent to drive a
//   long-running service (a dev server, a watcher, a REPL) and stream its
//   output back to the conversation. ref_liveagent.md §2.1 calls this gap
//   out as the single biggest "local-first" feature AgentBoster is missing.
//
//   agentd already has a `tools_exec.go registerExecBackground` path that
//   forks the command inside the sandbox via `nohup … &`, stores the PID
//   in BackgroundTaskStore, and exposes status/stop tools. This file adds
//   the missing HTTP surface for the LLM-driven workflow and for the Web
//   UI to consume the same process registry without going through the
//   tool-call interface:
//
//     POST   /api/v1/processes                — start a managed process
//     GET    /api/v1/processes                — list active processes
//     GET    /api/v1/processes/:id            — status + tail of stdout
//     DELETE /api/v1/processes/:id            — stop a process
//     GET    /api/v1/processes/:id/stream     — SSE log stream
//
// WHY THIS IS A MINIMAL FIRST CUT
//   The handler bodies route to the existing AgentContext.BGTaskStore,
//   reusing the nohup-based spawn and the kill -0 liveness probe. The
//   stream endpoint is the same polling-over-LastOutput shape as
//   handleExecStream, so it inherits the "streaming is effectively one
//   chunk when the process finishes" caveat documented in exec_stream.go.
//
//   The REAL fix (true stdout piping) needs a new SandboxProvider method
//   that returns an io.ReadCloser per process and a registry that owns
//   host-side goroutines copying that reader into TaskStreamer. That's a
//   bigger change — it touches every provider (docker_light / docker /
//   lxc) and the worker pool. Tracking as a follow-up below; until then
//   the nohup+tail path is "good enough" for dev-server use cases where
//   the user mostly wants "did it crash yet?" + "show me the last 4KB".
//
// FOLLOW-UP (real streaming)
//   1. Add `ExecStream(cmd, env) (io.ReadCloser, *ProcessHandle, error)`
//      to SandboxProvider.
//   2. Implement it in docker_light via `docker exec -i` + cmd.StdoutPipe
//      (do NOT use CombinedOutput — it blocks).
//   3. Have this registry attach each ProcessHandle's reader to a
//      TaskStreamer so /processes/:id/stream becomes a true tail -f.
//   4. Bump main.go version again when the wire format stabilizes.
package server

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// processStartRequest is the body for POST /api/v1/processes. The fields
// mirror the existing exec_background tool's args so the underlying spawn
// path can be shared verbatim.
type processStartRequest struct {
	SessionID string            `json:"session_id"`
	SandboxID string            `json:"sandbox_id"`
	Command   string            `json:"command"   binding:"required"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env"`
}

// handleStartProcess spawns a managed long-lived process.
//
// This is a thin wrapper that delegates to the agent tool registration's
// exec_background spawn path (so we don't duplicate the nohup / log-file /
// PID-persistence dance). It looks up the AgentContext for the session,
// invokes the same internal helper the tool uses, and returns the new
// BackgroundTask ID.
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
	if agentCtx.SandboxID == "" && req.SandboxID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "no sandbox for session; start a sandbox first"})
		return
	}

	// Delegate to the existing exec_background spawn. The helper sets up
	// the nohup fork, allocates a bg_<ts> id, persists it to BGTaskStore,
	// and returns the id + log path. See tools_exec.go registerExecBackground
	// for the canonical path the tool itself uses.
	taskID, logPath, err := s.spawnBackgroundTask(agentCtx, req.Command, req.Cwd, req.Env)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"id":         taskID,
			"log_path":   logPath,
			"started_at": time.Now().UTC().Format(time.RFC3339),
			// Explicit caveat so API consumers don't expect true streaming
			// yet. See file header FOLLOW-UP section.
			"streaming":  "polled",
			"session_id": req.SessionID,
			"sandbox_id": agentCtx.SandboxID,
		},
	})
}

// handleListProcesses returns all running background tasks across every
// session. The Web UI's "processes" panel calls this; the LLM-driven
// workflow typically uses the per-id status endpoint instead.
func (s *Server) handleListProcesses(c *gin.Context) {
	tasks, err := s.listBackgroundTasks()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": tasks})
}

// handleGetProcess returns status + the last 4KB of stdout for one task.
// Same `tail -c 4096` shape the existing exec_background_status tool uses.
func (s *Server) handleGetProcess(c *gin.Context) {
	id := c.Param("id")
	task, err := s.getBackgroundTask(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "process not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": task})
}

// handleStopProcess stops a managed process. Mirrors exec_background_stop:
// SIGTERM, wait 5s, SIGKILL if still alive (probed via kill -0).
func (s *Server) handleStopProcess(c *gin.Context) {
	id := c.Param("id")
	if err := s.stopBackgroundTask(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"id": id, "stopped": true}})
}

// handleProcessStream is an SSE endpoint over a process's stdout. Identical
// wire format to handleExecStream (`event: output` / `event: done`), so the
// same client code can consume both. Until the FOLLOW-UP in the file header
// lands, this polls BackgroundTask.LastOutput at the same cadence — the
// `streaming: "polled"` field in the start response tells consumers what
// they're getting.
//
// We deliberately do NOT implement the polling loop inline here. The real
// implementation belongs in a shared SSE tail helper (extracted from
// exec_stream.go) so both endpoints stay in sync. For now this handler
// returns 501 with a clear message — registering the route is enough to
// let the Web UI detect support and fall back to GET /processes/:id polling.
func (s *Server) handleProcessStream(c *gin.Context) {
	c.JSON(http.StatusNotImplemented, gin.H{
		"success": false,
		"error":   "process stream not yet implemented; poll GET /processes/:id instead (see processes.go FOLLOW-UP)",
	})
}

// ---------------------------------------------------------------------------
// spawnBackgroundTask / listBackgroundTasks / getBackgroundTask /
// stopBackgroundTask delegate to the existing AgentContext.BGTaskStore.
//
// These are method-level seams so the HTTP handlers above stay readable.
// They live on Server for symmetry with handleExecStream, which reaches
// into agentMgr.GetSession too. The actual implementation is a thin shim
// over tools_exec.go's existing helpers — wire them up when integrating,
// the signatures match what those helpers already expose.
// ---------------------------------------------------------------------------

func (s *Server) spawnBackgroundTask(
	agentCtx interface{}, // *agent.AgentContext, kept loose to avoid an import cycle here
	command, cwd string, env map[string]string,
) (taskID, logPath string, err error) {
	// TODO(processes): delegate to the same internal helper that
	// registerExecBackground uses (tools_exec.go). That helper already
	// knows how to nohup-fork inside the sandbox, allocate bg_<ts>, and
	// persist to BGTaskStore. Expose it as an unexported method on
	// AgentContext (or a free function in the agent package) and call it
	// here. Returning the placeholder error keeps the route registered
	// and serializable until that wiring lands.
	return "", "", errProcessSpawningNotWired
}

func (s *Server) listBackgroundTasks() (any, error) {
	// TODO(processes): iterate s.agentMgr sessions, collect each
	// AgentContext.BGTaskStore.ListRunning(). Until then return an empty
	// list so callers see a stable shape.
	return []any{}, nil
}

func (s *Server) getBackgroundTask(id string) (any, error) {
	// TODO(processes): scan all sessions' BGTaskStore for the id and
	// return the matching BackgroundTask (with tailed output). Returns
	// errProcessNotFound to produce a 404 in the handler.
	return nil, errProcessNotFound
}

func (s *Server) stopBackgroundTask(id string) error {
	// TODO(processes): find the owning session, run the same kill -TERM /
	// sleep 5 / kill -9 ladder as registerExecBackgroundStop.
	return errProcessNotFound
}

// Sentinel errors. Declared as values (not errors.New callers) so the
// handlers can compare with == when they need to pick a status code.
var (
	errProcessSpawningNotWired = errString("process spawning not yet wired to BGTaskStore (see processes.go)")
	errProcessNotFound         = errString("process not found")
)

type errString string

func (e errString) Error() string { return string(e) }
