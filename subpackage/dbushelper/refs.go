// Package dbushelper — persistent ref index for the desktop
// accessibility tree. A `snapshot` invocation writes the latest
// mapping to /tmp/agentd-a11y-refs.json; later `click`/`type`/`fill`
// invocations read the same file to resolve `eN` back into a
// (bus_name, object_path) pair.
//
// Path is overridable via AGENTD_A11Y_REFS (we use this in tests to
// give each test its own file without stomping on the real index).

package dbushelper

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const DefaultRefsPath = "/tmp/agentd-a11y-refs.json"

// RefKind distinguishes actionable nodes (expose an AT-SPI Action
// interface, usable by click/type/fill) from purely structural /
// presentational nodes that are only kept as expand targets for the
// `inspect` subcommand. Snapshots assign `eN` refs to action nodes and
// `xN` refs to expand-only group nodes; both share the same refs file
// so LookupRef resolves either transparently.
type RefKind string

const (
	// RefKindAction — node exposes AT-SPI Action / EditableText and is
	// a legal target for click/type/fill.
	RefKindAction RefKind = "action"
	// RefKindGroup — structural / presentational node with children
	// worth expanding on demand. Not a legal click/type target; the
	// host should route it to desktop_inspect instead.
	RefKindGroup RefKind = "group"
)

// RefEntry is one row in the persisted refs file. Fields must match
// the JSON tags exactly — the host (agentd) reads this file too when it
// wants to extract a bounding box for fallback path.
type RefEntry struct {
	RefID      string  `json:"ref_id"`
	BusName    string  `json:"bus_name"`
	ObjectPath string  `json:"object_path"`
	Role       string  `json:"role"`
	Name       string  `json:"name"`
	X          int32   `json:"x"`
	Y          int32   `json:"y"`
	Width      int32   `json:"width"`
	Height     int32   `json:"height"`
	Kind       RefKind `json:"kind,omitempty"`
	// ChildCount is the number of direct children at snapshot time,
	// surfaced in the snapshot line for group refs so the LLM can decide
	// whether an expand is worth it ("group 'Advanced' [ref=x12,
	// children=47]" vs "group 'Advanced' [ref=x12, children=0]").
	// Omitted for action refs where it carries no meaning.
	ChildCount int `json:"child_count,omitempty"`
}

// refIndex wraps an array of RefEntry for JSON marshalling.
type refIndex struct {
	Entries []RefEntry `json:"entries"`
}

// Center returns the bounding-box center, used as the xdotool fallback
// target when AT-SPI cannot reach the action (the host's desktop.Click
// injects via XTest on the Xvfb display). Uses saturating math so
// a 2^31-wide "extent" doesn't overflow.
func (r RefEntry) Center() (int32, int32) {
	cx := r.X + r.Width/2
	cy := r.Y + r.Height/2
	return cx, cy
}

// RefsPath resolves the on-disk refs file location. The env override is
// primarily for tests; production callers let it default.
func RefsPath() string {
	if p := os.Getenv("AGENTD_A11Y_REFS"); p != "" {
		return p
	}
	return DefaultRefsPath
}

// WriteRefs persists the snapshot's ref index, returning the path
// written. Creates parent directories as needed. The write is atomic:
// it marshals to a temp file in the same directory and renames over the
// target, so a concurrent LookupRef never observes a half-written file
// (snapshot runs concurrently with click/type/fill reads from agentd's
// workflow — a non-atomic WriteFile would let readers see truncated
// JSON and fail with a parse error instead of just reading the prior
// index).
func WriteRefs(entries []RefEntry) (string, error) {
	target := RefsPath()
	dir := filepath.Dir(target)
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create parent dir for %s: %w", target, err)
	}
	data, err := json.MarshalIndent(refIndex{Entries: entries}, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal refs index: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".refs-*.json.tmp")
	if err != nil {
		return "", fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return "", fmt.Errorf("write temp refs file %s: %w", tmpName, err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return "", fmt.Errorf("chmod temp refs file %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("close temp refs file %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, target); err != nil {
		return "", fmt.Errorf("rename %s -> %s: %w", tmpName, target, err)
	}
	cleanup = false
	return target, nil
}

// LookupRef reads the refs file and returns the entry whose RefID
// matches the (normalized) query. Accepts "e3", "E03", "ref=e3", "3".
func LookupRef(refID string) (RefEntry, error) {
	data, err := os.ReadFile(RefsPath())
	if err != nil {
		return RefEntry{}, fmt.Errorf("read refs index at %s: %w", RefsPath(), err)
	}
	var idx refIndex
	if err := json.Unmarshal(data, &idx); err != nil {
		return RefEntry{}, fmt.Errorf("parse refs index: %w", err)
	}
	want := NormalizeRef(refID)
	for _, e := range idx.Entries {
		if e.RefID == want {
			return e, nil
		}
	}
	return RefEntry{}, fmt.Errorf("ref %s not in %s (run `a11y-helper snapshot` first)", refID, RefsPath())
}

// readRefs reads and parses the current refs file. Returns an empty
// slice (no error) if the file does not yet exist, so callers can
// treat "no snapshot yet" uniformly with "empty snapshot".
func readRefs() ([]RefEntry, error) {
	data, err := os.ReadFile(RefsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var idx refIndex
	if err := json.Unmarshal(data, &idx); err != nil {
		return nil, fmt.Errorf("parse refs index: %w", err)
	}
	return idx.Entries, nil
}

// AppendRefs atomically appends new entries to the refs file, continuing
// the action/group ref counters from the highest existing eN / xN ids.
// Used by `inspect` to publish expanded subtree nodes so subsequent
// click/type/fill calls can resolve them by ref without re-querying.
//
// Returns the full updated entry list (existing + appended). If the
// refs file does not yet exist, it is created.
func AppendRefs(newEntries []RefEntry) ([]RefEntry, error) {
	existing, err := readRefs()
	if err != nil {
		return nil, err
	}
	combined := append(append([]RefEntry{}, existing...), newEntries...)
	if _, err := WriteRefs(combined); err != nil {
		return nil, err
	}
	return combined, nil
}

// nextRefCounters scans the entry list and returns the next available
// action (`eN`) and group (`xN`) counters — i.e. one past the highest
// existing id of each kind. Used by `inspect` so newly published nodes
// don't collide with refs handed out by an earlier snapshot.
func nextRefCounters(entries []RefEntry) (actionNext, groupNext int) {
	for _, e := range entries {
		var n int
		var ok bool
		if e.Kind == RefKindGroup {
			n, ok = parseRefNum(e.RefID, "x")
			if ok && n >= groupNext {
				groupNext = n + 1
			}
		} else {
			n, ok = parseRefNum(e.RefID, "e")
			if ok && n >= actionNext {
				actionNext = n + 1
			}
		}
	}
	return actionNext, groupNext
}

// parseRefNum extracts the trailing integer from an "eN" / "xN" ref id
// of the given prefix. Returns ok=false on any mismatch.
func parseRefNum(refID, prefix string) (int, bool) {
	if !strings.HasPrefix(refID, prefix) {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(refID, prefix))
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// NormalizeRef maps a user-typed ref id to the canonical "eN" / "xN"
// form. "e3" / "E03" / "ref=e3" / "3" / "REF=7" all collapse to "e3" /
// "e7". Inputs already carrying the expand prefix ("x12", "X12",
// "ref=x4") are preserved as "x12" / "x4". Inputs that don't parse as
// a positive integer are returned trimmed as-is (so a typo like "eb"
// still produces a sensible lookup miss).
func NormalizeRef(refID string) string {
	trimmed := strings.TrimSpace(refID)
	lower := strings.ToLower(trimmed)
	withoutPrefix := strings.TrimPrefix(lower, "ref=")
	if strings.HasPrefix(withoutPrefix, "x") {
		if n, err := strconv.Atoi(strings.TrimPrefix(withoutPrefix, "x")); err == nil && n > 0 {
			return fmt.Sprintf("x%d", n)
		}
	}
	withoutE := strings.TrimPrefix(withoutPrefix, "e")
	if n, strconvErr := strconv.Atoi(withoutE); strconvErr == nil && n > 0 {
		return fmt.Sprintf("e%d", n)
	}
	return trimmed
}
