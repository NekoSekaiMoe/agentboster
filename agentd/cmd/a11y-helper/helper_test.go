package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNormalizeRef(t *testing.T) {
	cases := []struct{ in, want string }{
		{"e3", "e3"},
		{"  E3  ", "e3"},
		{"E03", "e3"},
		{"3", "e3"},
		{"007", "e7"},
		{"ref=e3", "e3"},
		{"REF=E03", "e3"},
		{"ref=7", "e7"},
		// Invalid / non-numeric: returned trimmed as-is.
		{"e0", "e0"}, // 0 is non-positive, no normalization
		{"abc", "abc"},
		{"", ""},
	}
	for _, c := range cases {
		if got := normalizeRef(c.in); got != c.want {
			t.Errorf("normalizeRef(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRefEntryCenter(t *testing.T) {
	e := refEntry{X: 100, Y: 50, Width: 40, Height: 20}
	if x, y := e.center(); x != 120 || y != 60 {
		t.Errorf("center = (%d,%d), want (120,60)", x, y)
	}
	// Zero dimensions: center == origin.
	e2 := refEntry{X: 10, Y: 20, Width: 0, Height: 0}
	if x, y := e2.center(); x != 10 || y != 20 {
		t.Errorf("center(zero) = (%d,%d), want (10,20)", x, y)
	}
}

func TestRefsWriteLookupRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "refs.json")
	t.Setenv("AGENTD_A11Y_REFS", path)

	entries := []refEntry{
		{RefID: "e1", BusName: ":1.42", ObjectPath: "/org/a11y/atspi/accessible/root", Role: "push button", Name: "Reload", X: 100, Y: 50, Width: 30, Height: 20},
		{RefID: "e2", BusName: ":1.42", ObjectPath: "/org/a11y/atspi/accessible/x", Role: "entry", Name: "Stop"},
	}
	if _, err := writeRefs(entries); err != nil {
		t.Fatalf("writeRefs: %v", err)
	}

	got, err := lookupRef("e2")
	if err != nil {
		t.Fatalf("lookupRef(e2): %v", err)
	}
	if got.Name != "Stop" {
		t.Errorf("lookup(e2).Name = %q, want Stop", got.Name)
	}

	// Normalized forms resolve to the same entry.
	if _, err := lookupRef("REF=E1"); err != nil {
		t.Errorf("lookup(REF=E1) err = %v, want nil", err)
	}

	if _, err := lookupRef("e99"); err == nil {
		t.Errorf("lookup(e99) err = nil, want error (not in index)")
	}

	// BusAddress file content is valid JSON.
	data, _ := os.ReadFile(path)
	var idx refIndex
	if err := json.Unmarshal(data, &idx); err != nil {
		t.Fatalf("refs file not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(idx.Entries, entries) {
		t.Errorf("roundtrip mismatch: got %+v want %+v", idx.Entries, entries)
	}
}

func TestLookupRefFailsWhenFileMissing(t *testing.T) {
	t.Setenv("AGENTD_A11Y_REFS", filepath.Join(t.TempDir(), "missing.json"))
	if _, err := lookupRef("e1"); err == nil {
		t.Fatalf("lookup on missing file: expected error, got nil")
	}
}

func TestPreferredActionIndex(t *testing.T) {
	cases := []struct {
		name    string
		actions []actionDescriptor
		want    int
	}{
		{"click wins over later press/activate", []actionDescriptor{
			{Name: "focus"}, {Name: "click"}, {Name: "press"},
		}, 1},
		{"press wins when no click", []actionDescriptor{
			{Name: "focus"}, {Name: "press"}, {Name: "activate"},
		}, 1},
		{"activate when no click/press", []actionDescriptor{
			{Name: "focus"}, {Name: "activate"},
		}, 1},
		{"case-insensitive", []actionDescriptor{
			{Name: "Focus"}, {Name: "CLICK"},
		}, 1},
		{"fall back to first", []actionDescriptor{
			{Name: "focus"}, {Name: "describe"},
		}, 0},
		{"empty list", []actionDescriptor{}, 0},
	}
	for _, c := range cases {
		if got := preferredActionIndex(c.actions); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestRoleIsStructural(t *testing.T) {
	structural := []uint32{roleInvalidRole, roleUnknown, roleFiller, roleSeparator, roleApplication, roleDesktopFrame, roleDesktopIcon}
	for _, r := range structural {
		if !roleIsStructural(r) {
			t.Errorf("role %d should be structural", r)
		}
	}
	// A few non-structural roles.
	notStructural := []uint32{2, 3, 4, 6, 10, 20, 100, 200}
	for _, r := range notStructural {
		if roleIsStructural(r) {
			t.Errorf("role %d should NOT be structural", r)
		}
	}
}

func TestIsOnScreen(t *testing.T) {
	if !isOnScreen([]uint32{stateShowing}) {
		t.Error("Showing alone should be on-screen")
	}
	if !isOnScreen([]uint32{stateVisible}) {
		t.Error("Visible alone should be on-screen")
	}
	if !isOnScreen([]uint32{1, stateShowing, 5}) {
		t.Error("Showing mixed with other states should be on-screen")
	}
	if isOnScreen([]uint32{1, 5, 10}) {
		t.Error("states without Showing/Visible should NOT be on-screen")
	}
	if isOnScreen([]uint32{}) {
		t.Error("empty state list should NOT be on-screen")
	}
}

func TestFormatLine(t *testing.T) {
	cases := []struct {
		entry refEntry
		want  string
	}{
		{
			refEntry{RefID: "e3", Role: "push button", Name: "Reload", X: 120, Y: 80, Width: 28, Height: 28},
			`- push button "Reload" [ref=e3] @120,80 28x28`,
		},
		{
			// No name: omit the quoted name clause.
			refEntry{RefID: "e1", Role: "separator", Name: "", X: 0, Y: 0, Width: 0, Height: 0},
			`- separator [ref=e1]`,
		},
		{
			// Zero extents but non-empty name: name shown, no @x,y WxH.
			refEntry{RefID: "e2", Role: "label", Name: "Hint", X: 0, Y: 0, Width: 0, Height: 0},
			`- label "Hint" [ref=e2]`,
		},
		{
			// Name with embedded quote: round-trips via JSON escaping.
			refEntry{RefID: "e4", Role: "label", Name: `she said "hi"`, X: 5, Y: 6, Width: 7, Height: 8},
			`- label "she said \"hi\"" [ref=e4] @5,6 7x8`,
		},
	}
	for _, c := range cases {
		if got := formatLine(c.entry); got != c.want {
			t.Errorf("formatLine(%+v)\n  got  %q\n  want %q", c.entry, got, c.want)
		}
	}
}

func TestJsonQuote(t *testing.T) {
	cases := []struct{ in, want string }{
		{"hello", `"hello"`},
		{`quote " inside`, `"quote \" inside"`},
		{`back\slash`, `"back\\slash"`},
		{"tab\there", `"tab\there"`},
		{"", `""`},
		{"日本語", `"日本語"`},
	}
	for _, c := range cases {
		if got := jsonQuote(c.in); got != c.want {
			t.Errorf("jsonQuote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDisplayNumber(t *testing.T) {
	cases := []struct{ in, want string }{
		{":99", "99"},
		{":99.0", "99"},
		{":0", "0"},
		{"", "0"},
		{"bogus", "0"},
		{"  :5 ", "5"}, // trimmed by implementation
	}
	for _, c := range cases {
		if got := displayNumber(c.in); got != c.want {
			t.Errorf("displayNumber(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCandidateCachePaths(t *testing.T) {
	got := candidateCachePaths("99", "/run/user/1000", "/home/alice")
	want := []string{
		"/run/user/1000/at-spi/bus_99",
		"/run/user/1000/at-spi/bus",
		"/home/alice/.cache/at-spi/bus_99",
		"/data/.cache/at-spi/bus_99",
		"/root/.cache/at-spi/bus_99",
		"/tmp/at-spi/bus_99",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("candidateCachePaths:\n got  %+v\n want %+v", got, want)
	}

	// No XDG_RUNTIME_DIR: skip those entries.
	got2 := candidateCachePaths("0", "", "/root")
	want2 := []string{
		"/root/.cache/at-spi/bus_0",
		"/data/.cache/at-spi/bus_0",
		"/root/.cache/at-spi/bus_0", // duplicates allowed (Home and /root may coincide)
		"/tmp/at-spi/bus_0",
	}
	if !reflect.DeepEqual(got2, want2) {
		t.Errorf("candidateCachePaths (no XDG):\n got  %+v\n want %+v", got2, want2)
	}
}

func TestParseLimit(t *testing.T) {
	cases := []struct {
		args []string
		want int
	}{
		{nil, defaultLimit},
		{[]string{"--limit", "50"}, 50},
		{[]string{"--limit=75"}, 75},
		{[]string{"--limit", "abc"}, defaultLimit}, // bad value → default
		{[]string{"--limit", "-5"}, defaultLimit},  // negative → default
		{[]string{"--limit", "0"}, defaultLimit},   // zero → default
		{[]string{"--unknown", "x"}, defaultLimit}, // unknown flag → default
	}
	for _, c := range cases {
		if got := parseLimit(c.args); got != c.want {
			t.Errorf("parseLimit(%v) = %d, want %d", c.args, got, c.want)
		}
	}
}
