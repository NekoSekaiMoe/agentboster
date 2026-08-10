//go:build linux

package server

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/cache"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/config"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/eventbus"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security/l2_auth"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/worker"
	"github.com/gin-gonic/gin"
	"golang.org/x/sync/semaphore"
)

// Server holds all dependencies for HTTP handlers.
type Server struct {
	cfg        *config.Config
	bus        *eventbus.Bus
	dispatcher *worker.Dispatcher
	clawless   *clawless.Client
	cache      *cache.Manager
	agentMgr   *agent.Manager
	l2Mgr      *l2_auth.L2AuthManager
	startTime  time.Time
	version    string

	// requestSem bounds concurrent in-flight /api/v1 requests. nil = disabled.
	requestSem *semaphore.Weighted
}

// NewServer creates a new HTTP server with all dependencies.
func NewServer(
	cfg *config.Config,
	bus *eventbus.Bus,
	dispatcher *worker.Dispatcher,
	clawlessClient *clawless.Client,
	cacheManager *cache.Manager,
	agentMgr *agent.Manager,
	l2Mgr *l2_auth.L2AuthManager,
	version string,
) *Server {
	// M3.2: build the request concurrency semaphore from config. nil when
	// the cap is 0 (legacy unlimited mode).
	var requestSem *semaphore.Weighted
	if cfg.Server.MaxConcurrentRequests > 0 {
		requestSem = semaphore.NewWeighted(int64(cfg.Server.MaxConcurrentRequests))
	}

	return &Server{
		cfg:        cfg,
		bus:        bus,
		dispatcher: dispatcher,
		clawless:   clawlessClient,
		cache:      cacheManager,
		agentMgr:   agentMgr,
		l2Mgr:      l2Mgr,
		startTime:  time.Now(),
		version:    version,
		requestSem: requestSem,
	}
}

// RegisterRoutes registers all API routes on the given gin engine.
//
// Handler bodies live in this file (small / stateless ones) or in
// dedicated handler_*.go files grouped by resource (sessions, memories,
// L2, subagents, checkpoints, advisor, mcp, processes, tunnels, vnc).
// This file is only the wiring table + the few handlers too small to
// justify their own file (health, metrics, tasks, agent-config, L0
// rules, sandboxes, llm-proxy, the tool-exec wrappers).
func (s *Server) RegisterRoutes(r *gin.Engine) {
	// Global middleware
	r.Use(CORSMiddleware())
	r.Use(RequestLogger())

	// Health check (no auth required)
	r.GET("/health", s.handleHealth)

	// Metrics endpoint (no auth required for monitoring)
	r.GET("/metrics", s.handleMetrics)

	// v1 API group (mTLS + API key protected)
	v1 := r.Group("/api/v1")
	v1.Use(MTLSMiddleware())
	v1.Use(APIKeyMiddleware(s.cfg.Server.ClawLessAPIKey))
	// M3.2: bound concurrency + per-request timeout. The cap is sized off the
	// sandbox admission limits — each in-flight /tools/exec owns a goroutine +
	// a child docker/lxc exec process for the duration of the command, so an
	// unbounded flood would exhaust goroutines/fds long before the sandbox
	// caps engage. The timeout caps long-running stragglers (default 10m;
	// stream endpoints override per-route).
	v1.Use(SemaphoreMiddleware(s.requestSem))
	v1.Use(TimeoutMiddleware(s.cfg.Server.RequestTimeout))
	{
		// Tasks
		v1.POST("/tasks", s.handleCreateTask)
		v1.GET("/tasks/:id", s.handleGetTask)
		v1.PUT("/tasks/:id", s.handleUpdateTask)

		// Sessions
		v1.GET("/sessions/:id", s.handleGetSession)
		v1.PUT("/sessions/:id", s.handleUpdateSession)
		v1.DELETE("/sessions/:id", s.handleDeleteSession)

		// Review logs
		v1.POST("/review-logs", s.handleWriteReviewLogs)

		// Memories
		v1.GET("/memories", s.handleGetMemories)
		v1.POST("/memories", s.handleWriteMemories)
		v1.DELETE("/memories/:id", s.handleDeleteMemory)

		// Agent config
		v1.GET("/agent-config/:id", s.handleGetAgentConfig)

		// L0 rules
		v1.GET("/l0-rules/:id", s.handleGetL0Rules)

		// Sandboxes
		v1.POST("/sandboxes", s.handleRegisterSandbox)
		v1.PUT("/sandboxes/:id", s.handleUpdateSandboxStatus)

		// LLM proxy
		v1.POST("/llm-proxy", s.handleLLMProxy)

		// Session management
		v1.GET("/sessions", s.handleListSessions)
		v1.POST("/sessions/switch", s.handleSwitchSession)
		v1.POST("/sessions/close", s.handleCloseSession)

		// L2 authorization confirm (called by ClawLess when user clicks a button)
		v1.POST("/l2-confirm", s.handleL2Confirm)

		// Session runtime control
		v1.GET("/sessions/status", s.handleSessionStatus)
		v1.POST("/sessions/:id/abort", s.handleAbortSession)
		v1.POST("/sessions/:id/destroy", s.handleDestroySession)

		// Desktop VNC proxy (WebSocket tunnel to container's websockify)
		v1.GET("/desktop/vnc", s.handleVNCProxy)

		// Long-lived managed processes (ref_liveagent.md §2.1). Backed by
		// the persistent BackgroundTaskStore via the shared helpers in
		// internal/agent/background.go; /processes/:id/stream is a real
		// SSE tail over the process log (falls back to polling for
		// providers without ExecStream).
		v1.POST("/processes", s.handleStartProcess)
		v1.GET("/processes", s.handleListProcesses)
		v1.GET("/processes/:id", s.handleGetProcess)
		v1.DELETE("/processes/:id", s.handleStopProcess)
		v1.GET("/processes/:id/stream", s.handleProcessStream)

		// Public-URL tunnels to sandbox-internal ports (ref_liveagent.md
		// §2.2). Create / list / delete + the byte relay are all live;
		// tunnels persist across daemon restarts via persistence.TunnelStore,
		// the relay supports N concurrent connections, and an idle reaper
		// garbage-collects abandoned slugs. See tunnels.go for details.
		v1.POST("/tunnels", s.handleCreateTunnel)
		v1.GET("/tunnels", s.handleListTunnels)
		v1.DELETE("/tunnels/:id", s.handleDeleteTunnel)
		v1.GET("/t/:slug/*path", s.handleTunnelProxy)

		// Synchronous tool execution (called by ClawLess web when agentd is primary)
		v1.POST("/tools/exec", s.handleToolExec)
		// P2.1: Streaming exec output via SSE for long-running commands.
		v1.POST("/tools/exec/stream", s.handleExecStream)

		// M1: workspace lock endpoints. Acquire (try-lock) before a run uses
		// the long-lived container; release when the run ends. 409 busy when
		// another run holds the lock.
		v1.POST("/workspaces/:id/lock/acquire", s.handleWorkspaceLockAcquire)
		v1.POST("/workspaces/:id/lock/release", s.handleWorkspaceLockRelease)
		v1.POST("/tools/read", s.handleToolRead)
		v1.POST("/tools/write", s.handleToolWrite)
		v1.POST("/tools/edit", s.handleToolEdit)
		v1.POST("/tools/ls", s.handleToolLs)
		v1.POST("/tools/grep", s.handleToolGrep)
		v1.POST("/tools/glob", s.handleToolGlob)
		v1.POST("/tools/patch", s.handleToolPatch)
		v1.POST("/tools/git", s.handleToolGit)
		v1.POST("/tools/web-fetch", s.handleToolWebFetch)
		v1.POST("/tools/web-search", s.handleToolWebSearch)
		v1.POST("/tools/memory-search", s.handleToolMemorySearch)
		v1.POST("/tools/memory-save", s.handleToolMemorySave)
		v1.POST("/tools/sandbox-install", s.handleToolSandboxInstall)

		// Subagent query & management
		v1.GET("/subagents", s.handleListSubagents)
		v1.GET("/subagents/:id", s.handleGetSubagent)
		v1.GET("/subagents/:id/messages", s.handleGetSubagentMessages)
		v1.POST("/subagents/:id/abort", s.handleAbortSubagent)
		v1.GET("/subagent-batches/:batchId", s.handleGetSubagentBatch)
		v1.POST("/subagent-batches/:batchId/cancel", s.handleCancelSubagentBatch)

		// Advisor (one-shot LLM completion)
		v1.POST("/advisor", s.handleAdvisor)

		// Checkpoints
		v1.POST("/checkpoints", s.handleCreateCheckpoint)
		v1.GET("/checkpoints", s.handleListCheckpoints)
		v1.POST("/checkpoints/:id/restore", s.handleRestoreCheckpoint)

		// MCP server management
		v1.GET("/mcp-servers", s.handleListMCPServers)
		v1.POST("/mcp-servers", s.handleStartMCPServer)
		v1.DELETE("/mcp-servers/:id", s.handleStopMCPServer)
	}
}

// handleHealth returns daemon health status.
//
// P3.1: now includes capacity info (active sandboxes, per-agent counts)
// so the web layer's /api/agentd/v1/nodes/status can show richer state
// without waiting for the next heartbeat tick.
func (s *Server) handleHealth(c *gin.Context) {
	data := gin.H{
		"status":    "ok",
		"timestamp": time.Now().UTC(),
		"version":   s.version,
		"uptime":    time.Since(s.startTime).String(),
	}

	// Capacity snapshot from the agent manager.
	if s.agentMgr != nil {
		stats := s.agentMgr.GetAgentStats()
		perAgent := make(map[string]int)
		for _, st := range stats {
			perAgent[st.AgentID]++
		}
		data["active_sandboxes"] = len(stats)
		data["active_tasks"] = len(stats)
		data["per_agent"] = perAgent
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    data,
	})
}

// handleMetrics returns worker pool metrics.
func (s *Server) handleMetrics(c *gin.Context) {
	metrics := s.dispatcher.Metrics()
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    metrics,
	})
}

// handleCreateTask creates a new task (called by ClawLess).
func (s *Server) handleCreateTask(c *gin.Context) {
	var task clawless.Task
	if err := c.ShouldBindJSON(&task); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	task.Status = clawless.TaskPending
	now := time.Now()
	task.CreatedAt = now
	task.UpdatedAt = now

	// Publish task.created event → dispatcher routes to ReviewWorker
	s.bus.Publish(eventbus.EventTaskCreated, &task)

	slog.Info("task created", "task_id", task.ID, "agent_id", task.AgentID)
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": task})
}

// handleGetTask returns a task (stub — needs DB integration via ClawLess API).
func (s *Server) handleGetTask(c *gin.Context) {
	id := c.Param("id")
	task, err := s.clawless.GetTask(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": task})
}

// handleUpdateTask updates a task.
//
// P0.4: Previously this only logged the update and returned success
// without persisting anywhere, leaving the web layer's task status
// stale. Now proxies through to the ClawLess web API so the DB row
// is updated.
func (s *Server) handleUpdateTask(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Status string `json:"status"`
		Result string `json:"result"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	slog.Info("task updated", "task_id", id, "status", body.Status)

	// Persist to the web layer so the task list reflects the new state.
	if s.clawless != nil && body.Status != "" {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
		defer cancel()
		if err := s.clawless.UpdateTaskStatus(ctx, id, clawless.TaskStatus(body.Status)); err != nil {
			slog.Warn("failed to persist task status update",
				"task_id", id, "status", body.Status, "error", err)
			// Continue — the local dispatch has already happened.
		}
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleGetAgentConfig returns agent configuration.
func (s *Server) handleGetAgentConfig(c *gin.Context) {
	id := c.Param("id")
	cfg, err := s.clawless.GetAgentConfig(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": cfg})
}

// handleGetL0Rules returns L0 rules.
func (s *Server) handleGetL0Rules(c *gin.Context) {
	id := c.Param("id")
	rules, err := s.clawless.GetL0Rules(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": rules})
}

// handleRegisterSandbox registers a sandbox.
func (s *Server) handleRegisterSandbox(c *gin.Context) {
	var sb clawless.SandboxMeta
	if err := c.ShouldBindJSON(&sb); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if err := s.clawless.RegisterSandbox(c.Request.Context(), &sb); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": sb})
}

// handleUpdateSandboxStatus updates sandbox status.
func (s *Server) handleUpdateSandboxStatus(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if err := s.clawless.UpdateSandboxStatus(c.Request.Context(), id, body.Status); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleLLMProxy proxies LLM requests to ClawLess.
func (s *Server) handleLLMProxy(c *gin.Context) {
	var req clawless.LLMProxyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// If streaming, set SSE headers
	if req.Stream {
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
	}

	data, err := s.clawless.LLMProxyRequest(c.Request.Context(), &req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.Data(http.StatusOK, "application/json", data)
}

// ── Synchronous Tool Execution ──────────────────────────────────────

func (s *Server) handleToolExec(c *gin.Context) {
	var req agent.ToolExecRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	result, err := s.agentMgr.ExecuteTool(c.Request.Context(), req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}

// handleWorkspaceLockAcquire attempts a workspace run lock.
//
// Body: { exec_session_id, holder_type, owner_task_id?, ttl_seconds, node_generation }
// 200 { success:true, data: <state> } — lock acquired
// 409 { success:false, error:"busy", holder: <state> } — held by another run
// 400 on missing/invalid fields.
//
// The lock lives in agentd memory; Web workspaces.node_generation is the
// fencing token. A stale node (post-failover) that receives an acquire
// with a higher generation than the one it stamped on the lock will see
// the lock as already-released via TTL expiry / the gen check in ExecuteTool
// (M1.3 hooks that up).
func (s *Server) handleWorkspaceLockAcquire(c *gin.Context) {
	workspaceID := c.Param("id")
	if workspaceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "missing workspace id"})
		return
	}
	var body struct {
		ExecSessionID  string `json:"exec_session_id"`
		HolderType     string `json:"holder_type"`
		OwnerTaskID    string `json:"owner_task_id,omitempty"`
		TTLSeconds     int    `json:"ttl_seconds"`
		NodeGeneration uint64 `json:"node_generation"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if body.ExecSessionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "exec_session_id is required"})
		return
	}
	if body.HolderType == "" {
		body.HolderType = "chat_run"
	}
	ttl := time.Duration(body.TTLSeconds) * time.Second
	if ttl <= 0 {
		// Default 30min matches a workflow run ctx cap; caller may override.
		ttl = 30 * time.Minute
	}
	state, ok := s.agentMgr.AcquireWorkspaceLock(
		workspaceID, body.HolderType, body.ExecSessionID, body.OwnerTaskID, ttl, body.NodeGeneration,
	)
	if !ok {
		c.JSON(http.StatusConflict, gin.H{
			"success": false,
			"error":   "busy",
			"data":    gin.H{"holder": state},
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": state})
}

// handleWorkspaceLockRelease frees a workspace run lock. Body:
//   { exec_session_id }
// Returns 200 { success:true, data: { released: bool } }. A mismatched
// exec_session_id releases nothing (data.released:false) so one run can't
// drop another's lock — the caller treats released:false as best-effort
// non-fatal.
func (s *Server) handleWorkspaceLockRelease(c *gin.Context) {
	workspaceID := c.Param("id")
	if workspaceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "missing workspace id"})
		return
	}
	var body struct {
		ExecSessionID string `json:"exec_session_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	released := s.agentMgr.ReleaseWorkspaceLock(workspaceID, body.ExecSessionID)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"released": released}})
}

func (s *Server) handleToolRead(c *gin.Context)           { s.handleToolExec(c) }
func (s *Server) handleToolWrite(c *gin.Context)          { s.handleToolExec(c) }
func (s *Server) handleToolEdit(c *gin.Context)           { s.handleToolExec(c) }
func (s *Server) handleToolLs(c *gin.Context)             { s.handleToolExec(c) }
func (s *Server) handleToolGrep(c *gin.Context)           { s.handleToolExec(c) }
func (s *Server) handleToolGlob(c *gin.Context)           { s.handleToolExec(c) }
func (s *Server) handleToolPatch(c *gin.Context)          { s.handleToolExec(c) }
func (s *Server) handleToolGit(c *gin.Context)            { s.handleToolExec(c) }
func (s *Server) handleToolWebFetch(c *gin.Context)       { s.handleToolExec(c) }
func (s *Server) handleToolWebSearch(c *gin.Context)      { s.handleToolExec(c) }
func (s *Server) handleToolMemorySearch(c *gin.Context)   { s.handleToolExec(c) }
func (s *Server) handleToolMemorySave(c *gin.Context)     { s.handleToolExec(c) }
func (s *Server) handleToolSandboxInstall(c *gin.Context) { s.handleToolExec(c) }
