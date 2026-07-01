// Package dbushelper — click / type / fill actions for a ref.
//
// Every action returns an ActionOutput data structure. If the AT-SPI
// call fails, the output still carries a Fallback coordinate (the
// bounding-box center from the persisted refs) so the caller can
// replay the action via xdotool (XTest injection on the Xvfb display).
// The OK field tells the caller whether the AT-SPI path actually succeeded.

package dbushelper

import (
	"fmt"
	"unicode/utf8"

	"github.com/godbus/dbus/v5"
)

// ActionOutput is the structured result of Click/Type/Fill.
type ActionOutput struct {
	OK       bool      `json:"ok"`
	Action   string    `json:"action"`
	RefID    string    `json:"ref"`
	Detail   string    `json:"detail,omitempty"`
	Error    string    `json:"error,omitempty"`
	Fallback *Fallback `json:"fallback,omitempty"`
}

// Fallback carries the (x, y) the caller should replay the action
// against when AT-SPI could not reach the target (e.g. a raw-X11 widget
// with no AT-SPI action interface).
type Fallback struct {
	X int32 `json:"x"`
	Y int32 `json:"y"`
}

func success(action string, entry RefEntry, detail string) ActionOutput {
	return ActionOutput{OK: true, Action: action, RefID: entry.RefID, Detail: detail}
}

func failure(action string, entry RefEntry, errMsg string) ActionOutput {
	x, y := entry.Center()
	return ActionOutput{
		OK:       false,
		Action:   action,
		RefID:    entry.RefID,
		Error:    errMsg,
		Fallback: &Fallback{X: x, Y: y},
	}
}

// RunClick resolves ref, opens the a11y bus, finds the AT-SPI Action
// interface on the target, picks the most "click-like" action, and
// invokes it. On any failure, returns an ActionOutput carrying fallback
// coordinates.
func RunClick(refID string) (ActionOutput, error) {
	entry, err := LookupRef(refID)
	if err != nil {
		// Ref not in index — we cannot produce a fallback coordinate
		// either, so return a plain error envelope with no fallback.
		return ActionOutput{
			OK: false, Action: "click", RefID: refID, Error: err.Error(),
		}, nil
	}

	conn, err := OpenBus()
	if err != nil {
		return failure("click", entry, fmt.Sprintf("open a11y bus: %v", err)), nil
	}
	defer conn.Close()

	obj := &accessibleObj{
		conn: conn,
		name: entry.BusName,
		path: dbus.ObjectPath(entry.ObjectPath),
	}

	actions, err := obj.getActions()
	if err != nil {
		return failure("click", entry, fmt.Sprintf("GetActions: %v", err)), nil
	}
	if len(actions) == 0 {
		return failure("click", entry, "the target element does not expose any AT-SPI actions"), nil
	}

	idx := PreferredActionIndex(actions)
	ok, err := obj.doAction(int32(idx))
	if err != nil {
		return failure("click", entry, fmt.Sprintf("DoAction: %v", err)), nil
	}
	if !ok {
		return failure("click", entry, "AT-SPI reported the action did not run"), nil
	}

	label := actions[idx].Name
	if label == "" {
		label = "click"
	}
	return success("click", entry, label), nil
}

// RunType inserts text at the caret. Falls back on failure.
func RunType(refID, text string) (ActionOutput, error) {
	entry, err := LookupRef(refID)
	if err != nil {
		return ActionOutput{
			OK: false, Action: "type", RefID: refID, Error: err.Error(),
		}, nil
	}

	conn, err := OpenBus()
	if err != nil {
		return failure("type", entry, fmt.Sprintf("open a11y bus: %v", err)), nil
	}
	defer conn.Close()

	obj := &accessibleObj{
		conn: conn,
		name: entry.BusName,
		path: dbus.ObjectPath(entry.ObjectPath),
	}

	caret, err := obj.caretOffset()
	if err != nil {
		caret = -1
	}
	position := caret
	if position < 0 {
		position = 0
	}

	ok, err := obj.insertText(position, text)
	if err != nil {
		return failure("type", entry, fmt.Sprintf("InsertText: %v", err)), nil
	}
	if !ok {
		return failure("type", entry, "editable text widget refused to insert"), nil
	}
	return success("type", entry, fmt.Sprintf("inserted %d chars", utf8.RuneCountInString(text))), nil
}

// RunFill replaces the entire content of the editable widget. Useful
// when the model wants to overwrite rather than append.
func RunFill(refID, text string) (ActionOutput, error) {
	entry, err := LookupRef(refID)
	if err != nil {
		return ActionOutput{
			OK: false, Action: "fill", RefID: refID, Error: err.Error(),
		}, nil
	}

	conn, err := OpenBus()
	if err != nil {
		return failure("fill", entry, fmt.Sprintf("open a11y bus: %v", err)), nil
	}
	defer conn.Close()

	obj := &accessibleObj{
		conn: conn,
		name: entry.BusName,
		path: dbus.ObjectPath(entry.ObjectPath),
	}

	ok, err := obj.setTextContents(text)
	if err != nil {
		return failure("fill", entry, fmt.Sprintf("SetTextContents: %v", err)), nil
	}
	if !ok {
		return failure("fill", entry, "editable text widget refused to replace contents"), nil
	}
	return success("fill", entry, fmt.Sprintf("set %d chars", utf8.RuneCountInString(text))), nil
}

// PreferredActionIndex picks the most "click-like" action by name. This
// mirrors memoh action.rs:preferred_action_index — case-insensitive
// substring match in priority order: click > press > activate > first.
func PreferredActionIndex(actions []ActionDescriptor) int {
	for _, p := range []string{"click", "press", "activate"} {
		for i, a := range actions {
			if containsLower(a.Name, p) {
				return i
			}
		}
	}
	return 0
}

// containsLower reports whether lowercased name contains the (already
// lowercase) substring sub. Pulled out so the test can exercise it
// directly without reaching into strings (keeping the import surface
// tight).
func containsLower(name, sub string) bool {
	if len(name) < len(sub) {
		return false
	}
	for i := 0; i+len(sub) <= len(name); i++ {
		match := true
		for j := 0; j < len(sub); j++ {
			c := name[i+j]
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != sub[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// InspectOutput is the structured result of RunInspect. It returns the
// expanded subtree (tiered lines + structured items, same shape as a
// snapshot) plus the parent ref the LLM asked to drill into. Newly
// discovered action/group refs are appended to the main refs file so
// the next click/type/fill call can resolve them by id.
type InspectOutput struct {
	OK        bool           `json:"ok"`
	Parent    string         `json:"parent_ref"`
	ParentRol string         `json:"parent_role,omitempty"`
	Truncated bool           `json:"truncated"`
	Items     []SnapshotItem `json:"items"`
	Lines     []string       `json:"lines"`
	Diagnostics Diagnostics  `json:"diagnostics"`
}

// RunInspect expands the subtree of a previously snapshotted ref. The
// ref may be either an action ref (`eN`) or a group ref (`xN`); in both
// cases the (bus_name, object_path) from the persisted index is used
// as the DFS root. The walk is capped by InspectLimit so an inspect
// call never re-traverses the whole desktop.
//
// Newly discovered descendants are assigned fresh `eN` / `xN` refs
// (continuing the counters from the existing index) and appended to the
// refs file, so the LLM can immediately click/type them by id without
// another lookup round-trip.
//
// If the parent ref is unknown / stale, returns an envelope with OK=false
// and an error string. The LLM should re-run `snapshot` in that case.
func RunInspect(refID string) (InspectOutput, error) {
	entry, err := LookupRef(refID)
	if err != nil {
		return InspectOutput{OK: false, Parent: refID, Diagnostics: Diagnostics{Errors: 0}}, nil
	}

	conn, err := OpenBus()
	if err != nil {
		return InspectOutput{
			OK: false, Parent: entry.RefID, ParentRol: entry.Role,
			Diagnostics: Diagnostics{},
		}, fmt.Errorf("open a11y bus: %w", err)
	}
	defer conn.Close()

	root := &accessibleObj{
		conn: conn,
		name: entry.BusName,
		path: dbus.ObjectPath(entry.ObjectPath),
	}

	// Carry the existing refs so the appended entries continue the
	// action/group counters from the highest id already published.
	existing, err := readRefs()
	if err != nil {
		return InspectOutput{}, fmt.Errorf("read existing refs: %w", err)
	}
	actionCounter, groupCounter := nextRefCounters(existing)

	items, lines, diag, truncated, err := inspectSubtree(root, InspectLimit, &actionCounter, &groupCounter)
	if err != nil {
		return InspectOutput{}, err
	}

	// Publish newly discovered nodes (entries returned by inspectSubtree
	// are exactly the new ones) so click/type can resolve them.
	if len(items) > 0 {
		newEntries := make([]RefEntry, len(items))
		for i, it := range items {
			// Reconstruct the RefEntry from the item snapshot — we lost
			// the (bus_name, object_path) pair when building the item,
			// so re-walk is not an option; capture them in inspectSubtree.
			newEntries[i] = it.refEntry
		}
		if _, err := AppendRefs(newEntries); err != nil {
			return InspectOutput{}, fmt.Errorf("publish inspect refs: %w", err)
		}
	}

	out := InspectOutput{
		OK:          true,
		Parent:      entry.RefID,
		ParentRol:   entry.Role,
		Truncated:   truncated,
		Items:       toSnapshotItems(items),
		Lines:       lines,
		Diagnostics: diag,
	}
	return out, nil
}

// inspectSubtreeDesc is an internal carrier pairing a SnapshotItem
// with the full RefEntry (which carries bus_name + object_path, lost
// when projecting to SnapshotItem). It only lives long enough to be
// appended to the refs file.
type inspectSubtreeDesc struct {
	item    SnapshotItem
	refEntry RefEntry
}

// toSnapshotItems projects the internal carrier slice to the public
// SnapshotItem shape, dropping the refEntry side-channel.
func toSnapshotItems(descs []inspectSubtreeDesc) []SnapshotItem {
	out := make([]SnapshotItem, len(descs))
	for i, d := range descs {
		out[i] = d.item
	}
	return out
}

// inspectSubtree performs a capped iterative DFS starting at root,
// applies the same tiered describe logic as the top-level snapshot,
// and returns ready-to-publish descriptors + the LLM-facing text lines.
func inspectSubtree(root *accessibleObj, limit int, actionCounter, groupCounter *int) ([]inspectSubtreeDesc, []string, Diagnostics, bool, error) {
	diag := Diagnostics{}
	if limit <= 0 {
		limit = InspectLimit
	}
	var descs []inspectSubtreeDesc
	var lines []string
	truncated := false

	stack := []*accessibleObj{root}
	for len(stack) > 0 {
		node := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		if len(descs) >= limit {
			truncated = true
			break
		}
		if diag.Visited >= InspectLimit {
			truncated = true
			break
		}
		diag.Visited++

		children, childErr := node.getChildren()
		entry, outcome := describe(node, children, actionCounter, groupCounter)
		switch outcome {
		case outcomeKeep:
			diag.Accepted++
			descs = append(descs, inspectSubtreeDesc{
				item: SnapshotItem{
					RefID: entry.RefID, Role: entry.Role, Name: entry.Name,
					X: entry.X, Y: entry.Y, Width: entry.Width, Height: entry.Height,
					Kind: entry.Kind, ChildCount: entry.ChildCount,
				},
				refEntry: entry,
			})
			lines = append(lines, FormatLine(entry))
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
		// Same stack-depth guard as the top-level walk.
		room := maxStack - len(stack)
		if room < len(children) {
			children = children[:max(0, room)]
			truncated = true
		}
		for i := len(children) - 1; i >= 0; i-- {
			stack = append(stack, children[i].asObj(root.conn))
		}
	}
	return descs, lines, diag, truncated, nil
}
