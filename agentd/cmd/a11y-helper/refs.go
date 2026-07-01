// Persistent ref index for the desktop accessibility tree. A `snapshot`
// invocation writes the latest mapping to /tmp/agentd-a11y-refs.json;
// later `click`/`type`/`fill` invocations read the same file to resolve
// `eN` back into a (bus_name, object_path) pair.
//
// Path is overridable via AGENTD_A11Y_REFS (we use this in tests to
// give each test its own file without stomping on the real index).

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const defaultRefsPath = "/tmp/agentd-a11y-refs.json"

// refEntry is one row in the persisted refs file. Fields must match
// the JSON tags exactly — the host (agentd) reads this file too when it
// wants to extract a bounding box for fallback path.
type refEntry struct {
	RefID      string `json:"ref_id"`
	BusName    string `json:"bus_name"`
	ObjectPath string `json:"object_path"`
	Role       string `json:"role"`
	Name       string `json:"name"`
	X          int32  `json:"x"`
	Y          int32  `json:"y"`
	Width      int32  `json:"width"`
	Height     int32  `json:"height"`
}

// refIndex wraps an array of refEntry for JSON marshalling.
type refIndex struct {
	Entries []refEntry `json:"entries"`
}

// center returns the bounding-box center, used as the RFB fallback
// target when AT-SPI cannot reach the action. Uses saturating math so
// a 2^31-wide "extent" doesn't overflow.
func (r refEntry) center() (int32, int32) {
	cx := r.X + r.Width/2
	cy := r.Y + r.Height/2
	return cx, cy
}

// refsPath resolves the on-disk refs file location. The env override is
// primarily for tests; production callers let it default.
func refsPath() string {
	if p := os.Getenv("AGENTD_A11Y_REFS"); p != "" {
		return p
	}
	return defaultRefsPath
}

// writeRefs persists the snapshot's ref index, returning the path
// written. Creates parent directories as needed.
func writeRefs(entries []refEntry) (string, error) {
	target := refsPath()
	if dir := filepath.Dir(target); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", fmt.Errorf("create parent dir for %s: %w", target, err)
		}
	}
	data, err := json.MarshalIndent(refIndex{Entries: entries}, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal refs index: %w", err)
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", fmt.Errorf("write refs index to %s: %w", target, err)
	}
	return target, nil
}

// lookupRef reads the refs file and returns the entry whose RefID
// matches the (normalized) query. Accepts "e3", "E03", "ref=e3", "3".
func lookupRef(refID string) (refEntry, error) {
	data, err := os.ReadFile(refsPath())
	if err != nil {
		return refEntry{}, fmt.Errorf("read refs index at %s: %w", refsPath(), err)
	}
	var idx refIndex
	if err := json.Unmarshal(data, &idx); err != nil {
		return refEntry{}, fmt.Errorf("parse refs index: %w", err)
	}
	want := normalizeRef(refID)
	for _, e := range idx.Entries {
		if e.RefID == want {
			return e, nil
		}
	}
	return refEntry{}, fmt.Errorf("ref %s not in %s (run `a11y-helper snapshot` first)", refID, refsPath())
}

// normalizeRef maps a user-typed ref id to the canonical "eN" form.
// "e3" / "E03" / "ref=e3" / "3" / "REF=7" all collapse to "e3" / "e7".
// Inputs that don't parse as a positive integer are returned trimmed
// as-is (so a typo like "eb" still produces a sensible lookup miss).
func normalizeRef(refID string) string {
	trimmed := strings.TrimSpace(refID)
	lower := strings.ToLower(trimmed)
	withoutPrefix := strings.TrimPrefix(lower, "ref=")
	withoutE := strings.TrimPrefix(withoutPrefix, "e")
	if n, err := strconv.Atoi(withoutE); err == nil && n > 0 {
		return fmt.Sprintf("e%d", n)
	}
	return trimmed
}
