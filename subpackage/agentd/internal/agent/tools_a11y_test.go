package agent

import (
	"errors"
	"os/exec"
	"strings"
	"testing"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent/desktop"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

// stubExecFunc replaces desktop.ExecFunc for the duration of a test,
// returning the prepared (output, err). The returned function restores
// the previous value so concurrent tests don't trip over each other.
func stubExecFunc(t *testing.T, output string, err error) {
	t.Helper()
	prev := desktop.ExecFunc
	desktop.ExecFunc = func(sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error) {
		if err != nil {
			return nil, err
		}
		// Capture the cmd argument so tests can also assert on what
		// got built — return it via a side channel.
		lastCmd = cmd
		return &sandbox.ExecResult{Stdout: output}, nil
	}
	t.Cleanup(func() { desktop.ExecFunc = prev })
}

// lastCmd is set by the stub above. Global + non-thread-safe — the
// tool layer is intentionally synchronous per-test.
var lastCmd string

func TestExecA11yHelper_ParsesValidSnapshotJSON(t *testing.T) {
	// Construct a realistic SnapshotOutput envelope that the helper
	// would emit on stdout. execA11yHelper must decode it into a
	// dbushelper.SnapshotOutput with the expected field shape.
	payload := `{"ok":true,"truncated":false,"items":[{"ref_id":"e1","role":"push button","name":"OK","x":10,"y":20,"width":30,"height":15}],"lines":["- push button \"OK\" [ref=e1] @10,20 30x15"],"refs_path":"/tmp/refs.json","diagnostics":{"apps":1,"visited":5,"accepted":1}}`
	stubExecFunc(t, payload, nil)
	// EnsureDesktop is also wired through ExecFunc — by the time
	// execA11yHelper runs, EnsureDesktop has already been called by the
	// tool wrapper, so here we just call execA11yHelper directly.

	// Use a fresh inline type so we don't need to import dbushelper here
	// (the production code already imports it; this is test-only).
	type minimalSnap struct {
		OK     bool     `json:"ok"`
		Lines  []string `json:"lines"`
	}
	var snap minimalSnap

	if err := execA11yHelper(nil, "sb-1", "snapshot", []string{"--limit", "10"}, &snap); err != nil {
		t.Fatalf("execA11yHelper: %v", err)
	}
	if !snap.OK {
		t.Errorf("OK = false, want true")
	}
	if len(snap.Lines) != 1 || !strings.Contains(snap.Lines[0], `push button "OK"`) {
		t.Errorf("Lines = %+v, want 1 line containing 'push button \"OK\"'", snap.Lines)
	}
	// The assembled command source-references the desktop-env.sh file
	// (so the helper sees the right DBUS_SESSION_BUS_ADDRESS).
	if !strings.Contains(lastCmd, "desktop-env.sh") {
		t.Errorf("cmd missing 'desktop-env.sh' source step:\n%s", lastCmd)
	}
	// And it invokes the helper binary via the canonical path.
	if !strings.Contains(lastCmd, "/usr/local/bin/agentd-a11y-helper") {
		t.Errorf("cmd missing helper binary path:\n%s", lastCmd)
	}
	// Each argv element is independently single-quoted; verify they're
	// all present rather than asserting on a specific concatenation.
	for _, want := range []string{`'snapshot'`, `'--limit'`, `'10'`} {
		if !strings.Contains(lastCmd, want) {
			t.Errorf("cmd missing argv element %q:\n%s", want, lastCmd)
		}
	}
}

func TestExecA11yHelper_SurfaceEmptyStdoutAsError(t *testing.T) {
	stubExecFunc(t, "", nil)
	var out map[string]any
	err := execA11yHelper(nil, "sb-1", "snapshot", nil, &out)
	if err == nil {
		t.Fatalf("expected error for empty stdout, got nil")
	}
	if !strings.Contains(err.Error(), "produced no output") {
		t.Errorf("error message should mention 'no output': %v", err)
	}
}

func TestExecA11yHelper_SurfaceMalformedJSONAsError(t *testing.T) {
	stubExecFunc(t, "not json at all", nil)
	var out map[string]any
	err := execA11yHelper(nil, "sb-1", "snapshot", nil, &out)
	if err == nil {
		t.Fatalf("expected error for invalid JSON, got nil")
	}
	// Error must include the raw output truncated so it doesn't leak
	// huge blobs into agentd logs.
	if !strings.Contains(err.Error(), "not json at all") {
		t.Errorf("error should include raw output for diagnostics: %v", err)
	}
}

func TestExecA11yHelper_PropagatesTransportError(t *testing.T) {
	stubExecFunc(t, "", errors.New("sandbox exec: connection refused"))
	var out map[string]any
	err := execA11yHelper(nil, "sb-1", "snapshot", nil, &out)
	if err == nil {
		t.Fatalf("expected transport error, got nil")
	}
	if !strings.Contains(err.Error(), "connection refused") {
		t.Errorf("error should preserve underlying message: %v", err)
	}
}

func TestExecA11yHelper_TruncatesLargeMalformedOutput(t *testing.T) {
	// 50k of garbage — the error message must truncate, not leak the
	// whole thing.
	big := strings.Repeat("x", 50_000)
	stubExecFunc(t, big, nil)
	var out map[string]any
	err := execA11yHelper(nil, "sb-1", "snapshot", nil, &out)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	// We truncate at 200 chars (truncateForErr); error must not contain
	// the entire 50k blob.
	if len(err.Error()) > 1000 {
		t.Errorf("error message too long (%d chars); should be truncated to ~200+", len(err.Error()))
	}
}

// TestExecA11yHelper_SingleQuotesRefAndText verifies that args
// containing spaces or shell metacharacters are properly quoted so the
// remote sh doesn't interpret them. Click refs are simple, but the
// `type` subcommand takes arbitrary text — this is the case the quoting
// MUST survive.
func TestExecA11yHelper_SingleQuotesRefAndText(t *testing.T) {
	stubExecFunc(t, `{"ok":true}`, nil)
	var out map[string]any
	textWithShell := `hello; rm -rf /; echo done`
	if err := execA11yHelper(nil, "sb-1", "type", []string{"e5", textWithShell}, &out); err != nil {
		t.Fatalf("execA11yHelper: %v", err)
	}
	// The text must appear inside single quotes in the assembled cmd,
	// so the remote shell sees it as one argv element and does NOT
	// execute the embedded `rm -rf`.
	if !strings.Contains(lastCmd, "'hello; rm -rf /; echo done'") {
		t.Errorf("text argument not single-quoted in cmd:\n%s", lastCmd)
	}
}

func TestTruncateForErr(t *testing.T) {
	// truncateForErr operates at the BYTE level (s[:n]) — fine for error
	// messages where the goal is "don't dump 50k into the log", not
	// "preserve valid UTF-8". The byte-count check here documents that
	// behavior so a future rune-aware refactor is a deliberate change.
	cases := []struct {
		in   string
		n    int
		want string
	}{
		{"short", 10, "short"},
		{"exactly10c", 10, "exactly10c"},
		{"elevenchars", 10, "elevenchar…"},
		{"", 5, ""},
		{"abc", 3, "abc"}, // len == n → returned as-is (no ellipsis)
		{"abc", 2, "ab…"}, // len > n → first n bytes + ellipsis
	}
	for _, c := range cases {
		if got := truncateForErr(c.in, c.n); got != c.want {
			t.Errorf("truncateForErr(%q, %d) = %q, want %q", c.in, c.n, got, c.want)
		}
	}
}

// TestTruncateForErr_UTF8ByteSemantics verifies the truncation is
// byte-based. A 9-byte UTF-8 string truncated at 6 bytes yields the
// first 6 bytes (which is 2 full CJK chars + the first byte of the
// third — but in Go slicing a valid string at 6 bytes when chars are
// 3 bytes each happens to land on a rune boundary here). The test
// documents the contract: callers cannot assume rune-safe truncation.
func TestTruncateForErr_UTF8ByteSemantics(t *testing.T) {
	// "日本語" is 9 bytes (3 chars × 3 bytes). Truncating at 6 bytes
	// yields "日本" (2 chars, 6 bytes) + "…". Clean boundary in this
	// case, but a 7-byte truncation would split the third char.
	got := truncateForErr("日本語", 6)
	if want := "日本…"; got != want {
		t.Errorf("truncateForErr(日本語, 6) = %q, want %q", got, want)
	}
}

func TestTruncateForErr_ZeroN(t *testing.T) {
	// n=0 → everything is longer than 0 → returns just "…"
	if got := truncateForErr("anything", 0); got != "…" {
		t.Errorf("truncateForErr(anything, 0) = %q, want '…'", got)
	}
}

func TestA11ySingleQuote(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{`simple`, `'simple'`},
		{`with space`, `'with space'`},
		{`with "double" quotes`, `'with "double" quotes'`},
		{`with 'single' quotes`, `'with '\''single'\'' quotes'`},
		{`back\slash`, `'back\slash'`},
		{`$variable`, `'$variable'`},     // single-quoted → no expansion
		{`$(evil)`, `'$(evil)'`},         // single-quoted → no command substitution
		{`; rm -rf /`, `'; rm -rf /'`},   // single-quoted → no command separator
		{``, `''`},
	}
	for _, c := range cases {
		if got := a11ySingleQuote(c.in); got != c.want {
			t.Errorf("a11ySingleQuote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestA11ySingleQuote_IsShellSafe verifies the actual safety property:
// any string, after quoting, when embedded in `sh -c "..."` must NOT
// cause command execution beyond the literal value. We test by sourcing
// the quoted value back through `eval` and checking it round-trips.
func TestA11ySingleQuote_IsShellSafe(t *testing.T) {
	// Skip if no sh available — this is a POSIX-shell property test.
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	evil := []string{
		``,
		`hello world`,
		`with 'single' quotes`,
		`with "double" quotes`,
		`$(echo pwned > /tmp/pwned)`,
		"`echo backtick`",
		`; rm -rf /`,
		`&& echo and`,
		`|| echo or`,
		`> /tmp/redirect`,
		`$HOME`,
		`${IFS}`,
	}
	for _, evil := range evil {
		quoted := a11ySingleQuote(evil)
		// Use `set --` to assign the quoted value to $1, then echo $1.
		// If quoting is wrong, evil gets interpreted as shell syntax
		// (e.g. the $(...) substitution runs) rather than literal.
		script := "set -- " + quoted + "; printf %s \"$1\""
		cmd := exec.Command("sh", "-c", script)
		out, err := cmd.Output()
		if err != nil {
			t.Errorf("shell rejected quoted %q (quoted=%q): %v", evil, quoted, err)
			continue
		}
		if string(out) != evil {
			t.Errorf("round-trip mismatch for %q:\n quoted = %q\n got back = %q", evil, quoted, string(out))
		}
	}
}

// stubExecFunc used in this file is defined above; exec.LookPath is
// imported at the top.
