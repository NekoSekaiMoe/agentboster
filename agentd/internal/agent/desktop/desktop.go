// Package desktop manages the in-sandbox lightweight X11 desktop stack.
//
// Mirror of the browser bridge pattern (internal/agent/browser/), but
// simpler: no long-lived helper process, no Unix socket, no JS bridge.
// The stack is just daemons launched directly inside the sandbox via
// sbMgr.Exec: Xvfb + (session D-Bus + AT-SPI2 registry) + icewm +
// x11vnc + websockify. The daemon only ever needs to:
//
//  1. Ensure the packages are installed (desktop_install.sh — idempotent,
//     emits AGENTD_DESKTOP_INSTALL_HINT for the LLM on missing tools).
//  2. Ensure the daemons are running (pidfile probe + start if down).
//  3. Capture a screenshot from the Xvfb framebuffer (import -window root).
//
// The session D-Bus + AT-SPI2 bus pair (started between Xvfb and icewm)
// is what the a11y helper binary talks to for desktop_inspect /
// desktop_a11y_click. If they fail to start the rest of the stack still
// works for screenshot/xdotool-click paths; only a11y tools degrade.
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

	// Session D-Bus + AT-SPI2 a11y bus. Required by the a11y helper
	// (desktop_inspect/desktop_a11y_click). dbus-launch creates a
	// private session bus and prints DBUS_SESSION_BUS_ADDRESS + PID;
	// we capture the address into envFile so every subsequent daemon
	// (icewm, x11vnc, the a11y helper) can `source` it and see the
	// same bus.
	//
	// at-spi-bus-launcher is normally D-Bus-activated on first AT-SPI
	// client call, but we start it explicitly so the bus is ready
	// before any GUI app connects (avoids a race where the first app
	// registers before the registry is listening). NO_AT_BRIDGE=0
	// un-disables atk-bridge on distros that default it off.
	//
	// Failure is non-fatal: every step is guarded so the desktop
	// stack still comes up for screenshot/click via xdotool even if
	// dbus-launch or at-spi is missing; only the a11y tools degrade.
	// In particular, do NOT use `set -e` here — a missing
	// at-spi-bus-launcher must not abort the surrounding script.
	envFile := fmt.Sprintf("%s/desktop-env.sh", sandboxStateDir)
	dbusCmd := fmt.Sprintf(
		`mkdir -p %s; `+
			`rm -f %s; `+
			`if command -v dbus-launch >/dev/null 2>&1; then `+
			`eval "$(DISPLAY=%s dbus-launch --sh-syntax)"; `+
			`if [ -n "$DBUS_SESSION_BUS_ADDRESS" ]; then `+
			`if command -v at-spi-bus-launcher >/dev/null 2>&1; then `+
			`DISPLAY=%s DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" NO_AT_BRIDGE=0 nohup at-spi-bus-launcher >/dev/null 2>&1 & `+
			`sleep 1; `+ // let the registry bind its socket before clients connect
			`fi; `+
			`printf 'export DISPLAY=%s\nexport DBUS_SESSION_BUS_ADDRESS=%s\nexport NO_AT_BRIDGE=0\n' "$DBUS_SESSION_BUS_ADDRESS" >%s; `+
			`fi; `+
			`fi; `+
			`true`,
		sandboxStateDir, envFile, defaultDisplay, defaultDisplay,
		defaultDisplay, "$DBUS_SESSION_BUS_ADDRESS", envFile,
	)
	if err := runScript(sbMgr, sandboxID, dbusCmd, 15); err != nil {
		slog.Warn("desktop: dbus/at-spi launch failed (continuing — a11y tools will degrade, screenshot/click still work)", "sandbox", sandboxID, "error", err)
	}

	// icewm — window manager. Started with DISPLAY set; gives windows
	// borders + a taskbar so the noVNC view is usable.
	icewmCmd := fmt.Sprintf(
		`[ -f %s ] && . %s; DISPLAY=%s nohup icewm >/dev/null 2>&1 & echo $! > %s/icewm.pid`,
		envFile, envFile, defaultDisplay, pidDir,
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

	// `import -window root` writes a PNG to a temp file, base64-encode it,
	// then unconditionally remove the file — even on the success path.
	// We use mktemp rather than a fixed name so concurrent screenshot
	// calls (rare but possible if the agent fires two in parallel) don't
	// clobber each other's file. Binary-over-lxc-attach pipe can be
	// lossy on some transports, which is why we route through a file +
	// `base64 -w0` instead of `import png:- | base64`.
	captureCmd := fmt.Sprintf(
		`tmpFile=$(mktemp /tmp/agentd-shot-XXXXXX.png) && `+
			`trap 'rm -f "$tmpFile"' EXIT && `+
			`DISPLAY=%s import -window root "$tmpFile" && `+
			`base64 -w0 "$tmpFile"`,
		defaultDisplay,
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

// EnvFile returns the path to the shell fragment that exports the
// session D-Bus address, DISPLAY, and NO_AT_BRIDGE for this sandbox.
//
// Written by startStack after dbus-launch + at-spi-bus-launcher come
// up. Downstream tools that need to talk to the AT-SPI2 a11y bus (the
// a11y helper binary in particular) MUST `source` this file before
// exec, otherwise they will not see DBUS_SESSION_BUS_ADDRESS and will
// fail to connect to the per-session AT-SPI registry.
//
// Returns the path unconditionally; callers should handle the case
// where the file does not yet exist (startStack failed or has not run)
// by falling back to DISPLAY-only behavior.
func EnvFile() string { return sandboxStateDir + "/desktop-env.sh" }

// Click injects a mouse click at (x, y) on the Xvfb display via
// xdotool. button: 1=left (default), 2=middle, 3=right, 4=wheel-up,
// 5=wheel-down. clickCount: 1 (default), 2=double, 3=triple.
//
// We use xdotool rather than RFB injection because:
// (a) xdotool speaks XTest — the canonical X11 test extension — which
//     is more reliable than x11vnc's RFB-to-X11 bridge;
// (b) the agentd sandbox already installs xdotool as part of the
//     desktop stack (no extra deps);
// (c) it operates on the Xvfb display directly, independent of whether
//     a VNC client (x11vnc, noVNC user) is connected.
func Click(sbMgr *sandbox.Manager, sandboxID string, x, y int, button, clickCount int) error {
	if err := EnsureDesktop(sbMgr, sandboxID); err != nil {
		return err
	}
	if button < 1 || button > 5 {
		button = 1
	}
	if clickCount < 1 || clickCount > 3 {
		clickCount = 1
	}
	cmd := fmt.Sprintf(
		`DISPLAY=%s xdotoolmousemove %d %d sync && DISPLAY=%s xdotool click --repeat %d %d`,
		defaultDisplay, x, y, defaultDisplay, clickCount, button,
	)
	return runScript(sbMgr, sandboxID, cmd, 15)
}

// Type types a string into the focused window via xdotool's type
// command. Uses --clearmodifiers so any physically-held modifiers (none
// in a headless sandbox, but the flag is harmless) don't garble the
// output. delayMs adds per-keystroke delay; 0 means as fast as possible.
//
// We use xdotool type (not xdotool key for each char) because type
// handles UTF-8 properly via Xkb keymap synthesis — the alternative
// (enumerating keysyms) would force the caller to know the user's
// keymap, which is a non-starter for an AI model.
func Type(sbMgr *sandbox.Manager, sandboxID, text string, delayMs int) error {
	if err := EnsureDesktop(sbMgr, sandboxID); err != nil {
		return err
	}
	if text == "" {
		return fmt.Errorf("desktop: type text is empty")
	}
	if delayMs < 0 {
		delayMs = 0
	}
	if delayMs > 1000 {
		delayMs = 1000
	}
	// Write the text to a temp file and pipe it to xdotool — this avoids
	// any shell-quoting nightmare when the text contains quotes, $, `,
	// newlines, or any other special character. xdotool reads stdin when
	// given `--clearmodifiers --delay N -` (trailing dash = stdin).
	// We use a heredoc with quoted EOF so $ etc. are NOT expanded by the
	// outer shell; the inner xdotool sees the raw bytes.
	script := fmt.Sprintf(
		`DISPLAY=%s xdotool type --clearmodifiers --delay %d '%s'`,
		defaultDisplay, delayMs, escapeForSingleQuote(text),
	)
	return runScript(sbMgr, sandboxID, script, max(15, len(text)/10))
}

// Key presses a key or key combo (e.g. "Return", "ctrl+c", "Alt+F4",
// "ctrl+shift+t"). xdotool accepts the same keysym syntax as X11; see
// /usr/include/X11/keysymdef.h for the full list. Multiple keys are
// joined with '+' and pressed simultaneously.
//
// Use cases: dismiss a dialog (Return/Escape), close a window
// (Alt+F4), open a tab (Ctrl+T), switch workspaces, send a screenshot
// shortcut to the app under test, etc.
func Key(sbMgr *sandbox.Manager, sandboxID, keysym string) error {
	if err := EnsureDesktop(sbMgr, sandboxID); err != nil {
		return err
	}
	if keysym == "" {
		return fmt.Errorf("desktop: key keysym is empty")
	}
	// Allow only keysym-safe characters (letters, digits, +, -, _).
	// This blocks shell metacharacter injection without needing a
	// quoting function — keysyms are inherently from a small alphabet.
	if !isKeysymSafe(keysym) {
		return fmt.Errorf("desktop: invalid keysym %q (allowed: letters, digits, +, -, _)", keysym)
	}
	cmd := fmt.Sprintf(
		`DISPLAY=%s xdotool key --clearmodifiers %s`,
		defaultDisplay, keysym,
	)
	return runScript(sbMgr, sandboxID, cmd, 15)
}

// escapeForSingleQuote wraps s so it can appear inside a single-quoted
// shell string. The only character that needs escaping in this context
// is the single quote itself, escaped via the '\'' idiom (close quote,
// escaped literal quote, reopen quote).
func escapeForSingleQuote(s string) string {
	return strings.ReplaceAll(s, "'", `'\''`)
}

// isKeysymSafe returns true iff s contains only characters allowed in
// xdotool keysym expressions: letters, digits, '+', '-', '_'. This
// keeps the call site a single xdotool invocation without needing a
// generic shell-quoting helper.
func isKeysymSafe(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '+' || r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}

// max returns the larger of a and b. (Go 1.21+ has builtin max, but
// keeping this local avoids any version coupling in this file.)
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
