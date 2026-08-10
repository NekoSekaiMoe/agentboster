//go:build linux

package server

import (
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent/desktop"
	"github.com/gin-gonic/gin"
)

// handleVNCProxy upgrades the incoming HTTP request to a WebSocket-like
// raw TCP tunnel and proxies it to the container's websockify (port 6080).
// This allows the desktop's noVNC client to connect through agentd's
// existing listen port without exposing additional ports.
//
// The endpoint hijacks the connection after validating the session and
// performs a bidirectional byte copy between the client and the container's
// websockify. It supports both WebSocket upgrade and plain HTTP CONNECT
// semantics (noVNC uses WebSocket).
func (s *Server) handleVNCProxy(c *gin.Context) {
	sessionID := c.Query("session_id")
	if sessionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "session_id is required"})
		return
	}

	agentCtx, ok := s.agentMgr.GetSession(sessionID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "session not found"})
		return
	}
	// Snapshot the sandbox ID under the per-session state lock:
	// sandbox_destroy clears it concurrently.
	var sandboxID string
	agentCtx.WithStateLock(func() { sandboxID = agentCtx.SandboxID })
	if sandboxID == "" {
		c.JSON(http.StatusConflict, gin.H{"success": false, "error": "session has no sandbox"})
		return
	}

	sbMgr := s.agentMgr.GetSandboxManager()
	if sbMgr == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "sandbox manager unavailable"})
		return
	}
	if err := desktop.EnsureDesktop(sbMgr, sandboxID); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"success": false,
			"error":   fmt.Sprintf("desktop stack unavailable: %v", err),
		})
		return
	}

	containerIP, err := sbMgr.ContainerIP(sandboxID)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "error": fmt.Sprintf("cannot resolve container IP: %v", err)})
		return
	}

	backend := net.JoinHostPort(containerIP, "6080")

	backendConn, err := net.DialTimeout("tcp", backend, 5*time.Second)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "error": fmt.Sprintf("cannot connect to noVNC: %v", err)})
		return
	}
	defer backendConn.Close()

	hijacker, ok := c.Writer.(http.Hijacker)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "server does not support connection hijacking"})
		return
	}

	clientConn, clientBuf, err := hijacker.Hijack()
	if err != nil {
		slog.Error("vnc_proxy: hijack failed", "error", err)
		return
	}
	defer clientConn.Close()

	// Forward the original HTTP request (including WebSocket upgrade) to
	// the backend so websockify can complete the handshake.
	if err := c.Request.Write(backendConn); err != nil {
		slog.Error("vnc_proxy: failed to forward request to backend", "error", err)
		return
	}

	// Also flush any buffered data from the client that arrived before hijack.
	if clientBuf.Reader.Buffered() > 0 {
		buffered := make([]byte, clientBuf.Reader.Buffered())
		if _, err := clientBuf.Read(buffered); err == nil {
			backendConn.Write(buffered)
		}
	}

	slog.Info("vnc_proxy: tunnel established",
		"session_id", sessionID,
		"sandbox_id", sandboxID,
		"backend", backend,
	)

	done := make(chan struct{}, 2)

	go func() {
		io.Copy(clientConn, backendConn)
		done <- struct{}{}
	}()
	go func() {
		io.Copy(backendConn, clientConn)
		done <- struct{}{}
	}()

	<-done
}
