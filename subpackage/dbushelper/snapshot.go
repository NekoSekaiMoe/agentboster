// Package dbushelper — snapshot subcommand: walk the AT-SPI2 desktop
// tree, assign short `eN` refs to on-screen nodes, persist the index,
// and return a JSON envelope with both machine-readable items and
// LLM-friendly text lines.
//
// The walk is iterative (DFS via a stack), capped at maxVisits nodes
// inspected and maxApps top-level applications entered. Aggressive caps
// are needed because AT-SPI trees can balloon — LibreOffice Calc
// exposes ~2^31 cells per sheet, and a careless traversal would hang.

package dbushelper

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/godbus/dbus/v5"
)

const (
	maxApps      = 32   // max top-level apps to descend into
	maxVisits    = 8000 // max nodes inspected across the entire walk
	DefaultLimit = 300  // default cap on accepted (returned) nodes
)

// SnapshotOutput is the JSON envelope returned by RunSnapshot. Mirrors
// memoh's SnapshotOutput shape so the agentd Go shim can be structurally
// identical to memoh's computer_a11y.go consumer.
type SnapshotOutput struct {
	OK          bool           `json:"ok"`
	Truncated   bool           `json:"truncated"`
	Items       []SnapshotItem `json:"items"`
	Lines       []string       `json:"lines"`
	RefsPath    string         `json:"refs_path"`
	Diagnostics Diagnostics    `json:"diagnostics"`
}

type SnapshotItem struct {
	RefID  string   `json:"ref_id"`
	Role   string   `json:"role"`
	Name   string   `json:"name"`
	X      int32    `json:"x"`
	Y      int32    `json:"y"`
	Width  int32    `json:"width"`
	Height int32    `json:"height"`
	States []string `json:"states,omitempty"`
}

type Diagnostics struct {
	Apps            int    `json:"apps"`
	Visited         int    `json:"visited"`
	Accepted        int    `json:"accepted"`
	SkippedState    int    `json:"skipped_state"`
	SkippedRole     int    `json:"skipped_role"`
	SkippedGeometry int    `json:"skipped_geometry"`
	Errors          int    `json:"errors"`
	BusAddress      string `json:"bus_address,omitempty"`
	Display         string `json:"display,omitempty"`
}

// RunSnapshot connects to the a11y bus, walks the tree, persists refs,
// and returns the assembled envelope. Caller is responsible for
// serializing it (JSON or otherwise) — this function has no side
// effects beyond writing the refs file.
func RunSnapshot(limit int) (*SnapshotOutput, error) {
	if limit <= 0 {
		limit = DefaultLimit
	}

	conn, err := OpenBus()
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	busAddr := os.Getenv("AT_SPI_BUS_ADDRESS")
	display := os.Getenv("DISPLAY")

	entries, truncated, diag, err := collectSnapshot(conn, limit, busAddr, display)
	if err != nil {
		return nil, err
	}

	refsPath, err := WriteRefs(entries)
	if err != nil {
		return nil, err
	}

	// Build text lines + structured items from the same entries.
	lines := make([]string, len(entries))
	items := make([]SnapshotItem, len(entries))
	for i, e := range entries {
		lines[i] = FormatLine(e)
		items[i] = SnapshotItem{
			RefID: e.RefID, Role: e.Role, Name: e.Name,
			X: e.X, Y: e.Y, Width: e.Width, Height: e.Height,
		}
	}

	return &SnapshotOutput{
		OK: true, Truncated: truncated,
		Items: items, Lines: lines,
		RefsPath: refsPath, Diagnostics: diag,
	}, nil
}

// collectSnapshot drives the DFS. Returns the accepted entries plus
// diagnostics for the envelope. The error return is reserved for
// catastrophic failures (cannot reach registry); per-node errors bump
// diag.Errors and the walk continues.
func collectSnapshot(conn *dbus.Conn, limit int, busAddr, display string) ([]RefEntry, bool, Diagnostics, error) {
	diag := Diagnostics{BusAddress: busAddr, Display: display}

	// Root: org.a11y.atspi.Registry at /org/a11y/atspi/registry on the
	// a11y bus. Its children are the connected applications.
	registry := &accessibleObj{
		conn: conn,
		name: "org.a11y.atspi.Registry",
		path: registryPath,
	}
	appRefs, err := registry.getChildren()
	if err != nil {
		return nil, false, diag, fmt.Errorf("get registry children: %w", err)
	}
	diag.Apps = len(appRefs)

	var entries []RefEntry
	truncated := false

	// Cap the number of top-level apps; iterate in order.
	appLimit := len(appRefs)
	if appLimit > maxApps {
		appLimit = maxApps
	}

	for appIdx := 0; appIdx < appLimit; appIdx++ {
		if len(entries) >= limit {
			truncated = true
			break
		}
		appObj := appRefs[appIdx].asObj(conn)
		// Iterative DFS — push children in reverse so they pop in order.
		stack := []*accessibleObj{appObj}
		for len(stack) > 0 {
			node := stack[len(stack)-1]
			stack = stack[:len(stack)-1]

			if len(entries) >= limit {
				truncated = true
				break
			}
			if diag.Visited >= maxVisits {
				truncated = true
				break
			}
			diag.Visited++

			entry, outcome := describe(node, len(entries)+1)
			switch outcome {
			case outcomeKeep:
				diag.Accepted++
				entries = append(entries, entry)
			case outcomeSkipState:
				diag.SkippedState++
			case outcomeSkipRole:
				diag.SkippedRole++
			case outcomeSkipGeometry:
				diag.SkippedGeometry++
			case outcomeError:
				diag.Errors++
			}

			// Expand children even if the node itself was filtered, so
			// descendants of a structural/Application node still get a
			// chance to surface.
			children, err := node.getChildren()
			if err != nil {
				diag.Errors++
				continue
			}
			// Push in reverse so the DFS visits left-to-right on pop.
			for i := len(children) - 1; i >= 0; i-- {
				stack = append(stack, children[i].asObj(conn))
			}
		}
	}

	return entries, truncated, diag, nil
}

// describeOutcome reports what happened for one node.
type describeOutcome int

const (
	outcomeKeep describeOutcome = iota
	outcomeSkipState
	outcomeSkipRole
	outcomeSkipGeometry
	outcomeError
)

// describe inspects one node and returns either a RefEntry to keep or
// a skip reason. Mirrors memoh's snapshot.rs::describe.
func describe(node *accessibleObj, nextIndex int) (RefEntry, describeOutcome) {
	states, err := node.getStates()
	if err != nil {
		return RefEntry{}, outcomeError
	}
	if !IsOnScreen(states) {
		return RefEntry{}, outcomeSkipState
	}
	role, err := node.getRole()
	if err != nil {
		return RefEntry{}, outcomeError
	}
	if RoleIsStructural(role) {
		return RefEntry{}, outcomeSkipRole
	}

	roleName, _ := node.getRoleName()
	if roleName == "" {
		// Fall back to a lowercase numeric form so the snapshot line
		// isn't empty for toolkits that don't implement GetRoleName.
		roleName = fmt.Sprintf("role_%d", role)
	}
	name, _ := node.getName()

	// Geometry is best-effort: missing extents (popups, virtual
	// children) are still useful when the node exposes a name.
	x, y, w, h, _ := node.getExtents()

	// If both geometry and name are empty, the node carries no info the
	// model can act on. Skip it to keep the snapshot focused.
	if w <= 0 && h <= 0 && name == "" {
		return RefEntry{}, outcomeSkipGeometry
	}

	return RefEntry{
		RefID:      fmt.Sprintf("e%d", nextIndex),
		BusName:    string(node.name),
		ObjectPath: string(node.path),
		Role:       roleName,
		Name:       name,
		X:          x, Y: y, Width: w, Height: h,
	}, outcomeKeep
}

// FormatLine renders one RefEntry as the text line delivered to the
// LLM:
//
//	- push button "Reload" [ref=e3] @120,80 28x28
//
// Mirrors memoh snapshot.rs::format_line — keep field order identical
// so prompt templates translate 1:1.
func FormatLine(e RefEntry) string {
	line := "- " + e.Role
	if name := strings.TrimSpace(e.Name); name != "" {
		line += " " + JsonQuote(name)
	}
	line += fmt.Sprintf(" [ref=%s]", e.RefID)
	if e.Width > 0 && e.Height > 0 {
		line += fmt.Sprintf(" @%d,%d %dx%d", e.X, e.Y, e.Width, e.Height)
	}
	return line
}

// JsonQuote returns a JSON-quoted version of s (so names with quotes /
// backslashes / control chars round-trip cleanly when the LLM sees them
// embedded in plain text).
func JsonQuote(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return strconv.Quote(s)
	}
	return string(b)
}
