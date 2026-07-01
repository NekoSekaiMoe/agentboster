package main

import (
	"testing"

	dbushelper "github.com/NekoSekaiMoe/agentboster/subpackage/dbushelper"
)

// TestParseLimit verifies CLI flag parsing — kept here (in package main)
// rather than in the dbushelper package because parseLimit is a CLI
// detail, not a library API.
func TestParseLimit(t *testing.T) {
	cases := []struct {
		args []string
		want int
	}{
		{nil, dbushelper.DefaultLimit},
		{[]string{"--limit", "50"}, 50},
		{[]string{"--limit=75"}, 75},
		{[]string{"--limit", "abc"}, dbushelper.DefaultLimit}, // bad value → default
		{[]string{"--limit", "-5"}, dbushelper.DefaultLimit},  // negative → default
		{[]string{"--limit", "0"}, dbushelper.DefaultLimit},   // zero → default
		{[]string{"--unknown", "x"}, dbushelper.DefaultLimit}, // unknown flag → default
	}
	for _, c := range cases {
		if got := parseLimit(c.args); got != c.want {
			t.Errorf("parseLimit(%v) = %d, want %d", c.args, got, c.want)
		}
	}
}
