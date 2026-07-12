//go:build linux

package server

import (
	"net/http"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent"
	"github.com/gin-gonic/gin"
)

// handleCreateCheckpoint creates a git-based checkpoint in the sandbox.
//
//	POST /api/v1/checkpoints
func (s *Server) handleCreateCheckpoint(c *gin.Context) {
	var req struct {
		SessionID   string `json:"session_id"`
		SandboxPath string `json:"sandbox_path"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	cp, err := agent.CreateCheckpoint(req.SandboxPath, req.SessionID, req.Description)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": cp})
}

// handleListCheckpoints lists checkpoints for a session.
//
//	GET /api/v1/checkpoints
func (s *Server) handleListCheckpoints(c *gin.Context) {
	sessionID := c.Query("session_id")
	sandboxPath := c.Query("sandbox_path")

	checkpoints, err := agent.ListCheckpoints(sandboxPath, sessionID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": checkpoints})
}

// handleRestoreCheckpoint restores files to a checkpoint.
//
//	POST /api/v1/checkpoints/:id/restore
func (s *Server) handleRestoreCheckpoint(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "checkpoint id required"})
		return
	}

	var req struct {
		SandboxPath string `json:"sandbox_path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	if err := agent.RestoreCheckpoint(req.SandboxPath, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": "checkpoint restored"})
}
