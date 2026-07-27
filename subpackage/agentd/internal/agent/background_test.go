//go:build linux

package agent

import "testing"

// TestShellQuoteProducesSingleQuotedToken covers the bug where SpawnBackground
// used %q (double quotes) which is NOT shell-safe: $VAR / `cmd` / $(...) would
// expand, and \uXXXX escapes corrupt non-ASCII. shellQuote must wrap in single
// quotes (no expansion inside) and escape only literal single-quotes.
func TestShellQuoteProducesSingleQuotedToken(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "hello", "'hello'"},
		{"path", "/tmp/agentd-bg/bg_1", "'/tmp/agentd-bg/bg_1'"},
		{"with space", "a b c", "'a b c'"},
		{"single quote", "it's", "'it'\\''s'"},
		{"multiple single quotes", "a'b'c", "'a'\\''b'\\''c'"},
		// Shell metacharacters that would be dangerous inside double quotes
		// are inert inside single quotes — shellQuote must NOT escape or
		// transform them, just wrap.
		{"dollar", "with $VAR", "'with $VAR'"},
		{"backtick", "with `cmd`", "'with `cmd`'"},
		{"command subst", "with $(x)", "'with $(x)'"},
		{"semicolon pipe", "a; rm -rf /", "'a; rm -rf /'"},
		{"non-ascii", "/tmp/测试", "'/tmp/测试'"},
		{"empty", "", "''"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := shellQuote(tc.in)
			if got != tc.want {
				t.Fatalf("shellQuote(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestShellQuoteOutputIsShellInvariant is a sanity check: feed a nasty
// string and verify the output is wrapped in single quotes and every
// character of the input is recoverable (single-quoting only inserts
// the 4-char escape sequence for a literal quote; it never rewrites or
// drops payload bytes). We avoid invoking a real shell in unit tests;
// the exact-output table test above is the authoritative check.
func TestShellQuoteOutputIsShellInvariant(t *testing.T) {
	inputs := []string{
		"normal",
		"with $HOME `whoami` $(id)",
		"/var/lib/数据",
	}
	for _, in := range inputs {
		out := shellQuote(in)
		if len(out) < 2 || out[0] != '\'' || out[len(out)-1] != '\'' {
			t.Fatalf("shellQuote(%q) = %q: must be wrapped in single quotes", in, out)
		}
		// No payload byte of the input may disappear: every input char is
		// present in `out` in order. (Shell-quoting only INSERTS the escape
		// chars '\' between payload chars; it never deletes them.)
		j := 0
		for i := 0; i < len(out) && j < len(in); i++ {
			if out[i] == in[j] {
				j++
			}
		}
		if j != len(in) {
			t.Fatalf("shellQuote(%q) = %q: input payload not recoverable in order (matched %d/%d)",
				in, out, j, len(in))
		}
	}
}
