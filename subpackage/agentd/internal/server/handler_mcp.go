//go:build linux

package server

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// MCPServerInfo describes a running MCP server.
type MCPServerInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Transport string `json:"transport"`
	Command   string `json:"command,omitempty"`
	URL       string `json:"url,omitempty"`
	Status    string `json:"status"`
}

// handleListMCPServers returns all known MCP servers.
//
//	GET /api/v1/mcp-servers
func (s *Server) handleListMCPServers(c *gin.Context) {
	// MCP server tracking is currently done at the agent level via
	// tools_mcp.go. For now, return an empty list — this endpoint
	// exists to wire the API contract; the implementation will be
	// filled when MCP lifecycle management is added to the Manager.
	c.JSON(http.StatusOK, gin.H{"success": true, "data": []MCPServerInfo{}})
}

// handleStartMCPServer starts a new MCP server.
//
//	POST /api/v1/mcp-servers
func (s *Server) handleStartMCPServer(c *gin.Context) {
	var req struct {
		Name      string `json:"name"`
		Command   string `json:"command"`
		Args      []string `json:"args"`
		Transport string `json:"transport"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Stub — MCP server lifecycle management is a future enhancement.
	c.JSON(http.StatusNotImplemented, gin.H{
		"success": false,
		"error":   "MCP server lifecycle management not yet implemented",
	})
}

// handleStopMCPServer stops an MCP server.
//
//	DELETE /api/v1/mcp-servers/:id
func (s *Server) handleStopMCPServer(c *gin.Context) {
	c.JSON(http.StatusNotImplemented, gin.H{
		"success": false,
		"error":   "MCP server lifecycle management not yet implemented",
	})
}
