//go:build linux

package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

func signVNCQueryForTest(secret, sessionID string, expires int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(buildSignedVNCMessage(sessionID, expires)))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestValidateSignedVNCQueryAcceptsValidSignature(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	expires := now.Unix() + 300
	signature := signVNCQueryForTest("secret-key", "sess_123", expires)

	if !validateSignedVNCQuery(
		"secret-key",
		"sess_123",
		"1700000300",
		signature,
		now,
	) {
		t.Fatal("expected signature to validate")
	}
}

func TestValidateSignedVNCQueryRejectsExpiredToken(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	expires := now.Unix() - 1
	signature := signVNCQueryForTest("secret-key", "sess_123", expires)

	if validateSignedVNCQuery(
		"secret-key",
		"sess_123",
		"1699999999",
		signature,
		now,
	) {
		t.Fatal("expected expired signature to be rejected")
	}
}

func TestValidateSignedVNCQueryRejectsWrongSession(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	expires := now.Unix() + 300
	signature := signVNCQueryForTest("secret-key", "sess_123", expires)

	if validateSignedVNCQuery(
		"secret-key",
		"sess_456",
		"1700000300",
		signature,
		now,
	) {
		t.Fatal("expected session-bound signature to be rejected")
	}
}
