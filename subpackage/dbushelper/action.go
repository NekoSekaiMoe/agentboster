// Package dbushelper — click / type / fill actions for a ref.
//
// Every action returns an ActionOutput data structure. If the AT-SPI
// call fails, the output still carries a Fallback coordinate (the
// bounding-box center from the persisted refs) so the caller can
// replay the action via xdotool/RFB. The OK field tells the caller
// whether the AT-SPI path actually succeeded.

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
