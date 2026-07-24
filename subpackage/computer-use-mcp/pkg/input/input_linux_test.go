//go:build linux

package input

import "testing"

// TestRuneToKeysym pins the Unicode→X11-keysym convention the pure-XTest typing
// fallback relies on. This logic is display-independent, so it runs in headless
// CI where the XTest path itself cannot be exercised.
func TestRuneToKeysym(t *testing.T) {
	cases := []struct {
		name string
		in   rune
		want uint64
	}{
		{"ascii lower", 'a', 0x61},
		{"ascii upper", 'A', 0x41},
		{"digit", '0', 0x30},
		{"space", ' ', 0x20},
		{"shifted symbol", '!', 0x21},
		{"tilde", '~', 0x7e},
		{"latin1 high", 'é', 0x00e9},   // U+00E9, maps to identical keysym
		{"latin1 max", 'ÿ', 0x00ff},    // U+00FF boundary of the direct-map range
		{"newline->Return", '\n', XK_Return},
		{"carriage->Return", '\r', XK_Return},
		{"tab", '\t', XK_Tab},
		{"cjk", '好', 0x01000000 | 0x597d}, // outside Latin-1 → Unicode keysym range
		{"emoji", '✦', 0x01000000 | 0x2726},
		{"nul->none", 0x00, 0},
		{"bell->none", 0x07, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := runeToKeysym(c.in); got != c.want {
				t.Errorf("runeToKeysym(%q) = %#x, want %#x", c.in, got, c.want)
			}
		})
	}
}
