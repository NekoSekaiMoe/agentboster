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

const desktopVNCProxyPath = "/api/v1/desktop/vnc"

func buildSignedVNCMessage(sessionID string, expires int64) string {
	return fmt.Sprintf("v1:desktop-vnc:%s:%d", sessionID, expires)
}

func validateSignedVNCQuery(
	secret string,
	sessionID string,
	expiresParam string,
	signatureParam string,
	now time.Time,
) bool {
	if secret == "" || sessionID == "" || expiresParam == "" || signatureParam == "" {
		return false
	}

	expires, err := strconv.ParseInt(strings.TrimSpace(expiresParam), 10, 64)
	if err != nil || expires < now.Unix() {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(buildSignedVNCMessage(sessionID, expires)))
	expected := hex.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare(
		[]byte(expected),
		[]byte(strings.TrimSpace(signatureParam)),
	) == 1
}
