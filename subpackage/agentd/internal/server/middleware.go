package server

import (
	"crypto/subtle"
	"log/slog"
	"net/http"

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
