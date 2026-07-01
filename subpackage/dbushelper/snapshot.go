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
	maxStack     = 4000 // max pending nodes on the DFS stack; bounds memory on wide trees (LibreOffice exposes wide sibling lists) where visited/limit caps lag the push rate
	DefaultLimit = 300  // default cap on accepted (returned) nodes
	// InspectLimit caps the per-call subtree DFS performed by RunInspect
	// (the `inspect` subcommand). Set lower than maxVisits because
	// inspect is meant to be a cheap "drill into one branch" call — if
	// the subtree is still too big to enumerate the LLM should pick a
	// narrower ref.
	InspectLimit = 200
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
	RefID      string   `json:"ref_id"`
	Role       string   `json:"role"`
	Name       string   `json:"name"`
	X          int32    `json:"x"`
	Y          int32    `json:"y"`
	Width      int32    `json:"width"`
	Height     int32    `json:"height"`
	Kind       RefKind  `json:"kind,omitempty"`
	ChildCount int      `json:"child_count,omitempty"`
	States     []string `json:"states,omitempty"`
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
			Kind: e.Kind, ChildCount: e.ChildCount,
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
	// Dual counters: action nodes (button/entry/menu item/...) get an
	// `eN` ref and a full line, while presentational nodes (panel,
	// label, grouping) get an `xN` ref + a folded line that hides their
	// subtree from the snapshot output. The subtree is still walked so
	// deep action nodes surface; only the snapshot line for the group
	// is collapsed — the LLM expands it on demand via `inspect <xN>`.
	actionCounter := 0
	groupCounter := 0

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

			// Probe children BEFORE deciding the node's kind: we need the
			// direct child count to render the folded line for groups.
			// Children are then re-used for the stack push below.
			children, childErr := node.getChildren()
			entry, outcome := describe(node, children, &actionCounter, &groupCounter)
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

			if childErr != nil {
				diag.Errors++
				continue
			}
			// Push in reverse so the DFS visits left-to-right on pop.
			// Guard the stack depth so a pathological wide tree (e.g.
			// LibreOffice) cannot balloon memory before maxVisits catches
			// up — drop further pushes once we hit maxStack and mark the
			// walk truncated.
			room := maxStack - len(stack)
			if room < len(children) {
				children = children[:max(0, room)]
				truncated = true
			}
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
//
// The caller passes the already-fetched direct children so we can
// (a) avoid a second D-Bus round-trip and (b) stamp the group line
// with an accurate child count without re-querying. actionCounter /
// groupCounter are bumped in place; their current values select the
// ref id (`eN` for action, `xN` for group).
func describe(node *accessibleObj, children []childRef, actionCounter, groupCounter *int) (RefEntry, describeOutcome) {
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

	childCount := len(children)
	// Tier assignment: interactive roles become action nodes (full line,
	// legal click/type target), everything else becomes a group node
	// (folded line, expand-only via `inspect`). See RoleIsInteractive
	// for the rationale behind the role list.
	if RoleIsInteractive(role) {
		*actionCounter++
		return RefEntry{
			RefID:      fmt.Sprintf("e%d", *actionCounter),
			BusName:    string(node.name),
			ObjectPath: string(node.path),
			Role:       roleName,
			Name:       name,
			X:          x, Y: y, Width: w, Height: h,
			Kind:       RefKindAction,
			ChildCount: childCount,
		}, outcomeKeep
	}
	*groupCounter++
	return RefEntry{
		RefID:      fmt.Sprintf("x%d", *groupCounter),
		BusName:    string(node.name),
		ObjectPath: string(node.path),
		Role:       roleName,
		Name:       name,
		X:          x, Y: y, Width: w, Height: h,
		Kind:       RefKindGroup,
		ChildCount: childCount,
	}, outcomeKeep
}

// FormatLine renders one RefEntry as the text line delivered to the
// LLM:
//
//	- push button "Reload" [ref=e3] @120,80 28x28
//
// For group (presentational) refs the subtree is folded away and the
// line surfaces a child count + an expand hint instead, so the LLM
// pays for the subtree only when it actually wants to drill in:
//
//	- panel "Advanced settings" [ref=x7, children=47, inspect to expand] @20,30 600x400
//
// Mirrors memoh snapshot.rs::format_line for the action-line shape —
// keep field order identical so prompt templates translate 1:1. The
// group-line shape is agentboster-specific (no memoh equivalent).
func FormatLine(e RefEntry) string {
	line := "- " + e.Role
	if name := strings.TrimSpace(e.Name); name != "" {
		line += " " + JsonQuote(name)
	}
	if e.Kind == RefKindGroup {
		line += fmt.Sprintf(" [ref=%s, children=%d, inspect to expand]", e.RefID, e.ChildCount)
	} else {
		line += fmt.Sprintf(" [ref=%s]", e.RefID)
	}
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
