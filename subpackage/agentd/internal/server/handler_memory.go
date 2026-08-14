//go:build linux

// Package server — handler_memory.go
//
// Memory + review-log handlers split out of routes.go. These proxy to the
// clawless web API (the central DB is the source of truth for memories
// and review logs; agentd only forwards). Pure extraction — no behavior
// change.
//
// Routes (registered in routes.go RegisterRoutes):
//
//	GET   /memories         — handleGetMemories
//	POST  /memories         — handleWriteMemories
//	DELETE /memories/:id    — handleDeleteMemory
//	POST  /review-logs      — handleWriteReviewLogs
package server

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/gin-gonic/gin"
)

// handleWriteReviewLogs writes security review logs.
func (s *Server) handleWriteReviewLogs(c *gin.Context) {
	var logs []clawless.ReviewLog
	if err := c.ShouldBindJSON(&logs); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	for _, log := range logs {
		if log.RunID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "run_id is required for review logs"})
			return
		}
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
