//go:build linux
// +build linux

// Package browser manages the in-sandbox Playwright helper process.
//
// The daemon never talks CDP itself — instead it spawns a long-lived
// node.js helper (bridge.js) inside the sandbox, which holds the
// Playwright BrowserContext. Communication goes through sbMgr.Exec:
// the daemon runs a short `curl --unix-socket ...` per call. No
// sandbox-manager port forwarding is required.
//
// See README.md (Browser Automation) and LAYOUT.MD for the design.
package browser

import (
	"encoding/json"
	_ "embed"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

// ExecFunc is the sandbox-execution primitive the bridge package depends on.
// It mirrors sandbox.Manager.Exec so tests can substitute a fake without
// having to construct a real *sandbox.Manager (whose fields are private).
//
// Production code leaves this nil — runScript/runScriptRaw then call
// sbMgr.Exec directly. Tests set ExecFunc to a stub that returns canned
// outputs keyed by patterns in `cmd`.
var ExecFunc func(sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error)

// callExec is the single choke-point that respects ExecFunc overrides.
func callExec(sbMgr *sandbox.Manager, sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error) {
	if ExecFunc != nil {
		return ExecFunc(sandboxID, cmd, env, timeout)
	}
	return sbMgr.Exec(sandboxID, cmd, env, timeout)
}


//go:embed node_install.sh
var nodeInstallScript string

//go:embed bridge.js
var bridgeJS string

const (
	// socketPath is the unix-domain socket the helper listens on.
	// Lives inside /workspace so it sits on the persistent LXC rootfs
	// (sandbox-init creates /workspace as the standardized workspace dir).
	socketPath = "/workspace/browser.sock"

	// helperDir holds bridge.js + node_modules/playwright.
	helperDir = "/workspace/.local/browser-helper"

	bridgeLogPath = helperDir + "/bridge.log"
	bridgePIDPath = helperDir + "/bridge.pid"

	// nodeBinary is where node_install.sh unpacks node.js.
	nodeBinary = "$HOME/.local/node/bin/node"

	// playwrightVersion is the exact version installed inside the sandbox
	// helper dir. It MUST stay in sync with the app side (package.json);
	// a mismatch causes "browser binary not found" because the chromium
	// revision baked into each playwright release differs.
	// The idempotency short-circuit in EnsureBridge reads the installed
	// version back and re-installs if this constant has been bumped, so
	// persistent LXC sandboxes auto-upgrade on next browser_* call.
	playwrightVersion = "1.60.0"

	// callTimeoutOverhead is added on top of each CallBridge curl call to
	// give the helper room to finish its own Playwright work.
	callTimeoutOverhead = 10
)

// healthPollInterval / healthPollTimeout control the socket-readiness loop.
// Var (not const) so tests can shrink them to keep the suite fast.
var (
	healthPollInterval = 500 * time.Millisecond
	healthPollTimeout  = 90 * time.Second
)

// HelperKnown marks whether the daemon already knows the helper is up
// for a given sandbox. Reset to false by CloseBridge or by a failed
// CallBridge. Allows the hot path to skip the /health probe entirely.
type bridgeState struct {
	ready map[string]bool
}

var state = &bridgeState{ready: map[string]bool{}}

// markReady / isReady / markNotReady are tiny helpers keyed by sandbox ID.
func markReady(sandboxID string)        { state.ready[sandboxID] = true }
func markNotReady(sandboxID string)     { state.ready[sandboxID] = false }
func isReady(sandboxID string) bool     { return state.ready[sandboxID] }

// EnsureBridge brings up the in-sandbox helper if it isn't already healthy.
// Idempotent: re-entrance on an already-ready bridge is a single /health probe.
//
// Steps (only run when needed):
//  1. health probe (socket + curl /health)
//  2. node.js bootstrap (node_install.sh — fast if already installed)
//  3. npm install playwright (skipped if node_modules/playwright exists)
//  4. write bridge.js
//  5. nohup start (mirrors tools_exec.go:152)
//  6. poll /health until ready or timeout
func EnsureBridge(sbMgr *sandbox.Manager, sandboxID string) error {
	if sandboxID == "" {
		return fmt.Errorf("browser: sandbox is required (daemon must route browser_* tasks to an LXC sandbox)")
	}

	// Fast path: we already proved it's up earlier in this process.
	if isReady(sandboxID) {
		if healthy, _ := probeHealth(sbMgr, sandboxID); healthy {
			return nil
		}
		markNotReady(sandboxID)
	}

	if healthy, _ := probeHealth(sbMgr, sandboxID); healthy {
		markReady(sandboxID)
		return nil
	}

	// Step 2: node.js bootstrap.
	if err := runScript(sbMgr, sandboxID, nodeInstallScript, 600); err != nil {
		return fmt.Errorf("browser: node bootstrap failed: %w", err)
	}

	// Step 3: install playwright if the sandbox doesn't already have the
	// exact required version. The probe runs as a separate exec so the
	// caller (and tests) can distinguish "checked version" from
	// "ran npm install". This matters for persistent LXC sandboxes:
	// a previous deploy may have cached an older playwright whose baked-in
	// chromium revision differs from the daemon's current playwrightVersion,
	// causing "browser binary not found" at runtime. Reading the installed
	// version back and comparing forces a re-install on version drift.
	probeVersion := fmt.Sprintf(`if [ -d %[1]s/node_modules/playwright ]; then
  %[2]s -p "require('%[1]s/node_modules/playwright/package.json').version" 2>/dev/null || echo ""
else
  echo ""
fi
`,
		helperDir,
		nodeBinary,
	)
	probeOut, probeErr := runScriptRaw(sbMgr, sandboxID, probeVersion, 30)
	var installedVersion string
	if probeErr != nil {
		// Probe is best-effort. Common failure modes (sandbox overloaded,
		// node cold-start, transient lxc-attach error, ctx timeout) must
		// NOT take down the entire browser bridge — treat as "unknown
		// version" and fall through to the install path, which is
		// idempotent: `npm install playwright@X` no-ops if X is already
		// present, and runs normally if it isn't. Hard-failing here was
		// the previous behaviour and caused transient sandbox hiccups
		// to disable browser functionality entirely until retry.
		slog.Warn("browser: playwright version probe failed, falling back to install",
			"sandbox", sandboxID, "error", probeErr)
		installedVersion = ""
	} else {
		installedVersion = strings.TrimSpace(probeOut)
	}
	if installedVersion != playwrightVersion {
		installPlaywright := fmt.Sprintf(`set -e
helperDir=%s
nodeBin=%s
wantVersion=%s
mkdir -p "$helperDir"
cd "$helperDir"
[ -f package.json ] || $nodeBin init -y
# Load Playwright binary mirror env if node_install.sh wrote it.
[ -f "$HOME/.agentd-browser.env" ] && . "$HOME/.agentd-browser.env"
$nodeBin install playwright@"$wantVersion"
`,
			helperDir,
			nodeBinary,
			playwrightVersion,
		)
		if err := runScript(sbMgr, sandboxID, installPlaywright, 600); err != nil {
			return fmt.Errorf("browser: playwright install failed: %w", err)
		}
	}

	// Step 4: write bridge.js.
	writeBridge := fmt.Sprintf(`mkdir -p %s && cat > %s/bridge.js <<'BRIDGE_JSEOF'
%s
BRIDGE_JSEOF
`, helperDir, helperDir, bridgeJS)
	if err := runScript(sbMgr, sandboxID, writeBridge, 15); err != nil {
		return fmt.Errorf("browser: write bridge.js failed: %w", err)
	}

	// Step 5: nohup start. Pattern lifted from tools_exec.go:152.
	startCmd := fmt.Sprintf(`set -e
[ -f "$HOME/.agentd-browser.env" ] && . "$HOME/.agentd-browser.env"
cd %s
nohup %s bridge.js > %s 2>&1 & echo $! > %s
`,
		helperDir,
		nodeBinary,
		bridgeLogPath,
		bridgePIDPath,
	)
	if err := runScript(sbMgr, sandboxID, startCmd, 15); err != nil {
		return fmt.Errorf("browser: helper start failed: %w", err)
	}

	// Step 6: poll /health.
	deadline := time.Now().Add(healthPollTimeout)
	for time.Now().Before(deadline) {
		time.Sleep(healthPollInterval)
		if healthy, _ := probeHealth(sbMgr, sandboxID); healthy {
			markReady(sandboxID)
			return nil
		}
	}

	// Timed out — dump the helper log so the failure is debuggable.
	logOut, _ := runScriptRaw(sbMgr, sandboxID, fmt.Sprintf("cat %s 2>/dev/null || true", bridgeLogPath), 5)
	return fmt.Errorf(
		"browser: helper did not become healthy within %s — bridge.log:\n%s",
		healthPollTimeout, logOut,
	)
}

// CallBridge invokes the helper through sbMgr.Exec + curl over the unix socket.
// method is "GET" / "POST"; path is the URL path (e.g. "/navigate"); body is
// optional JSON (nil for GET). The helper's {ok, data, error} envelope is
// unwrapped: on success the inner `data` is returned as raw JSON; on failure
// an error is returned.
func CallBridge(
	sbMgr *sandbox.Manager,
	sandboxID string,
	method, urlPath string,
	body []byte,
	bridgeTimeoutSec int,
) (json.RawMessage, error) {
	curlTimeout := bridgeTimeoutSec + callTimeoutOverhead
	if err := EnsureBridge(sbMgr, sandboxID); err != nil {
		return nil, err
	}

	if len(body) > 0 {
		// Write the JSON body to a temp file to avoid shell-escaping a
		// potentially large blob (storageState can be tens of KB).
		// mktemp + curl --data-binary @file + rm in a single script.
		script := fmt.Sprintf(`set -e
BODY=$(mktemp /tmp/agentd-bridge-body.XXXXXX.json)
cat > "$BODY" <<'BRIDGE_BODY_EOF'
%s
BRIDGE_BODY_EOF
curl -sS --max-time %d --unix-socket %s -X %s http://localhost%s --data-binary @"$BODY"
RC=$?
rm -f "$BODY"
exit $RC
`, string(body), curlTimeout, socketPath, method, urlPath)
		out, err := runScriptRaw(sbMgr, sandboxID, script, curlTimeout+5)
		if err != nil {
			markNotReady(sandboxID)
			return nil, fmt.Errorf("browser: call failed: %w (raw: %s)", err, out)
		}
		return unwrapBridgeEnvelope(out, method, urlPath)
	}

	// No body — simple curl.
	script := fmt.Sprintf(`curl -sS --max-time %d --unix-socket %s -X %s http://localhost%s`,
		curlTimeout, socketPath, method, urlPath)
	out, err := runScriptRaw(sbMgr, sandboxID, script, curlTimeout+5)
	if err != nil {
		markNotReady(sandboxID)
		return nil, fmt.Errorf("browser: call failed: %w (raw: %s)", err, out)
	}
	return unwrapBridgeEnvelope(out, method, urlPath)
}

// unwrapBridgeEnvelope parses {ok, data, error} and returns data or an error.
func unwrapBridgeEnvelope(raw, method, urlPath string) (json.RawMessage, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("browser: empty response for %s %s", method, urlPath)
	}
	var envelope struct {
		OK    bool            `json:"ok"`
		Data  json.RawMessage `json:"data,omitempty"`
		Error string          `json:"error,omitempty"`
	}
	if err := json.Unmarshal([]byte(trimmed), &envelope); err != nil {
		// Not JSON — surface raw output for debugging.
		snippet := trimmed
		if len(snippet) > 500 {
			snippet = snippet[:500] + "..."
		}
		return nil, fmt.Errorf("browser: invalid JSON for %s %s: %s", method, urlPath, snippet)
	}
	if !envelope.OK {
		return nil, fmt.Errorf("browser: %s %s: %s", method, urlPath, envelope.Error)
	}
	return envelope.Data, nil
}

// CloseBridge stops the helper and removes the socket file.
// Optional: sandbox destruction sends SIGHUP to all backgrounded processes,
// so the helper dies on its own. This is for explicit teardown.
func CloseBridge(sbMgr *sandbox.Manager, sandboxID string) {
	markNotReady(sandboxID)
	// Read PID file, kill if present. P7 audit: shell-quote the values we
	// interpolate into the cleanup scripts even though socketPath / pid are
	// daemon-controlled today — defense in depth, and mirrors desktop's
	// singleQuote pattern. A pid file is best-effort state written by a
	// prior helper process; treat its contents as untrusted.
	pidRead, _ := runScriptRaw(sbMgr, sandboxID, fmt.Sprintf(`cat '%s' 2>/dev/null || true`, bridgePIDPath), 3)
	pid := strings.TrimSpace(pidRead)
	if pid != "" {
		_, _ = runScriptRaw(sbMgr, sandboxID, fmt.Sprintf(`kill '%s' 2>/dev/null || true`, pid), 3)
	}
	_, _ = runScriptRaw(sbMgr, sandboxID, fmt.Sprintf(`rm -f '%s' '%s' 2>/dev/null || true`, socketPath, bridgePIDPath), 3)
}

// probeHealth returns true if the helper socket exists and responds to /health.
func probeHealth(sbMgr *sandbox.Manager, sandboxID string) (bool, error) {
	cmd := fmt.Sprintf(`[ -S %s ] && curl -sS --max-time 3 --unix-socket %s http://localhost/health 2>/dev/null | grep -q '"ok":true' && echo OK || echo FAIL`,
		socketPath, socketPath)
	out, err := runScriptRaw(sbMgr, sandboxID, cmd, 5)
	if err != nil {
		return false, err
	}
	return strings.Contains(out, "OK"), nil
}

// runScript runs a sandbox script and returns an error if it exits non-zero.
// timeout is in seconds; 0 = inherit provider default.
func runScript(sbMgr *sandbox.Manager, sandboxID, cmd string, timeout int) error {
	out, err := runScriptRaw(sbMgr, sandboxID, cmd, timeout)
	if err != nil {
		if trimmed := strings.TrimSpace(out); trimmed != "" {
			return fmt.Errorf("%w: stdout=%s", err, trimmed)
		}
		return err
	}
	return nil
}

// runScriptRaw runs a sandbox script and returns the raw stdout regardless of
// exit status (best-effort — used for log-dump paths).
func runScriptRaw(sbMgr *sandbox.Manager, sandboxID, cmd string, timeout int) (string, error) {
	// sandbox.Manager.Exec takes its own `timeout` (seconds) parameter; no
	// ctx variant exists. We surface a generous timeout above the helper's
	// own Playwright call so the curl wrapper doesn't preempt legitimate work.
	result, err := callExec(sbMgr, sandboxID, cmd, nil, timeout)
	if err != nil {
		return "", err
	}
	if result == nil {
		return "", nil
	}
	if result.ExitCode != 0 {
		return result.Stdout, fmt.Errorf("exit code %d: stderr=%s", result.ExitCode, result.Stderr)
	}
	return result.Stdout, nil
}
