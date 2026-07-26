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
	"sync/atomic"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/persistence"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// tunnelRecord is the runtime companion to persistence.TunnelRecord: it
// carries the live connection-set + activity state that we deliberately
// do NOT persist (open conns die with the process; only the slug→backend
// mapping survives restart). One tunnelRecord per slug.
type tunnelRecord struct {
	// spec is the persisted snapshot (slug, sandbox, port). Read-only after
	// load — callers mutate runtime fields below, never spec.
	spec *persistence.TunnelRecord

	// activeConns counts live TCP relays. The idle reaper treats >0 as
	// "recently used" so an in-flight tunnel is never reaped mid-stream.
	activeConns atomic.Int64

	// lastActivity is the wall-clock time of the last connect / byte
	// observed. Reaper uses this to decide idle eviction. Guarded by mu.
	lastActivity time.Time
}

// tunnelRegistry holds all active tunnels. Backed by persistence.TunnelStore
// for cross-restart durability; the in-memory map caches the live runtime
// state (connection counts, activity timestamps) that the store doesn't keep.
// Methods are goroutine-safe.
type tunnelRegistry struct {
	mu     sync.RWMutex
	bySlug map[string]*tunnelRecord

	store *persistence.TunnelStore

	// reaperOnce ensures only one idle-reaper goroutine runs, started lazily
	// on the first add(). Mirrors desktop.go's idleReaperOnce pattern.
	reaperOnce sync.Once
}

var tunnels = &tunnelRegistry{
	bySlug: make(map[string]*tunnelRecord),
}

// InitTunnelStore wires the on-disk backing store and restores any
// previously-persisted tunnels. Called once from main.go during startup.
// Safe to call with a nil store (in-memory-only mode) — tests use that.
func InitTunnelStore(store *persistence.TunnelStore) {
	tunnels.store = store
	if store == nil {
		return
	}
	for _, spec := range store.ListAll() {
		// Re-hydrate the in-memory cache. activeConns starts at 0 (no live
		// conns after a restart) and lastActivity is the persisted value,
		// so the reaper can immediately evict a tunnel nobody reconnected to.
		tunnels.bySlug[spec.Slug] = &tunnelRecord{
			spec:         spec,
			lastActivity: spec.LastActivity,
		}
	}
}

// tunnelIdleTimeout is how long a tunnel with zero active connections can
// go unused before the reaper evicts it. Long enough that a developer
// sharing a link over chat doesn't race the reaper; short enough that
// abandoned tunnels don't accumulate forever.
const tunnelIdleTimeout = 30 * time.Minute

// tunnelReaperInterval is how often the background reaper sweeps the
// registry. Kept coarse — reaping is best-effort cleanup, not real-time.
const tunnelReaperInterval = 5 * time.Minute

func (r *tunnelRegistry) startReaper() {
	r.reaperOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(tunnelReaperInterval)
			defer ticker.Stop()
			for range ticker.C {
				r.reapIdle(time.Now())
			}
		}()
	})
}

// reapIdle removes tunnels that haven't seen activity in tunnelIdleTimeout
// AND have no live connections. Called periodically by startReaper. Exposed
// (lowercase) so tests can drive it deterministically instead of waiting
// on the ticker.
func (r *tunnelRegistry) reapIdle(now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for slug, t := range r.bySlug {
		if t.activeConns.Load() > 0 {
			continue
		}
		if now.Sub(t.lastActivity) < tunnelIdleTimeout {
			continue
		}
		delete(r.bySlug, slug)
		if r.store != nil {
			if err := r.store.Remove(slug); err != nil {
				slog.Warn("tunnel: reaper store-remove failed",
					"slug", slug, "error", err)
			}
		}
		slog.Info("tunnel: reaped idle", "slug", slug)
	}
}

func (r *tunnelRegistry) add(spec *persistence.TunnelRecord) {
	r.mu.Lock()
	r.bySlug[spec.Slug] = &tunnelRecord{
		spec:         spec,
		lastActivity: spec.CreatedAt,
	}
	r.mu.Unlock()
	r.startReaper()
}

// get returns the runtime record for a slug AND marks it active (bumps
// lastActivity). Callers MUST pair a successful get with release() when
// the connection ends, so activeConns stays accurate.
func (r *tunnelRegistry) get(slug string) (*tunnelRecord, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.bySlug[slug]
	if !ok {
		return nil, false
	}
	t.activeConns.Add(1)
	t.lastActivity = time.Now()
	return t, true
}

// release decrements the active-connection counter. Safe to call without
// a prior get (counter would go negative; we clamp at 0).
func (r *tunnelRegistry) release(slug string) {
	r.mu.RLock()
	t, ok := r.bySlug[slug]
	r.mu.RUnlock()
	if !ok {
		return
	}
	for {
		cur := t.activeConns.Load()
		if cur <= 0 {
			return
		}
		if t.activeConns.CompareAndSwap(cur, cur-1) {
			return
		}
	}
}

// removeByID deletes a tunnel by its REST id. Returns false when the id
// isn't registered. Used by DELETE /tunnels/:id.
func (r *tunnelRegistry) removeByID(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	var slug string
	for s, t := range r.bySlug {
		if t.spec.ID == id {
			slug = s
			break
		}
	}
	if slug == "" {
		return false
	}
	delete(r.bySlug, slug)
	if r.store != nil {
		_ = r.store.Remove(slug)
	}
	return true
}

func (r *tunnelRegistry) list() []*persistence.TunnelRecord {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*persistence.TunnelRecord, 0, len(r.bySlug))
	for _, t := range r.bySlug {
		out = append(out, t.spec)
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
	now := time.Now().UTC()
	spec := &persistence.TunnelRecord{
		ID:           uuid.NewString(),
		Slug:         slug,
		SessionID:    req.SessionID,
		SandboxID:    sandboxID,
		TargetPort:   req.TargetPort,
		TargetHost:   host,
		CreatedAt:    now,
		LastActivity: now,
	}
	// Persist first so a crash between persist and registry-add doesn't
	// leave a URL that works in-memory but is unrecoverable after restart.
	// If the store is nil (in-memory mode) this is a no-op.
	if tunnels.store != nil {
		if err := tunnels.store.Save(spec); err != nil {
			slog.Warn("tunnel: persist failed", "slug", slug, "error", err)
			// Continue — the in-memory registry still serves the URL until
			// the daemon restarts. Persistence is best-effort for UX, not
			// a correctness gate.
		}
	}
	tunnels.add(spec)

	// Mint an HMAC-signed URL so browser clients can reach the tunnel
	// without an X-API-Key header. The middleware validates ?exp / ?sig
	// against the same clawless_api_key that gates the rest of the API.
	// Anyone with the API key can mint URLs; anyone without it can't,
	// even if they learn the slug. See tunnel_auth.go for the trust model.
	secret := s.cfg.Server.ClawLessAPIKey
	expires := time.Now().Add(tunnelDefaultTTL).Unix()
	sig := signTunnelQuery(secret, spec.Slug, expires)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"id":          spec.ID,
			"slug":        spec.Slug,
			"target_host": spec.TargetHost,
			"target_port": spec.TargetPort,
			// Ready-to-use URL: clients append their own path after `/t/<slug>/`.
			// The signature is bound to (slug, exp) so it's safe to put in a
			// shareable link — changing either query param invalidates the sig.
			"url":        fmt.Sprintf("/api/v1/t/%s/?exp=%d&sig=%s", spec.Slug, expires, sig),
			"expires_at": time.Unix(expires, 0).UTC().Format(time.RFC3339),
			"created_at": spec.CreatedAt.Format(time.RFC3339),
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
	tunnels.removeByID(id)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"id": id, "removed": true}})
}

// handleTunnelProxy is the actual byte-for-byte TCP relay. It is the
// handleVNCProxy skeleton with one substitution: the backend address is
// (registry[slug].spec.TargetHost, TargetPort) instead of the hardcoded
// `<containerIP>:6080`. The Hijack + io.Copy body is identical to
// vnc_proxy.go.
//
// Multiple concurrent connections per slug are supported: each connect
// increments the tunnel's active-conns counter and spawns its own pair
// of io.Copy goroutines. The counter feeds the idle reaper so an active
// tunnel is never evicted mid-stream.
//
// Auth: HMAC-signed query (tunnel_auth.go), enforced both in middleware
// AND re-checked here for defense in depth.
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
	// tunnels.get bumped the active-conns counter; release it on exit so
	// the reaper's idle check reflects reality. Using defer guarantees
	// release even if any of the early returns below fire (Hijack failure,
	// backend dial failure, etc.).
	defer tunnels.release(slug)

	sbMgr := s.agentMgr.GetSandboxManager()
	if sbMgr == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "sandbox manager unavailable"})
		return
	}

	// Re-resolve the container IP on every connect. Sandboxes can move IPs
	// across restarts, and the cached value on the tunnel record is only a
	// hint from create-time.
	host, err := sbMgr.ContainerIP(t.spec.SandboxID)
	if err != nil || host == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"success": false,
			"error":   fmt.Sprintf("cannot resolve sandbox IP: %v", err),
		})
		return
	}

	backend := net.JoinHostPort(host, strconv.Itoa(t.spec.TargetPort))
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
		"slug", slug, "sandbox_id", t.spec.SandboxID, "backend", backend,
		"active_conns", t.activeConns.Load())

	// Bidirectional copy. Wait for EITHER direction to finish (not both)
	// — same semantics as vnc_proxy.go: once one side half-closes we tear
	// this connection down. Other concurrent connections on the same slug
	// keep running independently; each one has its own io.Copy pair.
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
