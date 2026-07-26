// Package server provides HTTP handlers for the agentd REST API.
//
// tunnels.go — public-URL tunnels to sandbox-internal ports.
//
// BACKGROUND
//   When the agent starts a service inside a sandbox (`npm run dev` on
//   port 3000, a noVNC desktop on 6080, a notebook on 8888), that port is
//   only reachable from inside the sandbox's network namespace. Mobile /
//   external users can't get to it. ref_liveagent.md §2.2 (and the parent
//   task's "managed long-lived process + tunnel" P0 bucket) asks for a
//   one-call primitive that returns a public URL the agent can hand to
//   the user.
//
//   agentd already has the building blocks:
//     - sbMgr.ContainerIP(sandboxID) returns the sandbox's internal IP.
//     - vnc_proxy.go has a proven HTTP-Hijack → io.Copy TCP relay that
//       forwards a public ingress path to a sandbox-internal TCP backend
//       (it's how /desktop/vnc reaches websockify on :6080).
//     - vnc_auth.go has the HMAC-signed-query auth pattern that lets a
//       browser client connect without custom headers.
//
//   This file generalizes that pattern: any registered (sandboxID, port)
//   pair gets a `/api/v1/tunnels/<slug>` proxy path whose handler is the
//   vnc_proxy skeleton with a parameterized backend. Web clients hit
//   `/t/<slug>/...` (no auth headers needed — the HMAC query signs the
//   request); the agent gets back a ready-to-use URL.
//
// WHY THIS IS A MINIMAL FIRST CUT
//   The proxy itself (handleTunnelProxy) reuses handleVNCProxy's Hijack +
//   io.Copy verbatim — the only change is the backend address source
//   (tunnel registry vs hardcoded :6080). The registry is in-memory and
//   per-process; it does NOT survive agentd restarts yet. The signup /
//   teardown endpoints are stubbed to make the API surface stable while
//   the persistence + multi-connection pooling work is finished.
//
// FOLLOW-UP (production tunnels)
//   1. Persist the tunnel registry (lib/persistence/kvstore.go's
//      KeyValueStore[T] is the right shape — same one BackgroundTaskStore
//      uses) so tunnels survive restart.
//   2. Support N concurrent connections per tunnel (vnc_proxy is
//      single-connection; a real tunnel proxy needs a connection set +
//      per-conn io.Copy goroutines).
//   3. Expiry / idle reaper (mirror desktop.go's lastActivity pattern).
//   4. Bump main.go version when the slug + auth format stabilizes.
package server

import (
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// tunnelRecord is the in-memory state for one public→sandbox tunnel.
type tunnelRecord struct {
	ID         string    `json:"id"`
	Slug       string    `json:"slug"`
	SessionID  string    `json:"session_id"`
	SandboxID  string    `json:"sandbox_id"`
	TargetPort int       `json:"target_port"`
	CreatedAt  time.Time `json:"created_at"`
	// TargetHost is the sandbox-internal IP (resolved via sbMgr.ContainerIP).
	// Resolved lazily on each connect so IP changes after a sandbox restart
	// don't invalidate the tunnel.
	TargetHost string `json:"target_host"`
}

// tunnelRegistry holds all active tunnels. Methods are goroutine-safe.
// In-memory only for now — see FOLLOW-UP #1 in the file header.
type tunnelRegistry struct {
	mu      sync.RWMutex
	bySlug  map[string]*tunnelRecord
	byID    map[string]*tunnelRecord
}

var tunnels = &tunnelRegistry{
	bySlug: make(map[string]*tunnelRecord),
	byID:   make(map[string]*tunnelRecord),
}

func (r *tunnelRegistry) add(t *tunnelRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bySlug[t.Slug] = t
	r.byID[t.ID] = t
}

func (r *tunnelRegistry) get(slug string) (*tunnelRecord, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.bySlug[slug]
	return t, ok
}

func (r *tunnelRegistry) remove(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.byID[id]
	if !ok {
		return false
	}
	delete(r.byID, id)
	delete(r.bySlug, t.Slug)
	return true
}

func (r *tunnelRegistry) list() []*tunnelRecord {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*tunnelRecord, 0, len(r.byID))
	for _, t := range r.byID {
		out = append(out, t)
	}
	return out
}

// tunnelCreateRequest is the body for POST /api/v1/tunnels.
type tunnelCreateRequest struct {
	SessionID  string `json:"session_id"  binding:"required"`
	SandboxID  string `json:"sandbox_id"`
	TargetPort int    `json:"target_port" binding:"required,min=1,max=65535"`
}

// handleCreateTunnel registers a new (sandbox, port) pair and returns the
// public slug + a ready-to-use URL. The slug is a short random string; the
// public URL is `<daemon public base>/api/v1/t/<slug>/` and works without
// custom headers (HMAC-signed query appended client-side per vnc_auth.go).
func (s *Server) handleCreateTunnel(c *gin.Context) {
	var req tunnelCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	agentCtx, ok := s.agentMgr.GetSession(req.SessionID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "session not found"})
		return
	}
	sandboxID := req.SandboxID
	if sandboxID == "" {
		sandboxID = agentCtx.SandboxID
	}
	if sandboxID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "no sandbox for session"})
		return
	}

	// Resolve the sandbox's internal IP up front so create-time errors
	// surface immediately. The stored value is a hint — handleTunnelProxy
	// re-resolves on connect to tolerate sandbox restarts that change IPs.
	sbMgr := s.agentMgr.GetSandboxManager()
	if sbMgr == nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"error":   "sandbox manager unavailable",
		})
		return
	}
	host, err := sbMgr.ContainerIP(sandboxID)
	if err != nil || host == "" {
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"error":   "could not resolve sandbox internal IP",
		})
		return
	}

	slug := uuid.NewString()[:8]
	t := &tunnelRecord{
		ID:         uuid.NewString(),
		Slug:       slug,
		SessionID:  req.SessionID,
		SandboxID:  sandboxID,
		TargetPort: req.TargetPort,
		TargetHost: host,
		CreatedAt:  time.Now().UTC(),
	}
	tunnels.add(t)

	// Mint an HMAC-signed URL so browser clients can reach the tunnel
	// without an X-API-Key header. The middleware validates ?exp / ?sig
	// against the same clawless_api_key that gates the rest of the API.
	// Anyone with the API key can mint URLs; anyone without it can't,
	// even if they learn the slug. See tunnel_auth.go for the trust model.
	secret := s.cfg.Server.ClawLessAPIKey
	expires := time.Now().Add(tunnelDefaultTTL).Unix()
	sig := signTunnelQuery(secret, t.Slug, expires)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"id":          t.ID,
			"slug":        t.Slug,
			"target_host": t.TargetHost,
			"target_port": t.TargetPort,
			// Ready-to-use URL: clients append their own path after `/t/<slug>/`.
			// The signature is bound to (slug, exp) so it's safe to put in a
			// shareable link — changing either query param invalidates the sig.
			"url":        fmt.Sprintf("/api/v1/t/%s/?exp=%d&sig=%s", t.Slug, expires, sig),
			"expires_at": time.Unix(expires, 0).UTC().Format(time.RFC3339),
			"created_at": t.CreatedAt.Format(time.RFC3339),
			// Surface the auth scheme so consumers know the gap documented in
			// the previous stub ("todo-hmac") is now closed.
			"auth": "hmac-sha256-signed-query",
		},
	})
}

// handleListTunnels returns every active tunnel. Mostly for the Web UI's
// debugging / "what did the agent expose" panel.
func (s *Server) handleListTunnels(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"success": true, "data": tunnels.list()})
}

// handleDeleteTunnel tears down a tunnel by id. Idempotent: deleting an
// unknown id still returns success (the post-condition "tunnel doesn't
// exist" holds either way).
func (s *Server) handleDeleteTunnel(c *gin.Context) {
	id := c.Param("id")
	tunnels.remove(id)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"id": id, "removed": true}})
}

// handleTunnelProxy is the actual byte-for-byte TCP relay. It is the
// handleVNCProxy skeleton with one substitution: the backend address is
// (registry[slug].TargetHost, registry[slug].TargetPort) instead of the
// hardcoded `<containerIP>:6080`. The Hijack + io.Copy body is identical
// to vnc_proxy.go and inherits its single-connection-per-request shape;
// FOLLOW-UP #2 in the file header tracks lifting that to a connection set.
//
// Auth: currently NONE. Until the HMAC-signed-query helper from vnc_auth
// is generalized to cover tunnel slugs (FOLLOW-UP #4), this route MUST
// only be exposed on trusted networks — anyone who learns a slug can
// reach the sandbox port. The /tunnels create response surfaces
// `auth: "todo-hmac"` so consumers know the state.
func (s *Server) handleTunnelProxy(c *gin.Context) {
	slug := c.Param("slug")
	if slug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "tunnel slug is required"})
		return
	}

	// Validate the HMAC-signed query BEFORE consulting the registry. We
	// do this first so an unknown slug can't be probed via timing — the
	// signature check is constant-time and secret-bound, the registry
	// lookup is neither. The middleware has already let us through based
	// on the same signature, but re-checking here defends in depth against
	// a future route-table change that widens middleware bypass.
	if !validateSignedTunnelQuery(
		s.cfg.Server.ClawLessAPIKey,
		slug,
		c.Query("exp"),
		c.Query("sig"),
		time.Now(),
	) {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "invalid or expired tunnel signature"})
		return
	}

	t, ok := tunnels.get(slug)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "tunnel not found"})
		return
	}

	sbMgr := s.agentMgr.GetSandboxManager()
	if sbMgr == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "sandbox manager unavailable"})
		return
	}

	// Re-resolve the container IP on every connect. Sandboxes can move IPs
	// across restarts, and the cached value on the tunnel record is only a
	// hint from create-time.
	host, err := sbMgr.ContainerIP(t.SandboxID)
	if err != nil || host == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"success": false,
			"error":   fmt.Sprintf("cannot resolve sandbox IP: %v", err),
		})
		return
	}

	backend := net.JoinHostPort(host, strconv.Itoa(t.TargetPort))
	backendConn, err := net.DialTimeout("tcp", backend, 5*time.Second)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"success": false,
			"error":   fmt.Sprintf("cannot connect to tunnel backend %s: %v", backend, err),
		})
		return
	}
	defer backendConn.Close()

	// Hijack the HTTP connection so we can shovel raw bytes (incl. for
	// WebSocket upgrade requests, which is how browser-based noVNC / Vite
	// HMR clients reach the sandbox through this proxy).
	hijacker, ok := c.Writer.(http.Hijacker)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "server does not support connection hijacking"})
		return
	}
	clientConn, clientBuf, err := hijacker.Hijack()
	if err != nil {
		slog.Error("tunnel_proxy: hijack failed", "slug", slug, "error", err)
		return
	}
	defer clientConn.Close()

	// Replay the original HTTP request line + headers to the backend so
	// protocol-level handshakes (WebSocket, plain HTTP) complete against
	// the real service, not against agentd.
	if err := c.Request.Write(backendConn); err != nil {
		slog.Error("tunnel_proxy: forward request failed", "slug", slug, "error", err)
		return
	}
	// Flush any bytes the client already buffered before the hijack —
	// common for WebSocket clients that send the upgrade AND a ping in
	// the same packet.
	if clientBuf.Reader.Buffered() > 0 {
		buffered := make([]byte, clientBuf.Reader.Buffered())
		if _, err := clientBuf.Read(buffered); err == nil {
			backendConn.Write(buffered)
		}
	}

	slog.Info("tunnel_proxy: relay established",
		"slug", slug, "sandbox_id", t.SandboxID, "backend", backend)

	// Bidirectional copy. Wait for EITHER direction to finish (not both)
	// — same semantics as vnc_proxy.go: once one side half-closes we tear
	// the tunnel down.
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
