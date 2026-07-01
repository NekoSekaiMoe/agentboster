// click / type / fill subcommands: drive AT-SPI actions for a ref.
//
// Every action returns a JSON envelope on stdout. If the AT-SPI call
// fails we still emit fallback:{x,y} (the bounding-box center from the
// persisted refs) so the agentd host can replay the action via
// xdotool/RFB. The "ok" field tells the host whether the AT-SPI path
// actually succeeded.

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/godbus/dbus/v5"
)

// actionOutput is the JSON envelope printed by click/type/fill.
type actionOutput struct {
	OK       bool       `json:"ok"`
	Action   string     `json:"action"`
	RefID    string     `json:"ref"`
	Detail   string     `json:"detail,omitempty"`
	Error    string     `json:"error,omitempty"`
	Fallback *fallback  `json:"fallback,omitempty"`
}

type fallback struct {
	X int32 `json:"x"`
	Y int32 `json:"y"`
}

func (o actionOutput) emit() error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(o)
}

func success(action string, entry refEntry, detail string) actionOutput {
	return actionOutput{OK: true, Action: action, RefID: entry.RefID, Detail: detail}
}

func failure(action string, entry refEntry, errMsg string) actionOutput {
	x, y := entry.center()
	return actionOutput{
		OK:       false,
		Action:   action,
		RefID:    entry.RefID,
		Error:    errMsg,
		Fallback: &fallback{X: x, Y: y},
	}
}

// runClick resolves ref, opens the a11y bus, finds the AT-SPI Action
// interface on the target, picks the most "click-like" action, and
// invokes it. On any failure, emits a fallback envelope.
func runClick(refID string) error {
	entry, err := lookupRef(refID)
	if err != nil {
		// Ref not in index — we cannot produce a fallback coordinate
		// either, so emit an error with no fallback. The host surfaces
		// this directly to the model.
		return emitError("click", refID, err.Error())
	}

	conn, err := openA11yBus()
	if err != nil {
		return emitFailureEnvelope("click", entry, fmt.Sprintf("open a11y bus: %v", err))
	}
	defer conn.Close()

	obj := &accessibleObj{
		conn: conn,
		name: entry.BusName,
		path: dbus.ObjectPath(entry.ObjectPath),
	}

	actions, err := obj.getActions()
	if err != nil {
		return emitFailureEnvelope("click", entry, fmt.Sprintf("GetActions: %v", err))
	}
	if len(actions) == 0 {
		return emitFailureEnvelope("click", entry, "the target element does not expose any AT-SPI actions")
	}

	idx := preferredActionIndex(actions)
	ok, err := obj.doAction(int32(idx))
	if err != nil {
		return emitFailureEnvelope("click", entry, fmt.Sprintf("DoAction: %v", err))
	}
	if !ok {
		return emitFailureEnvelope("click", entry, "AT-SPI reported the action did not run")
	}

	label := actions[idx].Name
	if label == "" {
		label = "click"
	}
	return success("click", entry, label).emit()
}

// runType inserts text at the caret. Falls back on failure.
func runType(refID, text string) error {
	entry, err := lookupRef(refID)
	if err != nil {
		return emitError("type", refID, err.Error())
	}

	conn, err := openA11yBus()
	if err != nil {
		return emitFailureEnvelope("type", entry, fmt.Sprintf("open a11y bus: %v", err))
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
		return emitFailureEnvelope("type", entry, fmt.Sprintf("InsertText: %v", err))
	}
	if !ok {
		return emitFailureEnvelope("type", entry, "editable text widget refused to insert")
	}
	return success("type", entry, fmt.Sprintf("inserted %d chars", utf8.RuneCountInString(text))).emit()
}

// runFill replaces the entire content of the editable widget. Useful
// when the model wants to overwrite rather than append.
func runFill(refID, text string) error {
	entry, err := lookupRef(refID)
	if err != nil {
		return emitError("fill", refID, err.Error())
	}

	conn, err := openA11yBus()
	if err != nil {
		return emitFailureEnvelope("fill", entry, fmt.Sprintf("open a11y bus: %v", err))
	}
	defer conn.Close()

	obj := &accessibleObj{
		conn: conn,
		name: entry.BusName,
		path: dbus.ObjectPath(entry.ObjectPath),
	}

	ok, err := obj.setTextContents(text)
	if err != nil {
		return emitFailureEnvelope("fill", entry, fmt.Sprintf("SetTextContents: %v", err))
	}
	if !ok {
		return emitFailureEnvelope("fill", entry, "editable text widget refused to replace contents")
	}
	return success("fill", entry, fmt.Sprintf("set %d chars", utf8.RuneCountInString(text))).emit()
}

// preferredActionIndex picks the most "click-like" action by name. This
// mirrors memoh action.rs:preferred_action_index — case-insensitive
// substring match in priority order: click > press > activate > first.
func preferredActionIndex(actions []actionDescriptor) int {
	priorities := []string{"click", "press", "activate"}
	for _, p := range priorities {
		for i, a := range actions {
			if strings.Contains(strings.ToLower(a.Name), p) {
				return i
			}
		}
	}
	return 0
}

// emitFailureEnvelope is a small wrapper that produces a failure
// envelope for the given ref (with fallback coordinates) and writes it
// to stdout. It does NOT return the envelope, so callers can `return
// emitFailureEnvelope(...)` directly from a run* function.
func emitFailureEnvelope(action string, entry refEntry, errMsg string) error {
	return failure(action, entry, errMsg).emit()
}

// emitError is used when the ref itself cannot be resolved — there is
// no entry to derive fallback coordinates from, so we emit a plain
// error envelope with no fallback field.
func emitError(action, refID, errMsg string) error {
	return actionOutput{
		OK:     false,
		Action: action,
		RefID:  refID,
		Error:  errMsg,
	}.emit()
}
