//go:build linux

package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Signed-query auth for stateless HTTP tunnel proxies.
//
// Background: agentd's API is protected by APIKeyMiddleware (X-API-Key /
// Bearer). That works for machine-to-machine calls but NOT for browser
// clients that reach the sandbox through a tunnel — a browser noVNC
// client or a web preview tab can't easily set custom headers, and the
// user can't be expected to paste an API key into the URL bar.
//
// The VNC proxy already solves this with an HMAC-signed query string
// (vnc_auth.go): the daemon hands out a URL containing ?exp=<unix>&
// sig=<hmac>, the middleware validates the signature against the shared
// secret (the clawless API key) and lets the request through without an
// X-API-Key. This file generalizes that pattern so the new public tunnels
// (/api/v1/t/<slug>/...) can reuse it.
//
// Why a separate file from vnc_auth.go? The VNC helpers hardcode the
// scope string "v1:desktop-vnc:..." — we don't want to widen that
// signature's meaning (a VNC-signed URL must NOT authenticate a tunnel,
// and vice versa), so each proxy path gets its own scope tag. The
// underlying HMAC-SHA256 + constant-time compare + expiry check is
// identical and extracted below.
//
// Trust model: the shared secret is the clawless API key (cfg.Server.
// ClawLessAPIKey), the same one APIKeyMiddleware uses. Anyone who has
// the key can mint tunnel URLs; anyone without it can't, even if they
// learn a slug. Slugs are short and might be guessed, so the signature
// is what actually carries the auth — never rely on slug secrecy alone.

// buildSignedTunnelMessage is the canonical message whose HMAC a tunnel
// URL carries. Scope-tagged ("v1:public-tunnel") so a VNC signature
// can't be replayed against a tunnel route (and vice versa).
func buildSignedTunnelMessage(slug string, expires int64) string {
	return fmt.Sprintf("v1:public-tunnel:%s:%d", slug, expires)
}

// signTunnelQuery returns the HMAC-SHA256 hex digest a tunnel URL should
// carry under the ?sig= parameter. Callers also need to surface the same
// `expires` value under ?exp= so validateSignedTunnelQuery can rebuild
// the message.
func signTunnelQuery(secret, slug string, expires int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(buildSignedTunnelMessage(slug, expires)))
	return hex.EncodeToString(mac.Sum(nil))
}

// validateSignedTunnelQuery is the middleware-side check. It mirrors
// validateSignedVNCQuery exactly except for the scope tag:
//   - any empty input → reject
//   - already-expired → reject
//   - expires too far in the future (past tunnelMaxTTL) → reject
//   - constant-time compare against the recomputed digest
//
// The constant-time compare is the security-critical piece; never replace
// it with bytes.Equal.
//
// The max-TTL ceiling bounds the blast radius of a leaked signed URL:
// without it a caller that could somehow obtain a far-future expires
// (or an old build that minted one) would have a permanently valid URL.
// It is deliberately larger than tunnelDefaultTTL so a create-time
// request for a longer-than-default validity is honored, but not
// unbounded.
func validateSignedTunnelQuery(
	secret string,
	slug string,
	expiresParam string,
	signatureParam string,
	now time.Time,
) bool {
	if secret == "" || slug == "" || expiresParam == "" || signatureParam == "" {
		return false
	}

	expires, err := strconv.ParseInt(strings.TrimSpace(expiresParam), 10, 64)
	if err != nil {
		return false
	}
	if expires < now.Unix() {
		return false
	}
	if expires-now.Unix() > int64(tunnelMaxTTL.Seconds()) {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(buildSignedTunnelMessage(slug, expires)))
	expected := hex.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare(
		[]byte(expected),
		[]byte(strings.TrimSpace(signatureParam)),
	) == 1
}

// tunnelDefaultTTL is how long a tunnel URL stays valid when the create
// endpoint doesn't specify an expiry. Tuned long enough for a developer
// to share a preview link and have a reviewer open it minutes later, but
// short enough that a leaked URL ages out quickly. The create handler
// can pass a shorter ttl; tunnelMaxTTL is the absolute ceiling.
const tunnelDefaultTTL = 2 * time.Hour

// tunnelMaxTTL is the maximum validity any signed tunnel URL may carry,
// regardless of what the create endpoint requested. Enforced in
// validateSignedTunnelQuery so it applies symmetrically to mint and
// verify. Larger than tunnelDefaultTTL on purpose — a caller may
// legitimately want a longer-lived preview link — but bounded so a leaked
// signature can't be valid essentially forever.
const tunnelMaxTTL = 24 * time.Hour
