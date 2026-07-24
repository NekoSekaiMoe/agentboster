//go:build linux

package input

import "testing"

// TestYdotoolButtonCode pins the logical-button → ydotool byte mapping. The
// 0xC0 base requests a full press+release; the low nibble selects the button.
// A wrong code would click the wrong mouse button on every Wayland session.
func TestYdotoolButtonCode(t *testing.T) {
	cases := map[string]string{
		"left":    "0xC0",
		"right":   "0xC1",
		"middle":  "0xC2",
		"back":    "0xC3",
		"forward": "0xC4",
		"":        "0xC0", // default → left
		"unknown": "0xC0", // unknown → left
	}
	for in, want := range cases {
		if got := ydotoolButtonCode(in); got != want {
			t.Errorf("ydotoolButtonCode(%q) = %s, want %s", in, got, want)
		}
	}
}

// TestEvdevKeycode checks named keys, case-folded characters, and misses. The
// evdev codes are the wire contract with ydotool `key`; the character map is
// US-QWERTY by design (combos identify physical keys, not glyphs).
func TestEvdevKeycode(t *testing.T) {
	cases := []struct {
		key    string
		want   int
		wantOK bool
	}{
		{"Return", 28, true},
		{"ctrl", 29, true},
		{"Shift", 42, true},
		{"a", 30, true},
		{"A", 30, true}, // case-folded to the same physical key
		{"c", 46, true}, // the 'C' in Ctrl+C
		{"1", 2, true},
		{"/", 53, true},
		{"F5", 0, false},        // no mapping → caller falls back to XTest
		{"", 0, false},          // empty
		{"multichar", 0, false}, // unknown multi-char name
	}
	for _, c := range cases {
		got, ok := evdevKeycode(c.key)
		if ok != c.wantOK || (ok && got != c.want) {
			t.Errorf("evdevKeycode(%q) = (%d, %v), want (%d, %v)", c.key, got, ok, c.want, c.wantOK)
		}
	}
}
