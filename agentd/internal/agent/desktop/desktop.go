// Package desktop manages the in-sandbox lightweight X11 desktop stack.
//
// Mirror of the browser bridge pattern (internal/agent/browser/), but
// simpler: no long-lived helper process, no Unix socket, no JS bridge.
// The stack is just four daemons (Xvfb + icewm + x11vnc + websockify)
// launched directly inside the sandbox via sbMgr.Exec. The daemon only
// ever needs to:
//
//  1. Ensure the packages are installed (desktop_install.sh — idempotent,
//     emits AGENTD_DESKTOP_INSTALL_HINT for the LLM on missing tools).
//  2. Ensure the four daemons are running (pidfile probe + start if down).
//  3. Capture a screenshot from the Xvfb framebuffer (import -window root).
//
// Configuration is intentionally hardcoded for the default topology:
//   - DISPLAY=:99 (overridable via AGENTD_DESKTOP_DISPLAY env in the sandbox)
//   - RFB port 5999 (5900 + 99)
//   - noVNC HTTP port 6080
//   - 1280x800x24 framebuffer
//
// The user reaches the desktop by exposing port 6080 through the existing
// sandbox.public_port tool and opening /vnc.html in a browser.
package desktop

import (
	_ "embed"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/sandbox"
)

//go:embed desktop_install.sh
var desktopInstallScript string

// Defaults — kept as vars (not consts) so tests can shrink timeouts.
var (
	healthPollInterval = 2 * time.Second
	healthPollTimeout  = 30 * time.Second
)

const (
	defaultDisplay = ":99"
	defaultRfbPort = 5999 // 5900 + 99
	defaultWebPort = 6080
	defaultWidth   = 1280
	defaultHeight  = 800
	defaultDepth   = 24

	// sandboxStateDir is where pidfiles + logs live. Persists across
	// daemon calls inside one sandbox but is wiped on sandbox destroy.
	// Lives outside /workspace so it never collides with user files.
	sandboxStateDir = "/tmp/agentd-desktop"

	helperDir    = sandboxStateDir + "/helper"
	pidDir       = sandboxStateDir + "/pids"
	logDir       = sandboxStateDir + "/logs"
	installStamp = sandboxStateDir + "/.installed"
)

// readySet tracks sandboxes whose desktop stack has been verified up
// at least once in this daemon process. Cleared by markNotReady on
// health-probe failure. Mirrors browser.readySet.
var (
	readySet   = make(map[string]bool)
	readySetMu sync.RWMutex
)

func isReady(sandboxID string) bool {
	readySetMu.RLock()
	defer readySetMu.RUnlock()
	return readySet[sandboxID]
}

func markReady(sandboxID string) {
	readySetMu.Lock()
	defer readySetMu.Unlock()
	readySet[sandboxID] = true
}

func markNotReady(sandboxID string) {
	readySetMu.Lock()
	defer readySetMu.Unlock()
	delete(readySet, sandboxID)
}

// ExecFunc mirrors browser.ExecFunc: tests substitute a stub to avoid
// having to construct a real *sandbox.Manager. Production code leaves
// this nil — runScript then calls sbMgr.Exec directly.
var ExecFunc func(sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error)

func callExec(sbMgr *sandbox.Manager, sandboxID, cmd string, env map[string]string, timeout int) (*sandbox.ExecResult, error) {
	if ExecFunc != nil {
		return ExecFunc(sandboxID, cmd, env, timeout)
	}
	return sbMgr.Exec(sandboxID, cmd, env, timeout)
}

// runScript runs a shell script in the sandbox and returns any error.
// stdout/stderr are logged at debug; an error indicates non-zero exit.
func runScript(sbMgr *sandbox.Manager, sandboxID, script string, timeoutSec int) error {
	_, err := runScriptRaw(sbMgr, sandboxID, script, timeoutSec)
	return err
}

// runScriptRaw runs a shell script in the sandbox and returns trimmed
// stdout. Errors include stderr when present.
func runScriptRaw(sbMgr *sandbox.Manager, sandboxID, script string, timeoutSec int) (string, error) {
	// `sh -s` reads the script from stdin. lxc-attach / docker exec both
	// accept it via `sh -c '...'` form; sbMgr.Exec joins argv with spaces
	// and feeds it to the container's shell. Embedding the script in a
	// single-quoted heredoc avoids shell-injection pitfalls (the script
	// body never goes through the outer shell's expansion).
	cmd := fmt.Sprintf("sh -c %s", singleQuote(script))
	res, err := callExec(sbMgr, sandboxID, cmd, nil, timeoutSec)
	if err != nil {
		return "", fmt.Errorf("exec failed: %w", err)
	}
	if res.ExitCode != 0 {
		stderr := strings.TrimSpace(res.Stderr)
		stdout := strings.TrimSpace(res.Stdout)
		if stderr == "" {
			stderr = stdout
		}
		if stderr == "" {
			stderr = fmt.Sprintf("exit code %d", res.ExitCode)
		}
		return stdout, fmt.Errorf("%s", stderr)
	}
	return strings.TrimSpace(res.Stdout), nil
}

// singleQuote wraps s in single quotes, escaping any embedded single
// quotes via the standard '\'' idiom. Used to pass a multi-line script
// to `sh -c` safely.
func singleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// EnsureDesktop is the entry point for every desktop_* tool.
// It guarantees the desktop stack is installed and running before the
// caller proceeds. Returns nil once Xvfb is reachable on DISPLAY=:99;
// returns a descriptive error (including any AGENTD_DESKTOP_INSTALL_HINT
// emitted by desktop_install.sh) otherwise.
func EnsureDesktop(sbMgr *sandbox.Manager, sandboxID string) error {
	if sandboxID == "" {
		return fmt.Errorf("desktop: sandbox is required (daemon must route desktop_* tasks to an LXC sandbox)")
	}

	// Fast path: already verified up in this daemon process.
	if isReady(sandboxID) {
		if healthy, _ := probeHealth(sbMgr, sandboxID); healthy {
			return nil
		}
		markNotReady(sandboxID)
	}

	// Step 1: install packages if missing.
	if err := ensureInstalled(sbMgr, sandboxID); err != nil {
		return err
	}

	// Step 2: start the four daemons if Xvfb is not reachable.
	if healthy, _ := probeHealth(sbMgr, sandboxID); !healthy {
		if err := startStack(sbMgr, sandboxID); err != nil {
			return err
		}
	}

	// Step 3: poll until Xvfb is reachable or timeout.
	deadline := time.Now().Add(healthPollTimeout)
	for time.Now().Before(deadline) {
		if healthy, _ := probeHealth(sbMgr, sandboxID); healthy {
			markReady(sandboxID)
			return nil
		}
		time.Sleep(healthPollInterval)
	}
	return fmt.Errorf("desktop: Xvfb not reachable on %s after %s", defaultDisplay, healthPollTimeout)
}

// ensureInstalled runs desktop_install.sh once per sandbox. The script
// is idempotent (early-exits when Xvfb + x11vnc are already on PATH),
// and on missing tools emits AGENTD_DESKTOP_INSTALL_HINT — which we
// surface verbatim in the returned error so the LLM can self-heal via
// sandbox.exec and retry.
func ensureInstalled(sbMgr *sandbox.Manager, sandboxID string) error {
	// Skip if we already installed in a previous call. The stamp file
	// survives across daemon calls inside the same sandbox lifetime.
	if out, _ := runScriptRaw(sbMgr, sandboxID, fmt.Sprintf("test -f %s && echo ok || true", installStamp), 10); out == "ok" {
		return nil
	}

	// Ensure state dirs exist before the install script writes into them.
	mkdirCmd := fmt.Sprintf("mkdir -p %s %s %s", sandboxStateDir, pidDir, logDir)
	if err := runScript(sbMgr, sandboxID, mkdirCmd, 15); err != nil {
		// Non-fatal: the dirs may already exist or the sandbox is RO; the
		// install script will emit its own error if it cannot write.
		slog.Debug("desktop: mkdir state dir failed (continuing)", "sandbox", sandboxID, "error", err)
	}

	// Run the install script (timeout 600s = 10min; large apt installs
	// on cold mirrors can take a while).
	out, err := runScriptRaw(sbMgr, sandboxID, desktopInstallScript, 600)
	if err != nil {
		// Surface install hints emitted by the script. These come on
		// stdout (script's own echo) and stderr (the explicit >&2 lines).
		hint := strings.TrimSpace(out + "\n" + err.Error())
		// Look for the structured hint marker.
		for _, line := range strings.Split(hint, "\n") {
			if strings.HasPrefix(line, "AGENTD_DESKTOP_") {
				return fmt.Errorf("desktop: install required: %s", line)
			}
		}
		return fmt.Errorf("desktop: install failed: %s", hint)
	}

	// Mark installed so subsequent calls skip the script entirely.
	_ = runScript(sbMgr, sandboxID, fmt.Sprintf("touch %s", installStamp), 5)
	slog.Info("desktop: stack installed", "sandbox", sandboxID, "output", out)
	return nil
}

// probeHealth returns true if Xvfb is reachable on DISPLAY=:99.
// `xdpyinfo -display :99` is the canonical probe; it succeeds only when
// the X server is up and speaking the X11 protocol. We accept any
// non-zero exit as "not ready" (including xdpyinfo itself missing, which
// means the install step didn't complete — caller will install+retry).
func probeHealth(sbMgr *sandbox.Manager, sandboxID string) (bool, error) {
	cmd := fmt.Sprintf("command -v xdpyinfo >/dev/null 2>&1 && xdpyinfo -display %s >/dev/null 2>&1", defaultDisplay)
	res, err := callExec(sbMgr, sandboxID, fmt.Sprintf("sh -c %s", singleQuote(cmd)), nil, 10)
	if err != nil || res == nil {
		return false, err
	}
	return res.ExitCode == 0, nil
}

// startStack launches the four daemons in order. Each is started with
// nohup + & (detached) so the sandbox.Exec call returns immediately;
// pids are written to pidfiles under pidDir for future health/cleanup.
//
// We use nohup rather than setsid/tmux/openrc because the daemons only
// need to outlive this single sbMgr.Exec call, not survive sandbox
// restart — Xvfb crashes are recovered by EnsureDesktop's poll loop on
// the next desktop_* call.
func startStack(sbMgr *sandbox.Manager, sandboxID string) error {
	slog.Info("desktop: starting stack", "sandbox", sandboxID, "display", defaultDisplay)

	// Kill any stale daemons first (best-effort).
	_, _ = runScriptRaw(sbMgr, sandboxID, fmt.Sprintf(`pkill -f "Xvfb %s" 2>/dev/null; pkill -f "x11vnc.*%s" 2>/dev/null; pkill -f "websockify.*%d" 2>/dev/null; pkill -f "icewm" 2>/dev/null; true`, defaultDisplay, defaultDisplay, defaultWebPort), 15)

	// Xvfb — the headless X server. This is the foundation; everything
	// else attaches to its DISPLAY.
	xvfbCmd := fmt.Sprintf(
		`nohup Xvfb %s -screen 0 %dx%dx%d >/dev/null 2>&1 & echo $! > %s/xvfb.pid`,
		defaultDisplay, defaultWidth, defaultHeight, defaultDepth, pidDir,
	)
	if err := runScript(sbMgr, sandboxID, xvfbCmd, 15); err != nil {
		return fmt.Errorf("desktop: start Xvfb failed: %w", err)
	}

	// Give Xvfb a moment to bind before clients connect.
	if out, _ := runScriptRaw(sbMgr, sandboxID, "sleep 1", 5); false { // keep lint quiet
		_ = out
	}

	// icewm — window manager. Started with DISPLAY set; gives windows
	// borders + a taskbar so the noVNC view is usable.
	icewmCmd := fmt.Sprintf(
		`DISPLAY=%s nohup icewm >/dev/null 2>&1 & echo $! > %s/icewm.pid`,
		defaultDisplay, pidDir,
	)
	// Icewm may fail to start if it can't write its config dir under the
	// sandbox user's HOME; treat failure as non-fatal (raw X without a
	// WM is still usable for full-screen apps).
	if err := runScript(sbMgr, sandboxID, icewmCmd, 15); err != nil {
		slog.Warn("desktop: icewm start failed (continuing — apps still work without a WM)", "sandbox", sandboxID, "error", err)
	}

	// x11vnc — VNC server attached to the Xvfb display. -forever keeps
	// it alive across client disconnects; -nopw disables the password
	// prompt (the sandbox is already behind the daemon's auth boundary
	// and the user reaches it via a per-session public_port mapping).
	x11vncCmd := fmt.Sprintf(
		`DISPLAY=%s nohup x11vnc -display %s -forever -nopw -shared -noxrecord -noxfixes -noxdamage -rfbport %d >/dev/null 2>&1 & echo $! > %s/x11vnc.pid`,
		defaultDisplay, defaultDisplay, defaultRfbPort, pidDir,
	)
	if err := runScript(sbMgr, sandboxID, x11vncCmd, 15); err != nil {
		return fmt.Errorf("desktop: start x11vnc failed: %w", err)
	}

	// websockify — bridges WebSocket (browser) → RFB (x11vnc). Serves
	// the noVNC HTML from /usr/share/novnc (the standard location for
	// the novnc package on both Alpine and Debian). User opens
	// http://<sandbox>:<WEB_PORT>/vnc.html in a browser.
	websockifyCmd := fmt.Sprintf(
		`nohup websockify --web=/usr/share/novnc 0.0.0.0:%d localhost:%d >/dev/null 2>&1 & echo $! > %s/websockify.pid`,
		defaultWebPort, defaultRfbPort, pidDir,
	)
	if err := runScript(sbMgr, sandboxID, websockifyCmd, 15); err != nil {
		return fmt.Errorf("desktop: start websockify failed: %w", err)
	}

	slog.Info("desktop: stack launched",
		"sandbox", sandboxID,
		"display", defaultDisplay,
		"rfb_port", defaultRfbPort,
		"web_port", defaultWebPort,
		"noVNC_url_path", "/vnc.html",
	)
	return nil
}

// Screenshot captures the Xvfb framebuffer as a PNG and returns it
// base64-encoded. Uses ImageMagick's `import` (the canonical X11
// framebuffer grab) rather than xdotool-scraping or noVNC canvas
// re-encoding — single hop, lossless.
//
// The caller (the desktop_screenshot tool) wraps the base64 blob in a
// data: URL for the LLM.
func Screenshot(sbMgr *sandbox.Manager, sandboxID string) ([]byte, error) {
	if err := EnsureDesktop(sbMgr, sandboxID); err != nil {
		return nil, err
	}

	// `import -window root` writes a PNG to stdout. We use a temp file
	// under the sandbox state dir to avoid base64-via-stdout encoding
	// issues (binary over the lxc-attach pipe can be lossy on some
	// transports), then base64-encode it.
	tmpFile := sandboxStateDir + "/screenshot.png"
	captureCmd := fmt.Sprintf(
		`DISPLAY=%s import -window root %s && base64 -w0 %s`,
		defaultDisplay, tmpFile, tmpFile,
	)
	out, err := runScriptRaw(sbMgr, sandboxID, captureCmd, 30)
	if err != nil {
		return nil, fmt.Errorf("desktop: screenshot capture failed: %w", err)
	}
	// `base64 -w0` already returns a single line; trim any trailing
	// whitespace the shell may have added.
	return []byte(strings.TrimSpace(out)), nil
}

// WebPort returns the noVNC HTTP port. Exposed so the desktop_screenshot
// tool result can include "open http://<node>:<port>/vnc.html to view
// the desktop" guidance for the user/model.
func WebPort() int { return defaultWebPort }

// Display returns the X11 display string (":99"). Exposed for the
// screenshot tool description and for downstream tools that need to
// inject mouse/keyboard events via xdotool (future desktop_* tools).
func Display() string { return defaultDisplay }

// itoa avoids strconv import in this file (matches web_extract.go's
// style for keeping file deps minimal).
func itoa(i int) string { return strconv.Itoa(i) }
