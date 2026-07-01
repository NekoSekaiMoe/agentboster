// Package dbushelper is a small pure-Go client for the AT-SPI2
// accessibility D-Bus registry. It runs INSIDE the agentd sandbox (NOT
// on the host) and is consumed by:
//
//   - cmd/a11y-helper (a thin CLI that wraps this package for cross-
//     container exec via sbMgr.Exec)
//   - the agentd tool layer directly, when in-process calls are wanted
//
// This file defines the AT-SPI2 D-Bus surface we talk to. There is no
// Go AT-SPI binding (unlike Rust's `atspi` crate); godbus provides the
// raw D-Bus primitives and we hand-roll the small subset of the
// org.a11y.atspi interfaces we need:
//
//   - org.a11y.atspi.Accessible (role, name, children, state)
//   - org.a11y.atspi.Component   (bounding box)
//   - org.a11y.atspi.Action      (DoAction for clicks)
//   - org.a11y.atspi.EditableText (InsertText / SetTextContents)
//   - org.a11y.atspi.Text        (caret offset)
//
// Reference: https://gitlab.gnome.org/GNOME/at-spi2-core (atspi/atspi-*.xml
// introspection). The numeric Role values are frozen by libatk ABI.

package dbushelper

import (
	"errors"

	"github.com/godbus/dbus/v5"
)

// ErrInvalidReply is returned when an AT-SPI method reply does not match
// the expected D-Bus signature. godbus decodes signatures at runtime,
// and a toolkit that emits a malformed reply should not crash the walk.
var ErrInvalidReply = errors.New("dbushelper: invalid AT-SPI reply signature")

const (
	// AT-SPI bus service + well-known objects.
	a11yService       = "org.a11y.Bus"
	a11yGetAddrMethod = "org.a11y.Bus.GetAddress"

	// The registry sits on the a11y bus under this path; its first
	// child level is the connected applications (each app is its own
	// unique D-Bus name exposing org.a11y.atspi.Accessible).
	registryPath = "/org/a11y/atspi/registry"
	registryIfc  = "org.a11y.atspi.Registry"

	// Per-object AT-SPI interfaces.
	ifaceAccessible   = "org.a11y.atspi.Accessible"
	ifaceComponent    = "org.a11y.atspi.Component"
	ifaceAction       = "org.a11y.atspi.Action"
	ifaceEditableText = "org.a11y.atspi.EditableText"
	ifaceText         = "org.a11y.atspi.Text"

	// CoordType.Screen — bounding boxes in absolute screen coords.
	// (The alternative, CoordType.Window, is relative to the toplevel
	// window, which is useless for cross-app snapshot consumers.)
	coordScreen = 0
)

// AT-SPI Role enum — only the entries we need for structural filtering.
// Values must match atspi-enum-types.h (libatk ABI frozen).
const (
	RoleInvalidRole  = 0
	RoleUnknown      = 1
	RoleFiller       = 47
	RoleSeparator    = 56
	RoleApplication  = 5
	RoleDesktopFrame = 17
	RoleDesktopIcon  = 16
)

// Interactive roles — nodes that typically expose an AT-SPI Action or
// EditableText interface and therefore are legal targets for click /
// type / fill. RoleIsInteractive drives the tiered snapshot: action
// nodes get an `eN` ref and a full FormatLine; non-action presentational
// nodes (panels, labels, groupings) only get an `xN` expand ref + a
// folded child-count line, so the LLM can decide whether to call
// `inspect <xN>` for the subtree rather than paying for the whole tree
// up front.
//
// The list is conservative on purpose: when in doubt we treat a node as
// a group (costs one extra inspect round-trip) rather than as an action
// (which would let click/type target something that cannot react and
// silently fall back to xdotool coordinates).
func RoleIsInteractive(role uint32) bool {
	switch role {
	case 4,    // toggle button
		5,  // — Application: filtered as structural, never reaches here
		7,  // check box
		8,  // check menu item
		9,  // color chooser
		10, // combo box
		12, // drawing area (interactive canvas)
		14, // entry / text field
		22, // list
		24, // menu
		25, // menu item
		28, // password text
		29, // push button
		30, // radio button
		31, // radio menu item
		36, // spin button
		40, // table
		42, // table cell (clickable in most toolkits)
		43, // text
		44, // toggle button (dup of 4 in some toolkits; both kept)
		46, // tree / tree table
		61: // link
		return true
	}
	return false
}

// RoleIsStructural mirrors memoh's role blacklist: pure structural noise
// whose subtrees are still walked (we filter the node itself, not its
// descendants).
func RoleIsStructural(role uint32) bool {
	switch role {
	case RoleInvalidRole, RoleUnknown, RoleFiller, RoleSeparator,
		RoleApplication, RoleDesktopFrame, RoleDesktopIcon:
		return true
	}
	return false
}

// AT-SPI State enum bit numbers. The full set lives in atspi-state-set.c;
// we only need the two visibility flags used by IsOnScreen.
const (
	StateShowing = 28 // "showing" — currently painted on screen
	StateVisible = 30 // "visible" — will be painted when its parent is
)

// IsOnScreen accepts either Showing or Visible. GTK apps set both,
// Chromium sets only Showing — accepting either avoids false negatives
// (mirrors memoh snapshot.rs:261-267).
func IsOnScreen(states []uint32) bool {
	for _, s := range states {
		if s == StateShowing || s == StateVisible {
			return true
		}
	}
	return false
}

// accessibleObj is a thin wrapper over a dbus.BusObject pointing at an
// AT-SPI accessible. We deliberately keep it as a struct of (conn, name,
// path) rather than caching a BusObject so we can rebuild the proxy
// cheaply for any of the four interfaces without round-tripping through
// introspection.
type accessibleObj struct {
	conn *dbus.Conn
	name string
	path dbus.ObjectPath
}

func (a *accessibleObj) call(iface, method string, args ...any) ([]any, error) {
	obj := a.conn.Object(a.name, a.path)
	call := obj.Call(iface+"."+method, 0, args...)
	if call.Err != nil {
		return nil, call.Err
	}
	// godbus returns reply values via Store; we collect them into a
	// generic []any so each typed helper can decode what it actually
	// needs. Methods that return nothing get an empty slice.
	out := make([]any, 0, len(call.Body))
	for _, v := range call.Body {
		out = append(out, v)
	}
	return out, nil
}

// Accessible interface.

// GetChildAtIndex wraps org.a11y.atspi.Accessible.GetChildAtIndex. The
// AT-SPI wire format returns a (ssv) of (bus_name, object_path, props)
// per child — but in practice we always go through GetChildren and get
// an array of those, so this helper is only used defensively.
func (a *accessibleObj) getChildAtIndex(i int32) (string, dbus.ObjectPath, error) {
	out, err := a.call(ifaceAccessible, "GetChildAtIndex", i)
	if err != nil {
		return "", "", err
	}
	if len(out) < 1 {
		return "", "", ErrInvalidReply
	}
	// AT-SPI returns an (so) struct as a variant; godbus decodes the
	// struct itself into a []any.
	v, ok := out[0].([]any)
	if !ok || len(v) < 2 {
		return "", "", ErrInvalidReply
	}
	name, _ := v[0].(string)
	path, _ := v[1].(dbus.ObjectPath)
	return name, path, nil
}

// getChildren returns all child references as (bus_name, object_path)
// pairs. AT-SPI exposes GetChildren returning a(so) — array of
// (bus_name, object_path) structs.
func (a *accessibleObj) getChildren() ([]childRef, error) {
	out, err := a.call(ifaceAccessible, "GetChildren")
	if err != nil {
		return nil, err
	}
	if len(out) < 1 {
		return nil, ErrInvalidReply
	}
	arr, ok := out[0].([]any)
	if !ok {
		return nil, ErrInvalidReply
	}
	children := make([]childRef, 0, len(arr))
	for _, raw := range arr {
		entry, ok := raw.([]any)
		if !ok || len(entry) < 2 {
			continue
		}
		name, _ := entry[0].(string)
		path, _ := entry[1].(dbus.ObjectPath)
		if name == "" || path == "" {
			continue
		}
		children = append(children, childRef{name: name, path: path})
	}
	return children, nil
}

// getRole returns the numeric AT-SPI role enum.
func (a *accessibleObj) getRole() (uint32, error) {
	out, err := a.call(ifaceAccessible, "GetRole")
	if err != nil {
		return 0, err
	}
	if len(out) < 1 {
		return 0, ErrInvalidReply
	}
	role, _ := out[0].(uint32)
	return role, nil
}

// getRoleName returns the human-readable role name ("push button",
// "entry", "label"…). Used verbatim in the snapshot line so the model
// sees recognizable widget classes.
func (a *accessibleObj) getRoleName() (string, error) {
	out, err := a.call(ifaceAccessible, "GetRoleName")
	if err != nil {
		return "", err
	}
	if len(out) < 1 {
		return "", ErrInvalidReply
	}
	name, _ := out[0].(string)
	return name, nil
}

// getName returns the accessible name (the string the screen reader
// would announce). Computed by the toolkit from aria-label / <label>
// / <label for> / title / textContent — we trust it.
func (a *accessibleObj) getName() (string, error) {
	out, err := a.call(ifaceAccessible, "GetName")
	if err != nil {
		return "", err
	}
	if len(out) < 1 {
		return "", ErrInvalidReply
	}
	name, _ := out[0].(string)
	return name, nil
}

// getStates returns the AT-SPI state bit array. The wire format is an
// (au) struct of two uint32 arrays — the state set is the union of both
// arrays' values, where each value is a State enum entry (NOT a bit
// position). See atspi-state-set.c:GetStates.
func (a *accessibleObj) getStates() ([]uint32, error) {
	out, err := a.call(ifaceAccessible, "GetState")
	if err != nil {
		return nil, err
	}
	if len(out) < 1 {
		return nil, ErrInvalidReply
	}
	// Godbus decodes (au) as []uint32 already when the signature matches
	// — but AT-SPI returns an (auau) variant that may surface as
	// []any{[]uint32{...}}. Handle both shapes defensively.
	switch v := out[0].(type) {
	case []uint32:
		return v, nil
	case []any:
		states := make([]uint32, 0, len(v))
		for _, raw := range v {
			if s, ok := raw.(uint32); ok {
				states = append(states, s)
			}
		}
		return states, nil
	}
	return nil, ErrInvalidReply
}

// Component interface.

// getExtents returns the bounding box in screen coordinates. Returns
// (0,0,0,0) for virtual / lazily-laid-out widgets; the snapshot walker
// keeps such nodes if they expose a name (mirrors memoh snapshot.rs).
func (a *accessibleObj) getExtents() (x, y, w, h int32, err error) {
	out, err := a.call(ifaceComponent, "GetExtents", coordScreen)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	if len(out) < 1 {
		return 0, 0, 0, 0, ErrInvalidReply
	}
	// GetExtents returns an (iiii) struct.
	rect, ok := out[0].([]any)
	if !ok || len(rect) < 4 {
		return 0, 0, 0, 0, ErrInvalidReply
	}
	x, _ = rect[0].(int32)
	y, _ = rect[1].(int32)
	w, _ = rect[2].(int32)
	h, _ = rect[3].(int32)
	return x, y, w, h, nil
}

// Action interface.

// ActionDescriptor is one entry of org.a11y.atspi.Action.GetActions.
// Wire format: a(sss) — (name, description, keybinding).
type ActionDescriptor struct {
	Name        string
	Description string
	KeyBinding  string
}

// getActions lists the AT-SPI actions exposed by this node.
func (a *accessibleObj) getActions() ([]ActionDescriptor, error) {
	out, err := a.call(ifaceAction, "GetActions")
	if err != nil {
		return nil, err
	}
	if len(out) < 1 {
		return nil, ErrInvalidReply
	}
	arr, ok := out[0].([]any)
	if !ok {
		return nil, ErrInvalidReply
	}
	actions := make([]ActionDescriptor, 0, len(arr))
	for _, raw := range arr {
		entry, ok := raw.([]any)
		if !ok || len(entry) < 3 {
			continue
		}
		name, _ := entry[0].(string)
		desc, _ := entry[1].(string)
		kb, _ := entry[2].(string)
		actions = append(actions, ActionDescriptor{Name: name, Description: desc, KeyBinding: kb})
	}
	return actions, nil
}

// doAction invokes action i. Returns whether the toolkit reported success.
func (a *accessibleObj) doAction(i int32) (bool, error) {
	out, err := a.call(ifaceAction, "DoAction", i)
	if err != nil {
		return false, err
	}
	if len(out) < 1 {
		return false, ErrInvalidReply
	}
	ok, _ := out[0].(bool)
	return ok, nil
}

// EditableText interface.

// insertText inserts text at position. The `length` argument is the
// UTF-8 BYTE count, not the rune count — GTK/ATK and Chromium both
// interpret it as bytes. Passing the rune count truncates CJK.
func (a *accessibleObj) insertText(position int32, text string) (bool, error) {
	length := int32(len(text))
	out, err := a.call(ifaceEditableText, "InsertText", position, text, length)
	if err != nil {
		return false, err
	}
	if len(out) < 1 {
		return false, ErrInvalidReply
	}
	ok, _ := out[0].(bool)
	return ok, nil
}

// setTextContents replaces the entire content of the editable widget.
func (a *accessibleObj) setTextContents(text string) (bool, error) {
	out, err := a.call(ifaceEditableText, "SetTextContents", text)
	if err != nil {
		return false, err
	}
	if len(out) < 1 {
		return false, ErrInvalidReply
	}
	ok, _ := out[0].(bool)
	return ok, nil
}

// Text interface.

// caretOffset returns the current caret position, or -1 if unavailable.
func (a *accessibleObj) caretOffset() (int32, error) {
	out, err := a.call(ifaceText, "CaretOffset")
	if err != nil {
		return -1, err
	}
	if len(out) < 1 {
		return -1, ErrInvalidReply
	}
	offset, _ := out[0].(int32)
	return offset, nil
}

// childRef is a (bus_name, object_path) pair pointing at an accessible.
// We keep it as a plain struct rather than a dbus.BusObject so the
// snapshot walker can queue hundreds of these without holding proxy
// state.
type childRef struct {
	name string
	path dbus.ObjectPath
}

// asObj materializes a childRef into an accessibleObj bound to the
// given connection.
func (c childRef) asObj(conn *dbus.Conn) *accessibleObj {
	return &accessibleObj{conn: conn, name: c.name, path: c.path}
}

// Type aliases used by other files in this package for readability.
// Keeping them here (next to accessibleObj) makes the data flow obvious.
type dbusConn = dbus.Conn
