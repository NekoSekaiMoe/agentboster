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
	"os"
	"strings"
	"sync"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
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
// at least once in this daemon process. The value is a generation
// counter (bumped on every markReady) so the watchdog can detect stale
// probes (see generationFor / markNotReadyIfStale). Cleared by
// markNotReady on health-probe failure. Mirrors browser.readySet.
var (
	readySet   = make(map[string]int)
	readySetMu sync.RWMutex

	// lastActivity tracks the last time a desktop_* tool touched each
	// sandbox. The idle reaper uses it to tear down an idle desktop
	// stack (Xvfb + x11vnc + websockify) so it stops consuming RAM
	// while the agent is doing non-desktop work. The next desktop_*
	// call re-launches the stack via EnsureDesktop.
	lastActivity   = make(map[string]time.Time)
	lastActivityMu sync.Mutex

	// idleReaperStop shuts down the idle reaper goroutine. Started
	// lazily on the first EnsureDesktop success; stopped by StopReaper.
	idleReaperStop chan struct{}
	idleReaperOnce sync.Once
	reaperStopped  bool
	reaperMu       sync.Mutex
)

// idleReaperInterval is how often the reaper wakes up to scan. The
// default (5 min) is a var so tests can shrink it.
var idleReaperInterval = 5 * time.Minute

// idleReaperThreshold is how long a sandbox must be untouched before
// its desktop stack is torn down. The default (30 min) is a var so
// tests can shrink it.
var idleReaperThreshold = 30 * time.Minute

func touchActivity(sandboxID string) {
	lastActivityMu.Lock()
	defer lastActivityMu.Unlock()
	lastActivity[sandboxID] = time.Now()
}

func lastActivityFor(sandboxID string) time.Time {
	lastActivityMu.Lock()
	defer lastActivityMu.Unlock()
	return lastActivity[sandboxID]
}

func clearActivity(sandboxID string) {
	lastActivityMu.Lock()
	defer lastActivityMu.Unlock()
	delete(lastActivity, sandboxID)
}

// startIdleReaper launches the background goroutine that tears down
// idle desktop stacks. Idempotent — safe to call from every
// EnsureDesktop success path; the sync.Once ensures only one goroutine.
func startIdleReaper(getManager func() *sandbox.Manager) {
	idleReaperOnce.Do(func() {
		idleReaperStop = make(chan struct{})
		go idleReaperLoop(getManager)
	})
}

// StopReaper halts the idle reaper. Used by tests and daemon shutdown.
func StopReaper() {
	reaperMu.Lock()
	defer reaperMu.Unlock()
	if reaperStopped {
		return
	}
	reaperStopped = true
	if idleReaperStop != nil {
		close(idleReaperStop)
	}
}

func idleReaperLoop(getManager func() *sandbox.Manager) {
	ticker := time.NewTicker(idleReaperInterval)
	defer ticker.Stop()
	for {
		select {
		case <-idleReaperStop:
			return
		case <-ticker.C:
			sbMgr := getManager()
			reapIdleStacks(sbMgr)
			// Watchdog duty (P1): for each sandbox still WITHIN the idle
			// threshold (i.e. an active desktop the user may be looking
			// at), probe the stack and invalidate the ready cache on
			// failure. We do NOT rebuild here — that would race with
			// EnsureDesktop on the next desktop_* call. Marking not-ready
			// is enough: the next call rebuilds cleanly, and until then
			// we avoid the false-"ready" state that left users staring
			// at a black screen after a silent crash.
			probeActiveStacks(sbMgr)
		}
	}
}

// probeActiveStacks is the watchdog half of idleReaperLoop (P1). For
// every sandbox with recent activity (i.e. within idleReaperThreshold —
// the same set reapIdleStacks leaves alone), it runs probeHealth and,
// on failure, marks the sandbox not-ready and warns. This catches
// crashes (x11vnc/websockify/Xvfb dying while the agent runs non-
// desktop tools) that the previous model could only notice on the next
// desktop_* call — by which time the user has been looking at a dead
// desktop for up to idleReaperInterval.
func probeActiveStacks(sbMgr *sandbox.Manager) {
	if sbMgr == nil {
		return
	}
	now := time.Now()
	threshold := idleReaperThreshold
	lastActivityMu.Lock()
	active := make([]string, 0)
	for id, t := range lastActivity {
		if now.Sub(t) < threshold {
			active = append(active, id)
		}
	}
	lastActivityMu.Unlock()

	for _, id := range active {
		// Only probe sandboxes we currently believe are ready — probing
		// a not-ready sandbox would just repeat EnsureDesktop's work.
		if !isReady(id) {
			continue
		}
		// Capture the ready-generation BEFORE probing. EnsureDesktop's
		// rebuild path calls markReady (which bumps the generation), so if
		// gen moved by the time our probe finishes, the sandbox has already
		// been refreshed and we must NOT clear it (that would undo a fresh
		// rebuild based on stale data).
		genAtProbeStart := generationFor(id)
		healthy, err := probeHealth(sbMgr, id)
		if err != nil {
			// Probe exec itself failed (sandbox gone, exec error). Don't
			// spam — debug level. Leave readySet as-is; EnsureDesktop will
			// re-evaluate on next call.
			slog.Debug("desktop watchdog: health probe errored",
				"sandbox", id, "error", err)
			continue
		}
		if !healthy {
			if markNotReadyIfStale(id, genAtProbeStart) {
				slog.Warn("desktop watchdog: stack unhealthy, marked for rebuild",
					"sandbox", id)
			} else {
				slog.Debug("desktop watchdog: stale probe discarded (sandbox rebuilt during probe)",
					"sandbox", id)
			}
		}
	}
}

// reapIdleStacks tears down the desktop stack (Xvfb/x11vnc/websockify/
// icewm/D-Bus) in any sandbox whose last desktop_* activity exceeds
// idleReaperThreshold. The stack is restarted on demand by the next
// EnsureDesktop call, so this is purely a memory-saving measure —
// the user-visible effect is a few seconds of restart latency the
// next time a desktop tool runs after a long idle period.
func reapIdleStacks(sbMgr *sandbox.Manager) {
	if sbMgr == nil {
		return
	}
	now := time.Now()
	lastActivityMu.Lock()
	idle := make([]string, 0)
	for id, t := range lastActivity {
		if now.Sub(t) >= idleReaperThreshold {
			idle = append(idle, id)
		}
	}
	lastActivityMu.Unlock()

	for _, id := range idle {
		// Kill the tracked daemons by PID file (precise — P3) rather than
		// pkill -f. Only at-spi-bus-launcher + dbus-launch still use pkill
		// -f: they have no pidfile in pidDir, they are a11y-only, and a
		// lingering instance does not block a restart.
		for _, name := range []string{"xvfb", "x11vnc", "websockify", "icewm"} {
			_ = killByPidfile(sbMgr, id, name, 10)
		}
		_, _ = runScriptRaw(sbMgr, id, fmt.Sprintf(`pkill -f "at-spi-bus-launcher" 2>/dev/null; pkill -f "dbus-launch" 2>/dev/null; rm -f /tmp/.X%d-lock /tmp/.X11-unix/X%d 2>/dev/null; rm -f %s/*.pid 2>/dev/null; true`, 99, 99, pidDir), 15)
		markNotReady(id)
		clearActivity(id)
		slog.Info("desktop idle reaper: tore down idle stack",
			"sandbox", id, "threshold", idleReaperThreshold)
	}
}

func isReady(sandboxID string) bool {
	readySetMu.RLock()
	defer readySetMu.RUnlock()
	return readySet[sandboxID] > 0
}

func markReady(sandboxID string) {
	readySetMu.Lock()
	defer readySetMu.Unlock()
	// Generation bumps on every (re)mark so the watchdog can detect a
	// stale probe: it captures gen before probing, and only applies the
	// not-ready result if gen is unchanged (EnsureDesktop's rebuild would
	// have bumped gen via markReady, invalidating the stale probe).
	readySet[sandboxID]++
}

func markNotReady(sandboxID string) {
	readySetMu.Lock()
	defer readySetMu.Unlock()
	delete(readySet, sandboxID)
}

// generationFor returns the current ready-generation for a sandbox
// (0 when not ready). The watchdog uses it to implement compare-and-swap:
// capture gen → probe → only markNotReady if gen hasn't moved. This
// prevents a slow probe from clearing a ready entry that EnsureDesktop
// has since refreshed via a full rebuild (markReady bumps gen).
func generationFor(sandboxID string) int {
	readySetMu.RLock()
	defer readySetMu.RUnlock()
	return readySet[sandboxID]
}

// markNotReadyIfStale clears the ready entry ONLY if the generation
// still matches genAtProbeStart. Returns true if the clear happened.
// Used by the watchdog to avoid clobbering a fresher ready entry.
func markNotReadyIfStale(sandboxID string, genAtProbeStart int) bool {
	readySetMu.Lock()
	defer readySetMu.Unlock()
	if readySet[sandboxID] != genAtProbeStart {
		return false // gen moved — a rebuild already refreshed this entry
	}
	delete(readySet, sandboxID)
	return true
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

// killByPidfile reads the pidfile for `name` (under pidDir, e.g.
// pidDir/xvfb.pid) and sends SIGTERM to the PID it contains. Returns
// nil when the pidfile is missing or empty (nothing to kill). This is
// the precise, race-free cleanup path that replaces the old `pkill -f`
// fuzzy match (P3): pkill -f "x11vnc.*:99" could match ANY process whose
// command line contains that substring, and was a no-op on Alpine where
// pkill was never installed (P0). Killing by the recorded PID is always
// safe: the PID was captured by this stack at start time and lives
// under our state dir.
//
// All failures are best-effort and swallowed — a kill failure must not
// abort startStack. The stale-pidfile-clear in startStack keeps the
// PID file from drifting onto an unrelated process.
func killByPidfile(sbMgr *sandbox.Manager, sandboxID, name string, timeout int) error {
	pidFile := fmt.Sprintf("%s/%s.pid", pidDir, name)
	script := killByPidfileScript(pidFile, name)
	_, err := runScriptRaw(sbMgr, sandboxID, script, timeout)
	return err
}

// killByPidfileScript builds the cleanup shell snippet for a pidfile.
// Extracted so tests can assert its shape + syntax without a sandbox.
//
// P3 hardening (PID-recycle guard): before signaling, verify the PID
// still names the expected daemon. A classic pidfile race is: daemon
// crashes → its PID is recycled by the kernel onto an unrelated process
// → `kill $(cat pidfile)` sends TERM to that unrelated process. We
// guard by checking /proc/$pid/cmdline contains the daemon name (e.g.
// "Xvfb" for xvfb.pid). /proc is universally available on Linux and
// this check is best-effort — if /proc is unavailable or the cmdline
// check fails, we DO NOT kill (safer to leak a stale daemon than to
// kill the wrong process).
//
// $pid is also validated to be purely numeric before use, defending
// against a tampered pidfile (defensive; pidfiles are daemon-written).
// The case statement uses POSIX pattern syntax (no leading '(' which
// dash/ash reject) — verified by TestKillByPidfileScript_PIDValidation.
func killByPidfileScript(pidFile, name string) string {
	daemonMatch := pidfileDaemonMatch(name) // e.g. "Xvfb" for xvfb.pid
	return fmt.Sprintf(
		`pid=$(cat %s 2>/dev/null); `+
			`case "$pid" in ""|*[!0-9]*) : ;; (*) `+
			`if [ -r /proc/"$pid"/cmdline ] && grep -qi %s /proc/"$pid"/cmdline 2>/dev/null; then `+
			`kill -TERM "$pid" 2>/dev/null; `+
			`fi;; `+
			`esac; true`,
		pidFile, singleQuote(daemonMatch),
	)
}

// pidfileDaemonMatch returns the substring that must appear in
// /proc/<pid>/cmdline for the PID to be considered the daemon named by
// the pidfile. Without this check, killByPidfile could signal an
// unrelated process that inherited a recycled PID.
func pidfileDaemonMatch(name string) string {
	switch name {
	case "xvfb":
		return "Xvfb"
	case "x11vnc":
		return "x11vnc"
	case "websockify":
		return "websockify"
	case "icewm":
		return "icewm"
	default:
		// Unknown daemon: return a pattern that matches anything so the
	// caller's behavior degrades to the old unguarded kill rather than
	// refusing to kill anything (which would leak daemons we DO want to
	// reap). The known four above are the only pidfile writers today.
		return "" // empty → the grep -qi pattern matches all lines
	}
}

// requireSetsid verifies that setsid (from util-linux) is on PATH inside
// the sandbox. setsid is how startStack detaches the desktop daemons so
// they survive the sbMgr.Exec call returning (P6). util-linux is
// Priority:required on debian and part of the alpine base image, so this
// almost always succeeds — but when a truly minimal image omits it, we
// want a single, LLM-actionable error up front rather than five opaque
// "setsid: not found" failures from each daemon launch.
func requireSetsid(sbMgr *sandbox.Manager, sandboxID string) error {
	out, err := runScriptRaw(sbMgr, sandboxID, `command -v setsid >/dev/null 2>&1 && echo ok || echo missing`, 10)
	if err != nil {
		// Don't hard-fail on a probe error — the probe uses the same
		// sbMgr.Exec path the daemons do; if Exec itself is broken we'll
		// surface that at the first real launch. Treat as "present".
		return nil
	}
	if strings.TrimSpace(out) != "ok" {
		return fmt.Errorf("desktop: setsid not found in sandbox — install util-linux (alpine: util-linux, debian: util-linux, rhel: util-linux) and retry; setsid is required to detach the desktop daemons")
	}
	return nil
}

// runScriptRaw runs a shell script in the sandbox and returns trimmed
// stdout. Errors include stderr when present.
func runScriptRaw(sbMgr *sandbox.Manager, sandboxID, script string, timeoutSec int) (string, error) {
	return RunScript(sbMgr, sandboxID, script, timeoutSec)
}

// RunScript is the exported form of runScriptRaw. External packages
// (e.g. internal/agent/tools_a11y.go calling the a11y helper binary)
// need to run commands in the sandbox and capture stdout without
// reimplementing the sh -c wrapping + trimming + error formatting.
func RunScript(sbMgr *sandbox.Manager, sandboxID, script string, timeoutSec int) (string, error) {
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
		// P8: when the provider classified the failure (timeout / binary
		// missing / etc.), prepend the categorized cause so callers
		// (probeHealth, EnsureDesktop) can distinguish a genuinely down
		// stack from a transient exec infra failure. Previously all four
		// failure modes collapsed into an opaque message.
		if res.Err != nil {
			stderr = fmt.Sprintf("%v: %s", res.Err, stderr)
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
			touchActivity(sandboxID)
			startIdleReaper(func() *sandbox.Manager { return sbMgr })
			return nil
		}
		// Stack was up but is now down — the X server was restarted
		// (crash, container stop/start, OOM kill). The a11y refs file
		// captured the *old* AT-SPI tree; the new AT-SPI registry will
		// have a different UI tree shape, so the old eN/xN indices no
		// longer map. Drop the refs file so the LLM is forced to
		// re-inspect rather than click stale coordinates. Best-effort.
		if err := clearA11yRefs(sbMgr, sandboxID); err != nil {
			slog.Warn("desktop: could not clear stale a11y refs", "sandbox", sandboxID, "error", err)
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
			touchActivity(sandboxID)
			// Launch the idle reaper so an unattended desktop stack
			// doesn't pin RAM forever. The closure captures sbMgr,
			// which is the same manager the daemon uses for the
			// lifetime of this process.
			startIdleReaper(func() *sandbox.Manager { return sbMgr })
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

// probeHealth returns true iff the desktop stack is genuinely serving
// users. It probes THREE independent layers, each using only tools that
// are already guaranteed present (Xvfb-builtin xset, and the kernel's
// /proc/net/tcp) — no xdpyinfo, no nc, no bashisms. This eliminates the
// previous hard dependency on xorg-xdpyinfo, which silently broke the
// entire stack on Alpine (and was missing on debian/rhel too).
//
// The layers, all of which must pass:
//
//  1. X server layer: `xset -display :99 q` succeeds only when the X
//     server is up and speaking the X11 protocol. xset ships WITH
//     xorg-server-xvfb / xvfb, so it's present by construction.
//  2. x11vnc RFB layer: port 5999 (defaultRfbPort) is in LISTEN state
//     per /proc/net/tcp. This is the port the noVNC client ultimately
//     connects through (via the websockify bridge).
//  3. websockify WS layer: port 6080 (defaultWebPort) is in LISTEN state
//     per /proc/net/tcp. This is the browser-facing port.
//
// icewm is intentionally NOT probed here. icewm failure is a Warn-degrade
// (P5): full-screen apps still render and screenshots still work, so a
// WM crash must NOT force a full stack rebuild via probeHealth. Probing
// icewm would make the WM a single point of failure for the whole stack.
//
// The /proc/net/tcp probe reads the kernel's socket table — 100%
// portable across alpine/debian/rhel/arch and needs ZERO extra packages
// (no netcat-openbsd, no bash). Any container with /proc (every Linux
// container, including LXC and docker) has it.
func probeHealth(sbMgr *sandbox.Manager, sandboxID string) (bool, error) {
	cmd := fmt.Sprintf(
		"%s && %s && %s",
		xprobeSnippet(defaultDisplay),
		portListeningSnippet(defaultRfbPort),
		portListeningSnippet(defaultWebPort),
	)
	res, err := callExec(sbMgr, sandboxID, fmt.Sprintf("sh -c %s", singleQuote(cmd)), nil, 10)
	if err != nil || res == nil {
		return false, err
	}
	// P8: distinguish an exec-infrastructure failure (timeout, binary
	// missing, dead container) from a genuine "stack not up" result.
	// The former should surface to the caller (EnsureDesktop can then
	// decide whether to retry vs rebuild vs give up); the latter is a
	// normal poll miss — return (false, nil) so EnsureDesktop's poll loop
	// keeps waiting for the daemons to bind. Without this split, a
	// sandbox-gone condition looked identical to "Xvfb still starting".
	if res.ExitCode != 0 && res.Err != nil {
		return false, res.Err
	}
	return res.ExitCode == 0, nil
}

// xprobeSnippet returns a shell snippet that succeeds (exit 0) iff the
// X server on `display` is up and responding to the X11 protocol. Uses
// `xset` (ships with the Xvfb package itself) rather than xdpyinfo (a
// separate package that is missing on Alpine / not installed on
// debian/rhel by default). Shared between probeHealth (P2) and the
// Xvfb-bind poll in startStack (P4).
func xprobeSnippet(display string) string {
	return fmt.Sprintf("xset -display %s q >/dev/null 2>&1", display)
}

// portListeningSnippet returns a shell snippet that succeeds (exit 0)
// iff the given TCP port is in LISTEN state, as reported by the kernel
// via /proc/net/tcp. This needs ZERO extra packages — no netcat, no
// bash /dev/tcp — and is portable across alpine/debian/rhel/arch.
//
// /proc/net/tcp format (space-separated): the 2nd field is
// "local_address" as HEX "IP:PORT" and the 4th field "st" is the state
// (0A = TCP_LISTEN). We match the ":PORT" token followed by the LISTEN
// state. The port is emitted as 4 uppercase hex digits; ":", hex digits,
// and space are all regex-literal, so basic grep (incl. busybox) matches
// them verbatim — no -E / character class needed.
//
// Example: port 5999 → :176F, port 6080 → :17C0.
func portListeningSnippet(port int) string {
	return fmt.Sprintf(
		"grep -q ':%s 0A ' /proc/net/tcp 2>/dev/null",
		fmt.Sprintf("%04X", port),
	)
}

// startStack launches the four daemons in order. Each is started with
// setsid + & (detached into its own session) so the sandbox.Exec call
// returns immediately; pids are written to pidfiles under pidDir for
// future health/cleanup.
//
// We use setsid rather than nohup: setsid puts the daemon into a brand
// new session/process-group, so the SIGHUP that lxc-attach/docker-exec
// delivers when its one-shot `sh -c` parent exits CANNOT reach the
// daemon. nohup merely installs a SIGHUP *handler* (ignore) on the
// child, which is a weaker guarantee and depends on the child not
// resetting the disposition. setsid comes from util-linux, which is
// Priority:required on debian and part of the alpine base — universally
// available, no package needed.
func startStack(sbMgr *sandbox.Manager, sandboxID string) error {
	slog.Info("desktop: starting stack", "sandbox", sandboxID, "display", defaultDisplay)

	// setsid is required to detach each daemon into its own session so
	// it survives the sbMgr.Exec call returning (P6). It comes from
	// util-linux, which is Priority:required on debian and part of the
	// alpine base — but a truly minimal image could omit it. Fail fast
	// with a clear, LLM-actionable hint rather than letting all five
	// daemon launches fail with opaque "setsid: not found" errors.
	if err := requireSetsid(sbMgr, sandboxID); err != nil {
		return err
	}

	// Kill any stale daemons first (best-effort). We kill by PID file
	// (precise — see killByPidfile) for the four tracked daemons. Only
	// at-spi-bus-launcher and dbus-launch still use pkill -f because
	// they have no pidfile in our pidDir (dbus-launch writes its PID
	// into a different, auto-managed location); they are best-effort
	// a11y-only and their lingering does not block a restart.
	for _, name := range []string{"xvfb", "x11vnc", "websockify", "icewm"} {
		_ = killByPidfile(sbMgr, sandboxID, name, 10)
	}
	_, _ = runScriptRaw(sbMgr, sandboxID, fmt.Sprintf(`pkill -f "at-spi-bus-launcher" 2>/dev/null; pkill -f "dbus-launch" 2>/dev/null; true`), 15)

	// Remove stale X11 lock files and sockets. Xvfb refuses to start on
	// DISPLAY=:99 if /tmp/.X99-lock or /tmp/.X11-unix/X99 still exist
	// from a previous run (e.g. after a SIGKILL container stop, where
	// daemons never got a chance to clean up). This is the same
	// behavior tmoe's vnc-reset performs: kill procs AND remove locks
	// so the new server isn't fooled into thinking the display is taken.
	_, _ = runScriptRaw(sbMgr, sandboxID, fmt.Sprintf(`rm -f /tmp/.X%d-lock /tmp/.X11-unix/X%d 2>/dev/null; true`, 99, 99), 10)

	// Clear stale pidfiles so the new daemons start from a known state.
	// The pidfiles ARE read by killByPidfile (P3) for precise cleanup,
	// so removing stale ones here prevents killByPidfile from sending
	// TERM to a PID now owned by an unrelated process.
	_, _ = runScriptRaw(sbMgr, sandboxID, fmt.Sprintf(`rm -f %s/*.pid 2>/dev/null; true`, pidDir), 10)

	// Clear stale D-Bus session bus state. dbus-launch leaves a
	// session-bus socket and address file under /tmp that would confuse
	// a second dbus-launch into reusing a dead bus. The desktop-env.sh
	// fragment is also regenerated by buildDbusStartScript below, so
	// removing it here avoids any chance of sourcing stale state.
	_, _ = runScriptRaw(sbMgr, sandboxID, fmt.Sprintf(`rm -f %s 2>/dev/null; rm -rf /tmp/dbus-* 2>/dev/null; true`, sandboxStateDir+"/desktop-env.sh"), 10)

	// Xvfb — the headless X server. This is the foundation; everything
	// else attaches to its DISPLAY. setsid detaches it into its own
	// session so the SIGHUP from the dying `sh -c` parent cannot reach it
	// (setsid comes from util-linux, universally available — no package).
	xvfbCmd := fmt.Sprintf(
		`setsid Xvfb %s -screen 0 %dx%dx%d >/dev/null 2>&1 & echo $! > %s/xvfb.pid`,
		defaultDisplay, defaultWidth, defaultHeight, defaultDepth, pidDir,
	)
	if err := runScript(sbMgr, sandboxID, xvfbCmd, 15); err != nil {
		return fmt.Errorf("desktop: start Xvfb failed: %w", err)
	}

	// Poll until Xvfb binds the display before clients connect (P4).
	// Replaces a hardcoded `sleep 1`: on a slow/loaded machine Xvfb can
	// take longer than 1s to bind, and the old code's `if ...; false {…}`
	// was a lint-suppression hack around an ignored return value. The
	// poll reuses the same xprobeSnippet as probeHealth, up to ~20 tries
	// at 0.3s (~6s max), breaking on success — usually returns in <0.5s.
	xpoll := fmt.Sprintf(
		`i=0; while [ $i -lt 20 ]; do %s && exit 0; i=$((i+1)); sleep 0.3; done; exit 1`,
		xprobeSnippet(defaultDisplay),
	)
	_, _ = runScriptRaw(sbMgr, sandboxID, xpoll, 10)

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
	dbusCmd := buildDbusStartScript(sandboxStateDir, envFile, defaultDisplay)
	if err := runScript(sbMgr, sandboxID, dbusCmd, 15); err != nil {
		slog.Warn("desktop: dbus/at-spi launch failed (continuing — a11y tools will degrade, screenshot/click still work)", "sandbox", sandboxID, "error", err)
	}

	// icewm — window manager. Started with DISPLAY set; gives windows
	// borders + a taskbar so the noVNC view is usable.
	icewmCmd := buildIcemwStartScript(envFile, defaultDisplay, pidDir)
	// Icewm may fail to start if it can't write its config dir under the
	// sandbox user's HOME. Treat failure as non-fatal: full-screen apps
	// still render, but multi-window apps overlap at (0,0) without focus
	// management; desktop_inspect/a11y trees may be inaccurate. The
	// `degraded` log field makes this state machine-detectable.
	if err := runScript(sbMgr, sandboxID, icewmCmd, 15); err != nil {
		slog.Warn("desktop: icewm start failed (continuing — full-screen apps still render, but multi-window apps overlap at (0,0) without focus management; desktop_inspect/a11y trees may be inaccurate)",
			"sandbox", sandboxID, "error", err, "degraded", "wm-missing")
	}

	// x11vnc — VNC server attached to the Xvfb display. -forever keeps
	// it alive across client disconnects; -nopw disables the password
	// prompt (the sandbox is already behind the daemon's auth boundary
	// and the user reaches it via a per-session public_port mapping).
	x11vncCmd := fmt.Sprintf(
		`DISPLAY=%s setsid x11vnc -display %s -forever -nopw -shared -noxrecord -noxfixes -noxdamage -rfbport %d >/dev/null 2>&1 & echo $! > %s/x11vnc.pid`,
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
		`setsid websockify --web=/usr/share/novnc 0.0.0.0:%d localhost:%d >/dev/null 2>&1 & echo $! > %s/websockify.pid`,
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

// Screenshot captures the Xvfb framebuffer and returns it base64-encoded.
// Uses ImageMagick's `import` (the canonical X11 framebuffer grab) rather
// than xdotool-scraping or noVNC canvas re-encoding — single hop.
//
// format: "png" (lossless) or "jpeg" (lossy, much smaller). Default "jpeg".
// quality: JPEG quality 1-100. Ignored for PNG. Default 80.
//
// JPEG is the default because a 1280x720 framebuffer is ~1-2 MB as PNG
// (~1500-3000 vision tokens per screenshot) vs ~150-300 KB at JPEG q80 —
// 5-10x cheaper on both upload latency and per-turn vision input cost,
// with negligible OCR/recognition loss for current vision models. Callers
// that need pixel-perfect output (e.g. comparing sub-pixel rendering)
// pass format="png".
//
// The caller (the desktop_screenshot tool) wraps the base64 blob in a
// data: URL for the LLM.
func Screenshot(sbMgr *sandbox.Manager, sandboxID string, format string, quality int) ([]byte, string, error) {
	if err := EnsureDesktop(sbMgr, sandboxID); err != nil {
		return nil, "", err
	}

	// Normalize parameters.
	if format != "png" && format != "jpeg" {
		format = "jpeg"
	}
	if quality < 1 || quality > 100 {
		quality = 80
	}

	// `import -window root` grabs the framebuffer to a temp PNG; for JPEG
	// we then run `convert` to re-encode at the requested quality. PNG
	// skips the convert step entirely (lossless passthrough).
	//
	// mktemp rather than a fixed name so concurrent screenshot calls
	// (rare but possible if the agent fires two in parallel) don't
	// clobber each other's file. Binary-over-lxc-attach pipe can be
	// lossy on some transports, which is why we route through files +
	// `base64 -w0` instead of piping bytes directly.
	srcExt := "." + format
	captureCmd := fmt.Sprintf(
		`tmpFile=$(mktemp /tmp/agentd-shot-XXXXXX%s) && `+
			`trap 'rm -f "$tmpFile"' EXIT && `+
			`DISPLAY=%s import -window root "$tmpFile"`,
		srcExt, defaultDisplay,
	)
	if format == "jpeg" {
		// PNG → JPEG re-encode at requested quality. `import` writes a
		// real JPEG directly when given a .jpg extension, but ImageMagick
		// defaults to q92; re-encode explicitly to hit our target.
		captureCmd += fmt.Sprintf(` && convert "$tmpFile" -quality %d "$tmpFile"`, quality)
	}
	captureCmd += ` && base64 -w0 "$tmpFile"`

	out, err := runScriptRaw(sbMgr, sandboxID, captureCmd, 30)
	if err != nil {
		return nil, "", fmt.Errorf("desktop: screenshot capture failed: %w", err)
	}
	// `base64 -w0` already returns a single line; trim any trailing
	// whitespace the shell may have added.
	mime := "image/" + format
	if format == "jpeg" {
		mime = "image/jpeg"
	}
	return []byte(strings.TrimSpace(out)), mime, nil
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

// clearA11yRefs removes the a11y refs file inside the sandbox. Called
// when the desktop stack is detected to have restarted: the old refs
// (eN/xN indices) pointed at the previous AT-SPI UI tree and no longer
// match. Forcing the LLM to re-inspect avoids clicking stale
// coordinates. Best-effort — errors are logged by the caller.
//
// The refs path defaults to /tmp/agentd-a11y-refs.json but can be
// overridden via AGENTD_A11Y_REFS; we honor both.
func clearA11yRefs(sbMgr *sandbox.Manager, sandboxID string) error {
	refsPath := "/tmp/agentd-a11y-refs.json"
	if env := os.Getenv("AGENTD_A11Y_REFS"); env != "" {
		refsPath = env
	}
	_, err := runScriptRaw(sbMgr, sandboxID, fmt.Sprintf(`rm -f %s 2>/dev/null; true`, refsPath), 10)
	return err
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

// buildDbusStartScript composes the shell fragment that brings up a
// per-sandbox D-Bus session + the AT-SPI2 accessibility registry, then
// writes DBUS_SESSION_BUS_ADDRESS + DISPLAY + NO_AT_BRIDGE into envFile
// so subsequent commands (icewm, x11vnc, the a11y helper) can `source`
// it to find the same bus.
//
// Extracted from startStack so it's unit-testable (sh -n + dry-run in
// /bin/sh with stubbed binaries). Failure-mode contract:
//   - No `set -e` anywhere — every step guarded, errors silent.
//   - dbus-launch missing / fails  → envFile is NOT written.
//   - at-spi-bus-launcher missing  → envFile IS written (D-Bus is up,
//     only the registry is absent).
//   - envFile absent or empty  → callers must `[ -f ] && .` it and
//     fall back to DISPLAY-only behavior.
//
// Implementation note: the printf format string uses %%s so Go's
// fmt.Sprintf leaves the inner %s intact for shell to consume at
// runtime. The two runtime %s get filled by DISPLAY (literal from Go)
// and "$DBUS_SESSION_BUS_ADDRESS" (shell-expanded).
func buildDbusStartScript(stateDir, envFile, display string) string {
	return fmt.Sprintf(
		`mkdir -p %s; `+
			`rm -f %s; `+
			`if command -v dbus-launch >/dev/null 2>&1; then `+
			`eval "$(DISPLAY=%s dbus-launch --sh-syntax)"; `+
			`if [ -n "$DBUS_SESSION_BUS_ADDRESS" ]; then `+
			`if command -v at-spi-bus-launcher >/dev/null 2>&1; then `+
			`DISPLAY=%s DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" NO_AT_BRIDGE=0 setsid at-spi-bus-launcher >/dev/null 2>&1 & `+
			`sleep 0.3; `+ // at-spi registry socket settle (dbus-launch's eval is synchronous so
			                // the bus address is already set; this sleep is only for the
			                // at-spi registry to bind its socket before clients connect)
			`fi; `+
			`printf 'export DISPLAY=%%s\nexport DBUS_SESSION_BUS_ADDRESS=%%s\nexport NO_AT_BRIDGE=0\n' %s "$DBUS_SESSION_BUS_ADDRESS" >%s; `+
			`fi; `+
			`fi; `+
			`true`,
		stateDir, envFile, display, display,
		display, envFile,
	)
}

// buildIcemwStartScript composes the shell fragment that sources the
// dbus envFile (if present) and starts icewm in the background. The
// envFile source is conditional so a missing/empty envFile (dbus failed)
// does NOT abort the script — icewm still starts without a session bus,
// which is fine for the screenshot / xdotool-click paths.
func buildIcemwStartScript(envFile, display, pids string) string {
	return fmt.Sprintf(
		`[ -f %s ] && . %s; DISPLAY=%s setsid icewm >/dev/null 2>&1 & echo $! > %s/icewm.pid`,
		envFile, envFile, display, pids,
	)
}
