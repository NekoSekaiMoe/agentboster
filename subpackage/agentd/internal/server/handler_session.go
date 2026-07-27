//go:build linux

// Package server — handler_session.go
//
// Session lifecycle handlers split out of routes.go for navigation. These
// drive the clawless web API (persist session state to the central DB) and
// the local agent manager (in-process session registry, runtime status,
// abort). Pure extraction — no behavior change.
//
// Routes (registered in routes.go RegisterRoutes):
//
//	GET    /sessions/:id           — handleGetSession
//	PUT    /sessions/:id           — handleUpdateSession
//	DELETE /sessions/:id           — handleDeleteSession
//	GET    /sessions               — handleListSessions
//	POST   /sessions/switch        — handleSwitchSession
//	POST   /sessions/close         — handleCloseSession
//	POST   /sessions/:id/destroy   — handleDestroySession
//	GET    /sessions/status        — handleSessionStatus
//	POST   /sessions/:id/abort     — handleAbortSession
package server

import (
	"net/http"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/gin-gonic/gin"
)

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
