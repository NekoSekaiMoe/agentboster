//go:build linux

package server

import (
	"errors"
	"net/http"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent"
	"github.com/gin-gonic/gin"
)

var (
	errSessionIDRequired = errors.New("session_id is required")
	errSessionNotFound   = errors.New("session not found")
)

// handleCreateCheckpoint creates a git snapshot of the sandbox workspace.
//
// The sandbox is resolved server-side from the session id, so the client
// cannot target an arbitrary host path.
//
//	POST /api/v1/checkpoints
func (s *Server) handleCreateCheckpoint(c *gin.Context) {
	var req struct {
		SessionID   string `json:"session_id"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	ref, err := s.resolveCheckpointSandbox(req.SessionID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	cp, err := agent.CreateCheckpoint(ref, s.agentMgr.GetSandboxManager(), req.SessionID, req.Description)
	if err != nil {
		if errors.Is(err, agent.ErrGitUnavailableInContainer) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": cp})
}

// handleListCheckpoints lists checkpoints for a session.
//
//	GET /api/v1/checkpoints?session_id=...
func (s *Server) handleListCheckpoints(c *gin.Context) {
	sessionID := c.Query("session_id")

	ref, err := s.resolveCheckpointSandbox(sessionID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	checkpoints, err := agent.ListCheckpoints(ref, s.agentMgr.GetSandboxManager(), sessionID)
	if err != nil {
		if errors.Is(err, agent.ErrGitUnavailableInContainer) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": checkpoints})
}

// handleRestoreCheckpoint restores files to a checkpoint.
//
//	POST /api/v1/checkpoints/:id/restore  { "session_id": "..." }
func (s *Server) handleRestoreCheckpoint(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "checkpoint id required"})
		return
	}

	var req struct {
		SessionID string `json:"session_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		// Allow empty body only when session_id is also on the query string.
		req.SessionID = c.Query("session_id")
	}

	ref, err := s.resolveCheckpointSandbox(req.SessionID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	if err := agent.RestoreCheckpoint(ref, s.agentMgr.GetSandboxManager(), id); err != nil {
		if errors.Is(err, agent.ErrGitUnavailableInContainer) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": "checkpoint restored"})
}

// resolveCheckpointSandbox resolves the registered sandbox for a session and
// returns the SandboxRef to use for checkpoint operations. The client never
// supplies a host path; the daemon looks up the session's sandbox by id.
//
// For LXC sandboxes we additionally resolve the real host rootfs path via the
// sandbox manager so the host-FS checkpoint backend validates against the
// allowed roots. Docker-style sandboxes return HostPath="" and the container
// backend is selected via Type+ID.
func (s *Server) resolveCheckpointSandbox(sessionID string) (agent.SandboxRef, error) {
	if sessionID == "" {
		return agent.SandboxRef{}, errSessionIDRequired
	}
	agentCtx, ok := s.agentMgr.GetSession(sessionID)
	if !ok {
		return agent.SandboxRef{}, errSessionNotFound
	}
	ref := agent.SandboxRef{
		Type: agentCtx.SandboxType,
		ID:   agentCtx.SandboxID,
	}
	// For host-FS sandboxes, ask the manager for the resolved host root path.
	if agentCtx.SandboxID != "" && s.agentMgr.GetSandboxManager() != nil {
		if hp := s.agentMgr.GetSandboxManager().HostWorkspacePath(agentCtx.SandboxID); hp != "" {
			ref.HostPath = hp
		}
	}
	return ref, nil
}
