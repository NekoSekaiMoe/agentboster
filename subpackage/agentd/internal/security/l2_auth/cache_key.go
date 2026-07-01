package l2_auth

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/usertype"
)

const PolicyVersion = "2026-06-08.1"

type CacheKey struct {
	UserID        string
	SessionID     string
	ToolName      string
	ArgsHash      string
	SandboxID     string
	PolicyVersion string
	UserType      usertype.UserType
}

func hashString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func CacheKeyForTask(task *clawless.Task) CacheKey {
	userType := usertype.Resolve(task.Roles)
	userID := strings.TrimSpace(task.UserID)
	if userID == "" {
		userID = "unknown"
	}
	sessionID := strings.TrimSpace(task.SessionID)
	if sessionID == "" {
		sessionID = "unknown"
	}
	sandboxID := strings.TrimSpace(task.SandboxID)
	if sandboxID == "" {
		sandboxID = "unknown"
	}
	return CacheKey{
		UserID:        userID,
		SessionID:     sessionID,
		ToolName:      "task_command",
		ArgsHash:      hashString(task.Command),
		SandboxID:     sandboxID,
		PolicyVersion: PolicyVersion,
		UserType:      userType,
	}
}

func (k CacheKey) Hash() string {
	parts := []string{
		k.UserID,
		k.SessionID,
		k.ToolName,
		k.ArgsHash,
		k.SandboxID,
		k.PolicyVersion,
	}
	return hashString(strings.Join(parts, "\x00"))
}

func (k CacheKey) SessionScopedKey() string {
	return k.Hash()
}
