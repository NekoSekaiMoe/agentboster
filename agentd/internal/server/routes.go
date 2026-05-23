package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/clawless/agentd/internal/cache"
	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
	"github.com/clawless/agentd/internal/eventbus"
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
	startTime  time.Time
}

// NewServer creates a new HTTP server with all dependencies.
func NewServer(
	cfg *config.Config,
	bus *eventbus.Bus,
	dispatcher *worker.Dispatcher,
	clawlessClient *clawless.Client,
	cacheManager *cache.Manager,
) *Server {
	return &Server{
		cfg:        cfg,
		bus:        bus,
		dispatcher: dispatcher,
		clawless:   clawlessClient,
		cache:      cacheManager,
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
	}
}

// handleHealth returns daemon health status.
func (s *Server) handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"status":    "ok",
			"timestamp": time.Now().UTC(),
			"version":   "0.1.0",
			"uptime":    time.Since(s.startTime).String(),
		},
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
	memories, err := s.clawless.GetMemories(c.Request.Context(), agentID, nil, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": memories})
}

// handleWriteMemories writes memories.
func (s *Server) handleWriteMemories(c *gin.Context) {
	var memories []clawless.Memory
	if err := c.ShouldBindJSON(&memories); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if err := s.clawless.WriteMemories(c.Request.Context(), memories); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// handleDeleteMemory deletes a memory.
func (s *Server) handleDeleteMemory(c *gin.Context) {
	id := c.Param("id")
	if err := s.clawless.DeleteMemory(c.Request.Context(), id); err != nil {
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
