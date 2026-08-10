//go:build linux

package server

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/sync/semaphore"
)

// MTLSMiddleware verifies that HTTPS requests have a valid mTLS client
// certificate. Plain HTTP deployments are allowed for local/private-network
// setups and rely on APIKeyMiddleware for authentication.
func MTLSMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.TLS == nil {
			c.Next()
			return
		}
		if len(c.Request.TLS.PeerCertificates) == 0 {
			slog.Warn("mTLS: no client cert", "remote", c.RemoteIP())
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"success": false,
				"error":   "mTLS client certificate required",
			})
			return
		}
		c.Set("client_subject", c.Request.TLS.PeerCertificates[0].Subject.CommonName)
		c.Next()
	}
}

// APIKeyMiddleware validates the X-API-Key header.
func APIKeyMiddleware(expectedKey string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if expectedKey == "" {
			slog.Warn("API key not configured — rejecting request (set clawless_api_key to allow access)", "remote", c.RemoteIP())
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"success": false,
				"error":   "API key not configured on server",
			})
			return
		}
		key := c.GetHeader("X-API-Key")
		if key == "" {
			auth := c.GetHeader("Authorization")
			if len(auth) > 7 && auth[:7] == "Bearer " {
				key = auth[7:]
			}
		}
		if key == "" && c.Request.URL.Path == desktopVNCProxyPath {
			if validateSignedVNCQuery(
				expectedKey,
				c.Query("session_id"),
				c.Query("exp"),
				c.Query("sig"),
				time.Now(),
			) {
				c.Next()
				return
			}
		}
		// Public tunnels (/api/v1/t/<slug>/...): same HMAC-signed-query
		// pattern as VNC, scope-tagged differently so a VNC signature can't
		// be replayed against a tunnel route (and vice versa). See
		// tunnel_auth.go. The slug lives at path position 4 (/api/v1/t/<slug>/...).
		if key == "" && strings.HasPrefix(c.Request.URL.Path, "/api/v1/t/") {
			// gin populates route params during route matching, which happens
		// before the middleware chain runs, so c.Param("slug") is available
		// here on a matched /t/:slug/*path route. Falling back to manual
		// parsing only when the param is empty keeps this robust for
		// path-shape probes that didn't match the catch-all route.
			slug := c.Param("slug")
			if slug == "" {
				trimmed := strings.TrimPrefix(c.Request.URL.Path, "/api/v1/t/")
				if idx := strings.Index(trimmed, "/"); idx >= 0 {
					slug = trimmed[:idx]
				} else {
					slug = trimmed
				}
			}
			if slug != "" && validateSignedTunnelQuery(
				expectedKey,
				slug,
				c.Query("exp"),
				c.Query("sig"),
				time.Now(),
			) {
				c.Next()
				return
			}
		}
		if subtle.ConstantTimeCompare([]byte(key), []byte(expectedKey)) != 1 {
			slog.Warn("API key mismatch", "remote", c.RemoteIP())
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"success": false,
				"error":   "invalid API key",
			})
			return
		}
		c.Next()
	}
}

// CORSMiddleware adds CORS headers.
func CORSMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// RequestLogger logs incoming requests.
func RequestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		slog.Info("request",
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"remote", c.RemoteIP(),
		)
		c.Next()
	}
}

// streamingPath reports whether the request targets a long-lived /
// streaming endpoint (WebSocket, SSE, tunnel relay) that must NOT be
// subject to the normal request timeout or the global concurrency
// semaphore. Streaming handlers manage their own lifecycle and can
// legitimately outlive a per-request timeout; counting them against the
// semaphore would also exhaust the budget on a few long connections and
// 503 short API calls.
//
// Matches: /desktop/vnc (WS), /processes/:id/stream (SSE),
// /tools/exec/stream (SSE), /t/:slug/*path (tunnel relay).
func streamingPath(path string) bool {
	switch {
	case path == "/api/v1/desktop/vnc":
		return true
	case strings.HasPrefix(path, "/api/v1/processes/") && strings.HasSuffix(path, "/stream"):
		return true
	case path == "/api/v1/tools/exec/stream":
		return true
	case strings.HasPrefix(path, "/api/v1/t/"):
		return true
	}
	return false
}

// TimeoutMiddleware cancels the request context after the given duration so a
// stuck handler can't hold a goroutine forever. Streaming endpoints (SSE,
// WebSocket, tunnels) are exempted — they manage their own lifecycle and
// would be killed mid-stream by the timeout. 0 = disabled (legacy behavior).
func TimeoutMiddleware(timeout time.Duration) gin.HandlerFunc {
	if timeout <= 0 {
		return func(c *gin.Context) { c.Next() }
	}
	return func(c *gin.Context) {
		if streamingPath(c.Request.URL.Path) {
			// Streaming handlers own their lifecycle; let them derive a
			// longer-lived context (e.g. tied to the WS/SSE connection).
			c.Next()
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
}

// SemaphoreMiddleware caps the number of concurrent in-flight requests the
// server processes. Excess requests get 503 immediately (no queueing) so a
// flood can't exhaust goroutines / file descriptors. Streaming endpoints are
// exempted (see streamingPath). nil semaphore = disabled.
func SemaphoreMiddleware(sem *semaphore.Weighted) gin.HandlerFunc {
	if sem == nil {
		return func(c *gin.Context) { c.Next() }
	}
	return func(c *gin.Context) {
		if streamingPath(c.Request.URL.Path) {
			// Long-lived streams get their own budget; don't let a few SSE/WS
			// connections starve short API requests.
			c.Next()
			return
		}
		if !sem.TryAcquire(1) {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"success": false,
				"error":   "server busy (concurrency limit)",
			})
			c.Abort()
			return
		}
		defer sem.Release(1)
		c.Next()
	}
}
