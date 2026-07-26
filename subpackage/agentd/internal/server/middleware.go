package server

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
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
			// Extract slug from path. gin populates the param later; the
			// middleware runs before the route handler, so we parse manually.
			// Path shape is exactly "/api/v1/t/<slug>/...", so trimming the
			// "/api/v1/t/" prefix and cutting at the next "/" gives the slug.
			trimmed := strings.TrimPrefix(c.Request.URL.Path, "/api/v1/t/")
			slug := trimmed
			if idx := strings.Index(trimmed, "/"); idx >= 0 {
				slug = trimmed[:idx]
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
