package server

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/agent"
	"github.com/clawless/agentd/internal/cache"
	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/security/l2_auth"
	"github.com/clawless/agentd/internal/worker"
	"github.com/gin-gonic/gin"
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
) *Server {
	return &Server{
		cfg:        cfg,
		bus:        bus,
		dispatcher: dispatcher,
		clawless:   clawlessClient,
		cache:      cacheManager,
		agentMgr:   agentMgr,
		l2Mgr:      l2Mgr,
		startTime:  time.Now(),
	}
}

// RegisterRoutes registers all API routes on the given gin engine.
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
		v1.DELETE("/sessions/:id", s.handleDestroySession)

		// L2 authorization confirm (called by ClawLess when user clicks a button)
		v1.POST("/l2-confirm", s.handleL2Confirm)

		// Session runtime control
		v1.GET("/sessions/status", s.handleSessionStatus)
		v1.POST("/sessions/:id/abort", s.handleAbortSession)

		// Synchronous tool execution (called by ClawLess web when agentd is primary)
		v1.POST("/tools/exec", s.handleToolExec)
		// P2.1: Streaming exec output via SSE for long-running commands.
		v1.POST("/tools/exec/stream", s.handleExecStream)
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
		"version":   "0.1.0",
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

// handleGetSession returns a session.
func (s *Server) handleGetSession(c *gin.Context) {
	id := c.Param("id")
	session, err := s.clawless.GetSession(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": session})
}

// handleUpdateSession updates a session.
func (s *Server) handleUpdateSession(c *gin.Context) {
	var session clawless.Session
	if err := c.ShouldBindJSON(&session); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if err := s.clawless.UpdateSession(c.Request.Context(), &session); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleDeleteSession deletes a session.
func (s *Server) handleDeleteSession(c *gin.Context) {
	id := c.Param("id")
	if err := s.clawless.DeleteSession(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleWriteReviewLogs writes security review logs.
func (s *Server) handleWriteReviewLogs(c *gin.Context) {
	var logs []clawless.ReviewLog
	if err := c.ShouldBindJSON(&logs); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if err := s.clawless.WriteReviewLogs(c.Request.Context(), logs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleGetMemories searches memories.
func (s *Server) handleGetMemories(c *gin.Context) {
	agentID := c.Query("agent_id")
	limit := 10
	if rawLimit := c.Query("limit"); rawLimit != "" {
		if parsed, err := strconv.Atoi(rawLimit); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	var keywords []string
	if rawKeywords := c.Query("keywords"); rawKeywords != "" {
		for _, keyword := range strings.Split(rawKeywords, ",") {
			if trimmed := strings.TrimSpace(keyword); trimmed != "" {
				keywords = append(keywords, trimmed)
			}
		}
	}
	memories, err := s.clawless.GetMemories(c.Request.Context(), agentID, keywords, limit, clawless.MemoryScope{
		TaskID:    c.Query("task_id"),
		SessionID: c.Query("session_id"),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": memories})
}

// handleWriteMemories writes memories.
func (s *Server) handleWriteMemories(c *gin.Context) {
	var body struct {
		TaskID    string            `json:"task_id"`
		SessionID string            `json:"session_id"`
		Memories  []clawless.Memory `json:"memories"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if len(body.Memories) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "memories cannot be empty"})
		return
	}
	if err := s.clawless.WriteMemories(c.Request.Context(), body.Memories, clawless.MemoryScope{
		TaskID:    body.TaskID,
		SessionID: body.SessionID,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleDeleteMemory deletes a memory.
func (s *Server) handleDeleteMemory(c *gin.Context) {
	id := c.Param("id")
	if err := s.clawless.DeleteMemory(c.Request.Context(), id, clawless.MemoryScope{
		TaskID:    c.Query("task_id"),
		SessionID: c.Query("session_id"),
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
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

// ── Session Management ──────────────────────────────────────────────

func (s *Server) handleListSessions(c *gin.Context) {
	store := s.agentMgr.GetSessionStore()
	sessions := store.List(5)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": sessions})
}

func (s *Server) handleSwitchSession(c *gin.Context) {
	var body struct {
		CurrentSessionID string `json:"current_session_id"`
		NewSessionID     string `json:"new_session_id"`
		AgentID          string `json:"agent_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	ctx, err := s.agentMgr.SwitchSession(body.CurrentSessionID, body.NewSessionID, body.AgentID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	s.l2Mgr.SetSession(body.NewSessionID)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"session_id": ctx.SessionID,
			"agent_id":   ctx.AgentID,
		},
	})
}

func (s *Server) handleCloseSession(c *gin.Context) {
	var body struct {
		SessionID string `json:"session_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	if err := s.agentMgr.CloseSession(body.SessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

func (s *Server) handleDestroySession(c *gin.Context) {
	sessionID := c.Param("id")

	if err := s.agentMgr.DestroySession(sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// ── L2 Authorization Confirm ────────────────────────────────────────

func (s *Server) handleL2Confirm(c *gin.Context) {
	var body struct {
		TaskID     string `json:"task_id"`
		DecisionID string `json:"decision_id"`
		Action     string `json:"action"` // pass_once | pass_until | reject_once | reject_until
		Pattern    string `json:"pattern"`
		Duration   string `json:"duration"` // once | always | hhddmmyy
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	switch body.Action {
	case "pass_once":
		slog.Info("L2 pass_once", "task_id", body.TaskID, "pattern", body.Pattern)
		s.bus.Publish(eventbus.EventL2AuthApproved, map[string]any{
			"task_id":  body.TaskID,
			"command":  body.Pattern,
			"action":   "pass",
			"duration": "once",
		})
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data":    gin.H{"message": "✅ 已放行。任务继续执行。"},
		})

	case "reject_once":
		slog.Info("L2 reject_once", "task_id", body.TaskID, "pattern", body.Pattern)
		s.bus.Publish(eventbus.EventL2AuthRejected, map[string]any{
			"task_id":  body.TaskID,
			"command":  body.Pattern,
			"action":   "reject",
			"duration": "once",
		})
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data":    gin.H{"message": "❌ 已拒绝。任务已取消。"},
		})

	case "pass_until":
		duration := body.Duration
		if duration == "" {
			duration = "always"
		}
		slog.Info("L2 pass_until", "task_id", body.TaskID, "pattern", body.Pattern, "duration", duration)
		s.bus.Publish(eventbus.EventL2AuthApproved, map[string]any{
			"task_id":  body.TaskID,
			"command":  body.Pattern,
			"action":   "pass",
			"duration": duration,
		})
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data":    gin.H{"message": "✅ 已放行至指定时间。"},
		})

	case "reject_until":
		duration := body.Duration
		if duration == "" {
			duration = "always"
		}
		slog.Info("L2 reject_until", "task_id", body.TaskID, "pattern", body.Pattern, "duration", duration)
		s.bus.Publish(eventbus.EventL2AuthRejected, map[string]any{
			"task_id":  body.TaskID,
			"command":  body.Pattern,
			"action":   "reject",
			"duration": duration,
		})
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data":    gin.H{"message": "🔕 已拒绝至指定时间。"},
		})

	default:
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"error":   "Unknown action: " + body.Action,
		})
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

// ── Session Runtime Control ──────────────────────────────────────────

func (s *Server) handleSessionStatus(c *gin.Context) {
	sessionID := c.Query("session_id")

	if sessionID != "" {
		status, ok := s.agentMgr.GetSessionStatus(sessionID)
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "session not found"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true, "data": status})
		return
	}

	statuses := s.agentMgr.GetAllSessionStatuses()
	c.JSON(http.StatusOK, gin.H{"success": true, "data": statuses})
}

func (s *Server) handleAbortSession(c *gin.Context) {
	sessionID := c.Param("id")

	ok := s.agentMgr.AbortSession(sessionID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "session not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
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
