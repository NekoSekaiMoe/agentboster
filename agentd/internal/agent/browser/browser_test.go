//go:build linux
// +build linux

package browser

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/clawless/agentd/internal/sandbox"
)

// fakeExec is a recording stub for ExecFunc. It dispatches based on
// substring matches against `cmd` — the first rule whose pattern matches
// wins. CallLog accumulates every invocation for assertion.
type fakeExec struct {
	rules   []fakeRule
	CallLog []string
}

type fakeRule struct {
	pattern  string
	stdout   string
	stderr   string
	exitCode int
	err      error
}

func (f *fakeExec) exec(sandboxID, cmd string, _ map[string]string, _ int) (*sandbox.ExecResult, error) {
	f.CallLog = append(f.CallLog, cmd)
	for _, r := range f.rules {
		if strings.Contains(cmd, r.pattern) {
			return &sandbox.ExecResult{
				Stdout:   r.stdout,
				Stderr:   r.stderr,
				ExitCode: r.exitCode,
			}, r.err
		}
	}
	// Default: empty stdout, exit 0.
	return &sandbox.ExecResult{ExitCode: 0}, nil
}

const sbID = "sb-test"

func resetExecFunc() {
	ExecFunc = nil
}

func TestEnsureBridge_FastPathHealthReady(t *testing.T) {
	defer resetExecFunc()
	fx := &fakeExec{
		rules: []fakeRule{
			// probeHealth runs `[ -S socket ] && curl ... | grep -q '"ok":true' && echo OK || echo FAIL`
			// in the real shell. The fake substitutes the *final stdout*,
			// which is "OK" when the grep succeeds.
			{pattern: `/health`, stdout: `OK`, exitCode: 0},
		},
	}
	ExecFunc = fx.exec

	markNotReady(sbID) // force cold path, but /health returns healthy
	defer markNotReady(sbID)

	if err := EnsureBridge(nil, sbID); err != nil {
		t.Fatalf("EnsureBridge returned error on healthy fast path: %v", err)
	}
	if !isReady(sbID) {
		t.Fatalf("expected bridge to be marked ready after healthy probe")
	}
	// Should have made exactly one sandbox call (the health probe).
	if len(fx.CallLog) != 1 {
		t.Fatalf("expected 1 call on fast path, got %d: %v", len(fx.CallLog), fx.CallLog)
	}
}

func TestEnsureBridge_FastPathFromCachedReady(t *testing.T) {
	defer resetExecFunc()
	// Simulate a prior successful EnsureBridge: mark ready, and /health is healthy.
	markReady(sbID)
	defer markNotReady(sbID)
	fx := &fakeExec{
		rules: []fakeRule{
			{pattern: `/health`, stdout: `OK`},
		},
	}
	ExecFunc = fx.exec

	if err := EnsureBridge(nil, sbID); err != nil {
		t.Fatalf("EnsureBridge on cached-ready bridge failed: %v", err)
	}
	// Cached-ready still probes once (verifies liveness).
	if len(fx.CallLog) != 1 {
		t.Fatalf("expected 1 health probe on cached-ready path, got %d", len(fx.CallLog))
	}
}

func TestEnsureBridge_ColdPath_InstallsAndStarts(t *testing.T) {
	defer resetExecFunc()

	// State machine: first N calls FAIL health → trigger install path.
	// After we see the nohup start command, health starts succeeding.
	healthOK := false
	fx := &fakeExec{
		rules: []fakeRule{
			{
				pattern: `/health`,
				stdout: func() string {
					if healthOK {
						return `{"ok":true,"data":{}}`
					}
					return "FAIL"
				}(),
				// We'll mutate via a custom exec below instead.
			},
		},
	}

	// Replace with a stateful exec that flips healthOK after seeing nohup.
	ExecFunc = func(sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error) {
		fx.CallLog = append(fx.CallLog, cmd)
		switch {
		case strings.Contains(cmd, "nohup"):
			healthOK = true
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "12345"}, nil
		case strings.Contains(cmd, "/health"):
			if healthOK {
				return &sandbox.ExecResult{ExitCode: 0, Stdout: `OK`}, nil
			}
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "FAIL"}, nil
		default:
			// node_install, npm install, write bridge.js, etc.
			return &sandbox.ExecResult{ExitCode: 0}, nil
		}
	}

	// Shorten the poll interval so the test doesn't take 500ms per tick.
	prev := healthPollInterval
	healthPollInterval = 5 * time.Millisecond
	defer func() { healthPollInterval = prev }()

	if err := EnsureBridge(nil, sbID); err != nil {
		t.Fatalf("EnsureBridge cold path failed: %v", err)
	}
	if !isReady(sbID) {
		t.Fatalf("expected ready flag set after cold-path success")
	}

	// Verify each phase was invoked.
	var sawInstall, sawPlaywrightInstall, sawWriteBridge, sawNohup bool
	for _, c := range fx.CallLog {
		if strings.Contains(c, "node_install.sh") || strings.Contains(c, "AGENTD_NODE") {
			sawInstall = true
		}
		if strings.Contains(c, "npm install playwright") || strings.Contains(c, "install playwright") {
			sawPlaywrightInstall = true
		}
		if strings.Contains(c, "bridge.js") && strings.Contains(c, "cat >") {
			sawWriteBridge = true
		}
		if strings.Contains(c, "nohup") {
			sawNohup = true
		}
	}
	if !sawInstall {
		t.Errorf("expected node install script invocation; calls: %v", fx.CallLog)
	}
	if !sawPlaywrightInstall {
		t.Errorf("expected playwright install invocation; calls: %v", fx.CallLog)
	}
	if !sawWriteBridge {
		t.Errorf("expected bridge.js write; calls: %v", fx.CallLog)
	}
	if !sawNohup {
		t.Errorf("expected nohup start; calls: %v", fx.CallLog)
	}
}

// TestEnsureBridge_PlaywrightUpgrade_ReinstallOnVersionMismatch verifies
// the idempotency short-circuit keys on the *installed* version, not on
// the directory's existence. When the sandbox has a stale playwright
// (e.g. 1.59.0 cached from a previous deploy), bumping playwrightVersion
// on the daemon side must trigger a re-install.
//
// This is a regression guard for a real bug: the previous check used
// `[ -d node_modules/playwright ] && exit 0`, so persistent LXC sandboxes
// with a cached older version would never pick up version bumps and fail
// at runtime with "browser binary not found" because the chromium
// revision baked into each playwright release differs.
func TestEnsureBridge_PlaywrightUpgrade_ReinstallOnVersionMismatch(t *testing.T) {
	defer resetExecFunc()

	var callLog []string
	healthOK := false
	ExecFunc = func(sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error) {
		callLog = append(callLog, cmd)
		switch {
		case strings.Contains(cmd, "nohup"):
			healthOK = true
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "12345"}, nil
		case strings.Contains(cmd, "/health"):
			if healthOK {
				return &sandbox.ExecResult{ExitCode: 0, Stdout: `OK`}, nil
			}
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "FAIL"}, nil
		case strings.Contains(cmd, `-p "require`):
			// Simulate a stale playwright install: the helper dir exists
			// but the version reported by package.json is older than
			// playwrightVersion. The shell will fall through to re-install.
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "1.59.0"}, nil
		default:
			return &sandbox.ExecResult{ExitCode: 0}, nil
		}
	}

	prev := healthPollInterval
	healthPollInterval = 5 * time.Millisecond
	defer func() { healthPollInterval = prev }()

	if err := EnsureBridge(nil, sbID); err != nil {
		t.Fatalf("EnsureBridge failed on version-mismatch path: %v", err)
	}

	// Must have run `node -p` to read the installed version AND followed
	// through with `npm install playwright@<version>` because the version
	// did not match. Both substrings must appear in the call log.
	var sawVersionProbe, sawReinstall bool
	for _, c := range callLog {
		if strings.Contains(c, `-p "require`) {
			sawVersionProbe = true
		}
		if strings.Contains(c, "install playwright@") {
			sawReinstall = true
		}
	}
	if !sawVersionProbe {
		t.Errorf("expected `node -p` version probe; calls: %v", callLog)
	}
	if !sawReinstall {
		t.Errorf("expected re-install because installed version 1.59.0 != playwrightVersion %q; calls: %v",
			playwrightVersion, callLog)
	}
}

// TestEnsureBridge_PlaywrightSameVersion_SkipInstall is the complementary
// case: when the installed version matches playwrightVersion exactly, the
// install step is skipped entirely — no `npm install` invocation should
// appear in the call log.
func TestEnsureBridge_PlaywrightSameVersion_SkipInstall(t *testing.T) {
	defer resetExecFunc()

	var callLog []string
	healthOK := false
	ExecFunc = func(sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error) {
		callLog = append(callLog, cmd)
		switch {
		case strings.Contains(cmd, "nohup"):
			healthOK = true
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "12345"}, nil
		case strings.Contains(cmd, "/health"):
			if healthOK {
				return &sandbox.ExecResult{ExitCode: 0, Stdout: `OK`}, nil
			}
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "FAIL"}, nil
		case strings.Contains(cmd, `-p "require`):
			// Report a matching version: short-circuit should fire.
			return &sandbox.ExecResult{ExitCode: 0, Stdout: playwrightVersion}, nil
		default:
			return &sandbox.ExecResult{ExitCode: 0}, nil
		}
	}

	prev := healthPollInterval
	healthPollInterval = 5 * time.Millisecond
	defer func() { healthPollInterval = prev }()

	if err := EnsureBridge(nil, sbID); err != nil {
		t.Fatalf("EnsureBridge failed on same-version path: %v", err)
	}

	// Must NOT see an install command. Other steps (nohup, write bridge)
	// still run because the helper dir layout may have changed.
	for _, c := range callLog {
		if strings.Contains(c, "install playwright") {
			t.Errorf("expected install to be skipped (version matches %q), but saw: %s",
				playwrightVersion, c)
		}
	}
}

// TestEnsureBridge_ProbeFailure_ContinuesToInstall verifies the probe
// error path degrades gracefully: if the version probe (runScriptRaw)
// returns an error — e.g. sandbox overloaded, ctx timeout, transient
// lxc-attach failure — EnsureBridge must NOT hard-fail. It should
// treat the installed version as unknown ("") and fall through to the
// install path. The install is idempotent: `npm install playwright@X`
// is a no-op when X is already installed, and runs normally otherwise.
//
// This is a regression guard for a real production failure mode where
// transient sandbox hiccups would disable the entire browser bridge
// until the user retried.
func TestEnsureBridge_ProbeFailure_ContinuesToInstall(t *testing.T) {
	defer resetExecFunc()

	var callLog []string
	healthOK := false
	ExecFunc = func(sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error) {
		callLog = append(callLog, cmd)
		switch {
		case strings.Contains(cmd, "nohup"):
			healthOK = true
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "12345"}, nil
		case strings.Contains(cmd, "/health"):
			if healthOK {
				return &sandbox.ExecResult{ExitCode: 0, Stdout: `OK`}, nil
			}
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "FAIL"}, nil
		case strings.Contains(cmd, `-p "require`):
			// Simulate probe failure: the sandbox returned a non-zero
			// exit code (runScriptRaw treats ExitCode != 0 as an error).
			// In production this happens on ctx timeout, sandbox
			// overload, or transient lxc-attach errors.
			return &sandbox.ExecResult{
				ExitCode: -1,
				Stdout:   "",
				Stderr:   "command timed out",
			}, nil
		default:
			// node_install.sh, install playwright, write bridge.js —
			// all succeed.
			return &sandbox.ExecResult{ExitCode: 0}, nil
		}
	}

	prev := healthPollInterval
	healthPollInterval = 5 * time.Millisecond
	defer func() { healthPollInterval = prev }()

	if err := EnsureBridge(nil, sbID); err != nil {
		t.Fatalf("EnsureBridge should not fail when probe fails (should fall through to install): %v", err)
	}

	// Must have fallen through to the install branch despite the probe
	// failure. Without the fix, EnsureBridge would return immediately
	// at the probe step and never invoke install.
	var sawInstall bool
	for _, c := range callLog {
		if strings.Contains(c, "install playwright@") {
			sawInstall = true
			break
		}
	}
	if !sawInstall {
		t.Errorf("expected install to run after probe failure (degrade gracefully); calls: %v", callLog)
	}
}

func TestEnsureBridge_StartupFailure_DumpsLog(t *testing.T) {
	defer resetExecFunc()
	ExecFunc = func(sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error) {
		// Everything succeeds except /health — never flips to OK.
		if strings.Contains(cmd, "/health") {
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "FAIL"}, nil
		}
		if strings.Contains(cmd, "bridge.log") {
			return &sandbox.ExecResult{ExitCode: 0, Stdout: "[bridge] Error: ENOENT playwright"}, nil
		}
		return &sandbox.ExecResult{ExitCode: 0}, nil
	}

	prev := healthPollInterval
	healthPollInterval = time.Millisecond
	prevTimeout := healthPollTimeout
	healthPollTimeout = 20 * time.Millisecond
	defer func() {
		healthPollInterval = prev
		healthPollTimeout = prevTimeout
	}()

	err := EnsureBridge(nil, sbID)
	if err == nil {
		t.Fatalf("expected EnsureBridge to fail when helper never becomes healthy")
	}
	if !strings.Contains(err.Error(), "bridge.log") {
		t.Fatalf("expected error to embed bridge.log contents, got: %v", err)
	}
	if !strings.Contains(err.Error(), "playwright") {
		t.Fatalf("expected error to embed the log line referencing playwright, got: %v", err)
	}
}

func TestEnsureBridge_RequiresSandboxID(t *testing.T) {
	if err := EnsureBridge(nil, ""); err == nil {
		t.Fatalf("expected error when sandboxID is empty")
	}
}

func TestCallBridge_UnwrapsDataEnvelope(t *testing.T) {
	defer resetExecFunc()
	markReady(sbID) // skip EnsureBridge cold path
	defer markNotReady(sbID)

	ExecFunc = func(_, cmd string, _ map[string]string, _ int) (*sandbox.ExecResult, error) {
		// EnsureBridge's cached-ready path still probes /health once.
		// probeHealth runs the shell pipeline ending in `echo OK || echo FAIL`;
		// the fake substitutes that final stdout.
		if strings.Contains(cmd, "/health") && strings.Contains(cmd, "grep") {
			return &sandbox.ExecResult{ExitCode: 0, Stdout: `OK`}, nil
		}
		if !strings.Contains(cmd, "/navigate") {
			t.Errorf("unexpected cmd: %s", cmd)
		}
		return &sandbox.ExecResult{
			ExitCode: 0,
			Stdout:   `{"ok":true,"data":{"url":"https://example.com","title":"Example","status":200,"ok":true}}`,
		}, nil
	}

	body, _ := json.Marshal(map[string]any{"url": "https://example.com"})
	data, err := CallBridge(nil, sbID, "POST", "/navigate", body, 30)
	if err != nil {
		t.Fatalf("CallBridge failed: %v", err)
	}

	var got struct {
		URL    string `json:"url"`
		Title  string `json:"title"`
		Status int    `json:"status"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal data: %v", err)
	}
	if got.URL != "https://example.com" || got.Title != "Example" || got.Status != 200 {
		t.Errorf("unexpected data: %+v", got)
	}
}

func TestCallBridge_PropagatesErrorEnvelope(t *testing.T) {
	defer resetExecFunc()
	markReady(sbID)
	defer markNotReady(sbID)

	ExecFunc = func(_, cmd string, _ map[string]string, _ int) (*sandbox.ExecResult, error) {
		// probeHealth shell pipeline — fake returns the final stdout "OK".
		if strings.Contains(cmd, "/health") && strings.Contains(cmd, "grep") {
			return &sandbox.ExecResult{ExitCode: 0, Stdout: `OK`}, nil
		}
		return &sandbox.ExecResult{
			ExitCode: 0,
			Stdout:   `{"ok":false,"error":"no active session for profile \"x\""}`,
		}, nil
	}

	_, err := CallBridge(nil, sbID, "POST", "/click", []byte(`{"profile":"x"}`), 30)
	if err == nil {
		t.Fatalf("expected error from envelope")
	}
	if !strings.Contains(err.Error(), "no active session") {
		t.Errorf("expected envelope error message, got: %v", err)
	}
	// Note: an error envelope means the helper itself is fine — only the
	// business call failed (no session for that profile). The ready flag
	// MUST stay true so the next call doesn't pay a re-probe cost.
	if !isReady(sbID) {
		t.Errorf("bridge should remain ready after a business-level error envelope")
	}
}

func TestCallBridge_RejectsNonJSONResponse(t *testing.T) {
	defer resetExecFunc()
	markReady(sbID)
	defer markNotReady(sbID)

	ExecFunc = func(_, cmd string, _ map[string]string, _ int) (*sandbox.ExecResult, error) {
		if strings.Contains(cmd, "/health") && strings.Contains(cmd, "grep") {
			return &sandbox.ExecResult{ExitCode: 0, Stdout: `OK`}, nil
		}
		// The actual CallBridge hit — return non-JSON.
		return &sandbox.ExecResult{ExitCode: 0, Stdout: "<html>500 server error</html>"}, nil
	}

	_, err := CallBridge(nil, sbID, "GET", "/list-profiles", nil, 30)
	if err == nil {
		t.Fatalf("expected error for non-JSON response")
	}
	if !strings.Contains(err.Error(), "invalid JSON") {
		t.Errorf("expected invalid JSON error, got: %v", err)
	}
}

func TestCallBridge_EmptyResponseIsError(t *testing.T) {
	defer resetExecFunc()
	markReady(sbID)
	defer markNotReady(sbID)

	ExecFunc = func(_, cmd string, _ map[string]string, _ int) (*sandbox.ExecResult, error) {
		if strings.Contains(cmd, "/health") && strings.Contains(cmd, "grep") {
			return &sandbox.ExecResult{ExitCode: 0, Stdout: `OK`}, nil
		}
		return &sandbox.ExecResult{ExitCode: 0, Stdout: ""}, nil
	}

	_, err := CallBridge(nil, sbID, "GET", "/list-profiles", nil, 30)
	if err == nil {
		t.Fatalf("expected error for empty response")
	}
}

func TestCallBridge_SandboxExecFailure(t *testing.T) {
	defer resetExecFunc()
	markReady(sbID)
	defer markNotReady(sbID)

	// Even the health probe fails — propagate the error.
	ExecFunc = func(_, _ string, _ map[string]string, _ int) (*sandbox.ExecResult, error) {
		return nil, errors.New("sandbox disappeared")
	}

	_, err := CallBridge(nil, sbID, "GET", "/list-profiles", nil, 30)
	if err == nil {
		t.Fatalf("expected error")
	}
	if !strings.Contains(err.Error(), "sandbox disappeared") {
		t.Errorf("expected wrapped sandbox error, got: %v", err)
	}
	if isReady(sbID) {
		t.Errorf("expected bridge to be marked not-ready after exec failure")
	}
}

func TestCloseBridge_BestEffort(t *testing.T) {
	defer resetExecFunc()
	markReady(sbID)

	var sawKill, sawRmSocket bool
	ExecFunc = func(_, cmd string, _ map[string]string, _ int) (*sandbox.ExecResult, error) {
		if strings.Contains(cmd, "kill") {
			sawKill = true
		}
		if strings.Contains(cmd, "rm -f") && strings.Contains(cmd, socketPath) {
			sawRmSocket = true
		}
		// PID file cat returns empty → no kill arg.
		return &sandbox.ExecResult{ExitCode: 0, Stdout: ""}, nil
	}

	CloseBridge(nil, sbID)
	if isReady(sbID) {
		t.Errorf("expected bridge to be marked not-ready after CloseBridge")
	}
	if !sawRmSocket {
		t.Errorf("expected socket file cleanup; calls would be tracked by ExecFunc")
	}
	_ = sawKill // may or may not fire depending on whether PID file is read
}

func TestUnwrapBridgeEnvelope_TrimsWhitespace(t *testing.T) {
	raw := "  \n{\"ok\":true,\"data\":{\"x\":1}}  \n"
	data, err := unwrapBridgeEnvelope(raw, "GET", "/x")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(data) != `{"x":1}` {
		t.Errorf("expected {\"x\":1}, got %s", data)
	}
}
