//go:build linux

package server

import (
	"net/http"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent"
	"github.com/gin-gonic/gin"
)

// handleGetSubagent returns the state and messages of a specific subagent.
//
//	GET /api/v1/subagents/:id
func (s *Server) handleGetSubagent(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "subagent id required"})
		return
	}

	info := agent.GetSubagentInfo(id)
	if info == nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "subagent not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": info})
}

// handleGetSubagentMessages returns the conversation messages of a subagent.
//
//	GET /api/v1/subagents/:id/messages
func (s *Server) handleGetSubagentMessages(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "subagent id required"})
		return
	}

	messages := agent.GetSubagentMessages(id)
	if messages == nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "subagent not found or no messages"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": messages})
}

// handleListSubagents returns all subagents for the current session.
//
//	GET /api/v1/subagents
func (s *Server) handleListSubagents(c *gin.Context) {
	sessionID := c.Query("session_id")
	infos := agent.ListSubagents(sessionID)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": infos})
}

// handleAbortSubagent requests cancellation of a running subagent.
//
//	POST /api/v1/subagents/:id/abort
func (s *Server) handleAbortSubagent(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "subagent id required"})
		return
	}

	if err := agent.AbortSubagent(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": "subagent abort requested"})
}

// handleGetSubagentBatch returns the status of a subagent batch.
//
//	GET /api/v1/subagent-batches/:batchId
func (s *Server) handleGetSubagentBatch(c *gin.Context) {
	batchID := c.Param("batchId")
	if batchID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "batch id required"})
		return
	}

	batch := agent.GetSubagentBatch(batchID)
	if batch == nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "batch not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": batch})
}

// handleCancelSubagentBatch cancels all running subagents in a batch.
//
//	POST /api/v1/subagent-batches/:batchId/cancel
func (s *Server) handleCancelSubagentBatch(c *gin.Context) {
	batchID := c.Param("batchId")
	if batchID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "batch id required"})
		return
	}

	count, err := agent.CancelSubagentBatch(batchID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"cancelled": count}})
}
