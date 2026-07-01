package dbushelper

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
		// Expand refs (group nodes) preserve the x prefix.
		{"x12", "x12"},
		{"X12", "x12"},
		{"  X04 ", "x4"},
		{"ref=x7", "x7"},
		{"REF=X03", "x3"},
		// Invalid / non-numeric: returned trimmed as-is.
		{"e0", "e0"}, // 0 is non-positive, no normalization
		{"abc", "abc"},
		{"", ""},
	}
	for _, c := range cases {
		if got := NormalizeRef(c.in); got != c.want {
			t.Errorf("NormalizeRef(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRefEntryCenter(t *testing.T) {
	e := RefEntry{X: 100, Y: 50, Width: 40, Height: 20}
	if x, y := e.Center(); x != 120 || y != 60 {
		t.Errorf("center = (%d,%d), want (120,60)", x, y)
	}
	// Zero dimensions: center == origin.
	e2 := RefEntry{X: 10, Y: 20, Width: 0, Height: 0}
	if x, y := e2.Center(); x != 10 || y != 20 {
		t.Errorf("center(zero) = (%d,%d), want (10,20)", x, y)
	}
}

func TestRefsWriteLookupRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "refs.json")
	t.Setenv("AGENTD_A11Y_REFS", path)

	entries := []RefEntry{
		{RefID: "e1", BusName: ":1.42", ObjectPath: "/org/a11y/atspi/accessible/root", Role: "push button", Name: "Reload", X: 100, Y: 50, Width: 30, Height: 20},
		{RefID: "e2", BusName: ":1.42", ObjectPath: "/org/a11y/atspi/accessible/x", Role: "entry", Name: "Stop"},
	}
	if _, err := WriteRefs(entries); err != nil {
		t.Fatalf("WriteRefs: %v", err)
	}

	got, err := LookupRef("e2")
	if err != nil {
		t.Fatalf("LookupRef(e2): %v", err)
	}
	if got.Name != "Stop" {
		t.Errorf("lookup(e2).Name = %q, want Stop", got.Name)
	}

	// Normalized forms resolve to the same entry.
	if _, err := LookupRef("REF=E1"); err != nil {
		t.Errorf("lookup(REF=E1) err = %v, want nil", err)
	}

	if _, err := LookupRef("e99"); err == nil {
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
	if _, err := LookupRef("e1"); err == nil {
		t.Fatalf("lookup on missing file: expected error, got nil")
	}
}

// WriteRefs must be atomic: a concurrent reader should never see a
// half-written file, and no temp file should be left behind on success.
func TestWriteRefsIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "refs.json")
	t.Setenv("AGENTD_A11Y_REFS", path)

	entries := []RefEntry{
		{RefID: "e1", BusName: ":1.1", ObjectPath: "/o/1", Role: "push button", Name: "OK"},
	}
	if _, err := WriteRefs(entries); err != nil {
		t.Fatalf("WriteRefs: %v", err)
	}

	// Target exists and is valid JSON (the rename happened).
	got, err := LookupRef("e1")
	if err != nil {
		t.Fatalf("LookupRef after WriteRefs: %v", err)
	}
	if got.Name != "OK" {
		t.Errorf("got.Name = %q, want OK", got.Name)
	}

	// No leftover temp files in the directory.
	matches, err := filepath.Glob(filepath.Join(dir, ".refs-*.json.tmp"))
	if err != nil {
		t.Fatalf("glob temp: %v", err)
	}
	if len(matches) != 0 {
		t.Errorf("leftover temp files after atomic write: %v", matches)
	}

	// Overwrite works: the prior content is fully replaced, not appended.
	entries2 := []RefEntry{
		{RefID: "e9", BusName: ":1.1", ObjectPath: "/o/9", Role: "entry", Name: "Fresh"},
	}
	if _, err := WriteRefs(entries2); err != nil {
		t.Fatalf("WriteRefs (overwrite): %v", err)
	}
	if _, err := LookupRef("e1"); err == nil {
		t.Errorf("e1 should be gone after overwrite, but lookup succeeded")
	}
	got2, err := LookupRef("e9")
	if err != nil || got2.Name != "Fresh" {
		t.Errorf("after overwrite LookupRef(e9) = %+v, err=%v; want Fresh", got2, err)
	}
}

// WriteRefs must create the parent directory if it does not yet exist
// (default /tmp/agentd-a11y-refs.json path may have a missing /tmp/at-spi
// on first run inside a fresh sandbox).
func TestWriteRefsCreatesParentDir(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "nested", "deep", "refs.json")
	t.Setenv("AGENTD_A11Y_REFS", nested)

	if _, err := WriteRefs([]RefEntry{
		{RefID: "e1", BusName: ":1.1", ObjectPath: "/o", Role: "label", Name: "x"},
	}); err != nil {
		t.Fatalf("WriteRefs into missing dir: %v", err)
	}
	if _, err := os.Stat(nested); err != nil {
		t.Errorf("expected %s to exist: %v", nested, err)
	}
}

func TestPreferredActionIndex(t *testing.T) {
	cases := []struct {
		name    string
		actions []ActionDescriptor
		want    int
	}{
		{"click wins over later press/activate", []ActionDescriptor{
			{Name: "focus"}, {Name: "click"}, {Name: "press"},
		}, 1},
		{"press wins when no click", []ActionDescriptor{
			{Name: "focus"}, {Name: "press"}, {Name: "activate"},
		}, 1},
		{"activate when no click/press", []ActionDescriptor{
			{Name: "focus"}, {Name: "activate"},
		}, 1},
		{"case-insensitive", []ActionDescriptor{
			{Name: "Focus"}, {Name: "CLICK"},
		}, 1},
		{"fall back to first", []ActionDescriptor{
			{Name: "focus"}, {Name: "describe"},
		}, 0},
		{"empty list", []ActionDescriptor{}, 0},
	}
	for _, c := range cases {
		if got := PreferredActionIndex(c.actions); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestRoleIsStructural(t *testing.T) {
	structural := []uint32{RoleInvalidRole, RoleUnknown, RoleFiller, RoleSeparator, RoleApplication, RoleDesktopFrame, RoleDesktopIcon}
	for _, r := range structural {
		if !RoleIsStructural(r) {
			t.Errorf("role %d should be structural", r)
		}
	}
	// A few non-structural roles.
	notStructural := []uint32{2, 3, 4, 6, 10, 20, 100, 200}
	for _, r := range notStructural {
		if RoleIsStructural(r) {
			t.Errorf("role %d should NOT be structural", r)
		}
	}
}

func TestRoleIsInteractive(t *testing.T) {
	interactive := []uint32{
		4,  // toggle button
		7,  // check box
		14, // entry
		22, // list
		25, // menu item
		29, // push button
		36, // spin button
		42, // table cell
		43, // text
		61, // link
	}
	for _, r := range interactive {
		if !RoleIsInteractive(r) {
			t.Errorf("role %d should be interactive", r)
		}
	}
	// Pure presentational / structural-but-not-blocklisted roles must
	// be classified as group (non-interactive) so they get an xN ref
	// and a folded line, not an action ref.
	group := []uint32{
		2,  // invalid-ish / filler-ish leftover
		11, // font chooser (display only)
		18, // frame
		19, // glass pane
		20, // html container
		30, // — wait, 30 is radio button; remove below
	}
	// Remove the radio-button false positive from the group list.
	group = []uint32{11, 18, 19, 20, 41}
	for _, r := range group {
		if RoleIsInteractive(r) {
			t.Errorf("role %d should NOT be interactive", r)
		}
	}
}

func TestIsOnScreen(t *testing.T) {
	if !IsOnScreen([]uint32{StateShowing}) {
		t.Error("Showing alone should be on-screen")
	}
	if !IsOnScreen([]uint32{StateVisible}) {
		t.Error("Visible alone should be on-screen")
	}
	if !IsOnScreen([]uint32{1, StateShowing, 5}) {
		t.Error("Showing mixed with other states should be on-screen")
	}
	if IsOnScreen([]uint32{1, 5, 10}) {
		t.Error("states without Showing/Visible should NOT be on-screen")
	}
	if IsOnScreen([]uint32{}) {
		t.Error("empty state list should NOT be on-screen")
	}
}

func TestFormatLine(t *testing.T) {
	cases := []struct {
		entry RefEntry
		want  string
	}{
		{
			RefEntry{RefID: "e3", Role: "push button", Name: "Reload", X: 120, Y: 80, Width: 28, Height: 28},
			`- push button "Reload" [ref=e3] @120,80 28x28`,
		},
		{
			// No name: omit the quoted name clause.
			RefEntry{RefID: "e1", Role: "separator", Name: "", X: 0, Y: 0, Width: 0, Height: 0},
			`- separator [ref=e1]`,
		},
		{
			// Zero extents but non-empty name: name shown, no @x,y WxH.
			RefEntry{RefID: "e2", Role: "label", Name: "Hint", X: 0, Y: 0, Width: 0, Height: 0},
			`- label "Hint" [ref=e2]`,
		},
		{
			// Name with embedded quote: round-trips via JSON escaping.
			RefEntry{RefID: "e4", Role: "label", Name: `she said "hi"`, X: 5, Y: 6, Width: 7, Height: 8},
			`- label "she said \"hi\"" [ref=e4] @5,6 7x8`,
		},
		{
			// Group ref: folded line with child count + expand hint,
			// geometry preserved.
			RefEntry{RefID: "x7", Role: "panel", Name: "Advanced settings", Kind: RefKindGroup, ChildCount: 47, X: 20, Y: 30, Width: 600, Height: 400},
			`- panel "Advanced settings" [ref=x7, children=47, inspect to expand] @20,30 600x400`,
		},
		{
			// Group ref with no children still surfaces the fold hint
			// (so the LLM knows there's nothing to expand).
			RefEntry{RefID: "x1", Role: "panel", Name: "", Kind: RefKindGroup, ChildCount: 0, X: 0, Y: 0, Width: 0, Height: 0},
			`- panel [ref=x1, children=0, inspect to expand]`,
		},
	}
	for _, c := range cases {
		if got := FormatLine(c.entry); got != c.want {
			t.Errorf("FormatLine(%+v)\n  got  %q\n  want %q", c.entry, got, c.want)
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
		if got := JsonQuote(c.in); got != c.want {
			t.Errorf("JsonQuote(%q) = %q, want %q", c.in, got, c.want)
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
		if got := DisplayNumber(c.in); got != c.want {
			t.Errorf("DisplayNumber(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCandidateCachePaths(t *testing.T) {
	got := CandidateCachePaths("99", "/run/user/1000", "/home/alice")
	want := []string{
		"/run/user/1000/at-spi/bus_99",
		"/run/user/1000/at-spi/bus",
		"/home/alice/.cache/at-spi/bus_99",
		"/data/.cache/at-spi/bus_99",
		"/root/.cache/at-spi/bus_99",
		"/tmp/at-spi/bus_99",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("CandidateCachePaths:\n got  %+v\n want %+v", got, want)
	}

	// No XDG_RUNTIME_DIR: skip those entries.
	got2 := CandidateCachePaths("0", "", "/root")
	want2 := []string{
		"/root/.cache/at-spi/bus_0",
		"/data/.cache/at-spi/bus_0",
		"/root/.cache/at-spi/bus_0", // duplicates allowed (Home and /root may coincide)
		"/tmp/at-spi/bus_0",
	}
	if !reflect.DeepEqual(got2, want2) {
		t.Errorf("CandidateCachePaths (no XDG):\n got  %+v\n want %+v", got2, want2)
	}
}

func TestNextRefCounters(t *testing.T) {
	cases := []struct {
		name          string
		entries       []RefEntry
		wantAction    int
		wantGroup     int
	}{
		{
			name:       "empty",
			entries:    nil,
			wantAction: 0,
			wantGroup:  0,
		},
		{
			name: "only action refs",
			entries: []RefEntry{
				{RefID: "e1", Kind: RefKindAction},
				{RefID: "e5", Kind: RefKindAction},
				{RefID: "e3", Kind: RefKindAction},
			},
			wantAction: 6, // one past max=5
			wantGroup:  0,
		},
		{
			name: "only group refs",
			entries: []RefEntry{
				{RefID: "x1", Kind: RefKindGroup},
				{RefID: "x9", Kind: RefKindGroup},
			},
			wantAction: 0,
			wantGroup:  10,
		},
		{
			name: "mixed with legacy unkinded entries (treated as action)",
			entries: []RefEntry{
				{RefID: "e2"}, // legacy: no Kind
				{RefID: "x4", Kind: RefKindGroup},
				{RefID: "e7", Kind: RefKindAction},
			},
			wantAction: 8,
			wantGroup:  5,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotAction, gotGroup := nextRefCounters(c.entries)
			if gotAction != c.wantAction || gotGroup != c.wantGroup {
				t.Errorf("nextRefCounters = (action=%d, group=%d), want (%d, %d)",
					gotAction, gotGroup, c.wantAction, c.wantGroup)
			}
		})
	}
}

// AppendRefs must continue the action/group counters from the existing
// index so newly published refs (from inspect) do not collide with
// earlier ids. It must also be atomic (delegates to WriteRefs).
func TestAppendRefsContinuesCounters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "refs.json")
	t.Setenv("AGENTD_A11Y_REFS", path)

	// Seed the index with an action ref e3 and a group ref x5.
	if _, err := WriteRefs([]RefEntry{
		{RefID: "e3", BusName: ":1.1", ObjectPath: "/o/3", Role: "push button", Name: "Old", Kind: RefKindAction},
		{RefID: "x5", BusName: ":1.1", ObjectPath: "/o/5", Role: "panel", Name: "OldGroup", Kind: RefKindGroup},
	}); err != nil {
		t.Fatalf("seed WriteRefs: %v", err)
	}

	// Caller is responsible for picking the new ids using
	// nextRefCounters — AppendRefs just persists them. Simulate the
	// inspect helper: it picks e4 / x6 via nextRefCounters and hands
	// them to AppendRefs.
	existing, err := readRefs()
	if err != nil {
		t.Fatalf("readRefs: %v", err)
	}
	actionNext, groupNext := nextRefCounters(existing)
	if actionNext != 4 || groupNext != 6 {
		t.Fatalf("nextRefCounters = (%d,%d), want (4,6)", actionNext, groupNext)
	}

	appended := []RefEntry{
		{RefID: "e4", BusName: ":1.2", ObjectPath: "/o/4", Role: "entry", Name: "New", Kind: RefKindAction},
		{RefID: "x6", BusName: ":1.2", ObjectPath: "/o/6", Role: "panel", Name: "NewGroup", Kind: RefKindGroup},
	}
	combined, err := AppendRefs(appended)
	if err != nil {
		t.Fatalf("AppendRefs: %v", err)
	}
	if len(combined) != 4 {
		t.Errorf("combined len = %d, want 4", len(combined))
	}

	// The new refs resolve through the standard lookup path.
	got, err := LookupRef("e4")
	if err != nil || got.Name != "New" {
		t.Errorf("LookupRef(e4) = %+v, err=%v; want New", got, err)
	}
	gotX, err := LookupRef("x6")
	if err != nil || gotX.Name != "NewGroup" {
		t.Errorf("LookupRef(x6) = %+v, err=%v; want NewGroup", gotX, err)
	}

	// Old refs are still resolvable (append, not replace).
	if _, err := LookupRef("e3"); err != nil {
		t.Errorf("LookupRef(e3) after append err = %v", err)
	}
}
