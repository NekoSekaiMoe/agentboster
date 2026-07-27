//go:build linux

// Package server — handler_l2.go
//
// L2 authorization confirm handler split out of routes.go. This is the
// endpoint ClawLess (the web layer) calls when a user clicks an L2
// approval button — agentd publishes the decision onto its internal
// event bus so the waiting CodeAct loop can resume / abort. Pure
// extraction — no behavior change.
//
// Route (registered in routes.go RegisterRoutes):
//
//	POST /l2-confirm — handleL2Confirm
package server

import (
	"log/slog"
	"net/http"
	"regexp"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/eventbus"
	"github.com/gin-gonic/gin"
)

// validDurationRe matches the agreed "hhddmmyy" expiry format (8 digits).
var validDurationRe = regexp.MustCompile(`^\d{8}$`)

// isValidDuration reports whether a duration value is acceptable for
// pass_until / reject_until. Allowed values: "always", "session", or an
// 8-digit hhddmmyy expiry string.
func isValidDuration(d string) bool {
	switch d {
	case "always", "session":
		return true
	}
	return validDurationRe.MatchString(d)
}

// handleL2Confirm receives a user's L2 authorization decision (from the
// ClawLess web UI) and publishes it onto the event bus.
//
// Actions:
//
//	pass_once / reject_once   — single-shot decision for this command
//	pass_until / reject_until — sticky decision until `duration` expires
//	                             (always | <expiry>). Empty duration defaults
//	                             to "always".
//
// The handler itself is intentionally stateless — the L2AuthManager and
// the waiting agent loop subscribe to the bus events and apply policy.
func (s *Server) handleL2Confirm(c *gin.Context) {
	var body struct {
		TaskID     string `json:"task_id"`
		DecisionID string `json:"decision_id"`
		Action     string `json:"action"` // pass_once | pass_until | reject_once | reject_until
		Pattern    string `json:"pattern"`
		Duration   string `json:"duration"` // once | always | hhddmmyy
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	switch body.Action {
	case "pass_once":
		slog.Info("L2 pass_once", "task_id", body.TaskID, "pattern", body.Pattern)
		s.bus.Publish(eventbus.EventL2AuthApproved, map[string]any{
			"task_id":  body.TaskID,
			"command":  body.Pattern,
			"action":   "pass",
			"duration": "once",
		})
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data":    gin.H{"message": "✅ 已放行。任务继续执行。"},
		})

	case "reject_once":
		slog.Info("L2 reject_once", "task_id", body.TaskID, "pattern", body.Pattern)
		s.bus.Publish(eventbus.EventL2AuthRejected, map[string]any{
			"task_id":  body.TaskID,
			"command":  body.Pattern,
			"action":   "reject",
			"duration": "once",
		})
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data":    gin.H{"message": "❌ 已拒绝。任务已取消。"},
		})

	case "pass_until":
		duration := body.Duration
		if duration == "" {
			duration = "always"
		}
		if !isValidDuration(duration) {
			c.JSON(http.StatusBadRequest, gin.H{
				"success": false,
				"error":   "invalid duration value",
			})
			return
		}
		slog.Info("L2 pass_until", "task_id", body.TaskID, "pattern", body.Pattern, "duration", duration)
		s.bus.Publish(eventbus.EventL2AuthApproved, map[string]any{
			"task_id":  body.TaskID,
			"command":  body.Pattern,
			"action":   "pass",
			"duration": duration,
		})
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data":    gin.H{"message": "✅ 已放行至指定时间。"},
		})

	case "reject_until":
		duration := body.Duration
		if duration == "" {
			duration = "always"
		}
		if !isValidDuration(duration) {
			c.JSON(http.StatusBadRequest, gin.H{
				"success": false,
				"error":   "invalid duration value",
			})
			return
		}
		slog.Info("L2 reject_until", "task_id", body.TaskID, "pattern", body.Pattern, "duration", duration)
		s.bus.Publish(eventbus.EventL2AuthRejected, map[string]any{
			"task_id":  body.TaskID,
			"command":  body.Pattern,
			"action":   "reject",
			"duration": duration,
		})
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data":    gin.H{"message": "🔕 已拒绝至指定时间。"},
		})

	default:
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"error":   "Unknown action: " + body.Action,
		})
	}
}
