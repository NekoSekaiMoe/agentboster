//go:build linux

package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

func signTunnelQueryForTest(secret, slug string, expires int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(buildSignedTunnelMessage(slug, expires)))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestValidateSignedTunnelQueryAcceptsValidSignature(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	expires := now.Unix() + int64(tunnelDefaultTTL.Seconds())
	sig := signTunnelQueryForTest("secret-key", "abcd1234abcd1234", expires)

	if !validateSignedTunnelQuery(
		"secret-key", "abcd1234abcd1234",
		itoa(expires), sig, now,
	) {
		t.Fatal("expected signature to validate")
	}
}

// itoa keeps this file free of strconv import noise for one call site.
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestValidateSignedTunnelQueryRejectsExpired(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	expires := now.Unix() - 1
	sig := signTunnelQueryForTest("secret-key", "abcd1234abcd1234", expires)

	if validateSignedTunnelQuery(
		"secret-key", "abcd1234abcd1234",
		itoa(expires), sig, now,
	) {
		t.Fatal("expected expired signature to be rejected")
	}
}

func TestValidateSignedTunnelQueryRejectsFarFutureBeyondMaxTTL(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	// A signature valid well past the max TTL ceiling must be rejected,
	// even if otherwise well-formed. This is the ceiling the bug report
	// asked for: without it a leaked far-future expires stays valid
	// forever.
	expires := now.Unix() + int64(tunnelMaxTTL.Seconds()) + 60
	sig := signTunnelQueryForTest("secret-key", "abcd1234abcd1234", expires)

	if validateSignedTunnelQuery(
		"secret-key", "abcd1234abcd1234",
		itoa(expires), sig, now,
	) {
		t.Fatal("expected signature beyond tunnelMaxTTL to be rejected")
	}
}

func TestValidateSignedTunnelQueryAcceptsAtMaxTTLBoundary(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	// Exactly at the ceiling should still be accepted (the check is >, not >=).
	expires := now.Unix() + int64(tunnelMaxTTL.Seconds())
	sig := signTunnelQueryForTest("secret-key", "abcd1234abcd1234", expires)

	if !validateSignedTunnelQuery(
		"secret-key", "abcd1234abcd1234",
		itoa(expires), sig, now,
	) {
		t.Fatal("expected signature at tunnelMaxTTL boundary to validate")
	}
}

func TestValidateSignedTunnelQueryRejectsWrongSlug(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	expires := now.Unix() + 300
	sig := signTunnelQueryForTest("secret-key", "abcd1234abcd1234", expires)

	if validateSignedTunnelQuery(
		"secret-key", "deadbeefdeadbeef",
		itoa(expires), sig, now,
	) {
		t.Fatal("expected slug-bound signature to be rejected for a different slug")
	}
}

func TestValidateSignedTunnelQueryRejectsVNCReplay(t *testing.T) {
	// A VNC-scoped signature must NOT authenticate a tunnel route (and
	// vice versa) — the scope tag is what keeps the two signatures from
	// being interchangeable.
	now := time.Unix(1_700_000_000, 0)
	expires := now.Unix() + 300
	vncSig := signVNCQueryForTest("secret-key", "abcd1234abcd1234", expires)

	if validateSignedTunnelQuery(
		"secret-key", "abcd1234abcd1234",
		itoa(expires), vncSig, now,
	) {
		t.Fatal("expected VNC signature to be rejected on tunnel scope")
	}
}
