package agent

import (
	"encoding/json"
	"testing"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security/l0_rules"
)

// TestCheckL0GateBlocksOnCommandRule verifies the ExecuteTool L0 gate
// rejects a command that matches an L0 command-type block rule, and
// extracts the block reason. Regression test for the fix that closed
// the tools/exec → Manager.ExecuteTool security gap (this path used to
// bypass Gatekeeper entirely).
func TestCheckL0GateBlocksOnCommandRule(t *testing.T) {
	engine := l0_rules.NewEngine()
	if err := engine.AddRule(l0_rules.L0Rule{
		ID:      "rm-root",
		Type:    "command",
		Pattern: `rm\s+-rf\s+/`,
		Action:  "block",
	}); err != nil {
		t.Fatalf("AddRule: %v", err)
	}
	gk := security.NewGatekeeper(engine, nil, nil, nil, "", security.GatekeeperOptions{})

	toolInput := map[string]any{"command": "rm -rf /"}
	args, _ := json.Marshal(toolInput)
	reason, blocked := checkL0Gate(gk, toolInput, args)
	if !blocked {
		t.Fatalf("expected block, got allowed")
	}
	if reason == "" {
		t.Fatalf("expected non-empty block reason")
	}
}

// TestCheckL0GateBlocksOnPathRule covers read/write tools whose payload
// is a `path` rather than `command`. The gate must fall back to the
// path field so path-type L0 rules still match.
func TestCheckL0GateBlocksOnPathRule(t *testing.T) {
	engine := l0_rules.NewEngine()
	if err := engine.AddRule(l0_rules.L0Rule{
		ID:      "etc-shadow",
		Type:    "path",
		Pattern: `/etc/shadow`,
		Action:  "block",
	}); err != nil {
		t.Fatalf("AddRule: %v", err)
	}
	gk := security.NewGatekeeper(engine, nil, nil, nil, "", security.GatekeeperOptions{})

	toolInput := map[string]any{"path": "/etc/shadow"}
	args, _ := json.Marshal(toolInput)
	reason, blocked := checkL0Gate(gk, toolInput, args)
	if !blocked {
		t.Fatalf("expected block on /etc/shadow, got allowed")
	}
	if reason == "" {
		t.Fatalf("expected non-empty block reason")
	}
}

// TestCheckL0GateAllowsCleanCommand confirms safe commands pass the
// gate when no rule matches.
func TestCheckL0GateAllowsCleanCommand(t *testing.T) {
	engine := l0_rules.NewEngine()
	if err := engine.AddRule(l0_rules.L0Rule{
		ID:      "rm-root",
		Type:    "command",
		Pattern: `rm\s+-rf\s+/`,
		Action:  "block",
	}); err != nil {
		t.Fatalf("AddRule: %v", err)
	}
	gk := security.NewGatekeeper(engine, nil, nil, nil, "", security.GatekeeperOptions{})

	toolInput := map[string]any{"command": "ls -la"}
	args, _ := json.Marshal(toolInput)
	_, blocked := checkL0Gate(gk, toolInput, args)
	if blocked {
		t.Fatalf("expected allow for clean command")
	}
}

// TestCheckL0GateNilGatekeeper verifies the nil-safety: when manager
// has no gatekeeper wired (e.g. boot before SetGatekeeper, or a test
// harness), the gate is a no-op allow rather than a panic.
func TestCheckL0GateNilGatekeeper(t *testing.T) {
	_, blocked := checkL0Gate(nil, map[string]any{"command": "rm -rf /"}, []byte("{}"))
	if blocked {
		t.Fatalf("nil gatekeeper must allow (nil-safe), got blocked")
	}
}

// TestCheckL0GateUsesCommandOverArgsJSON verifies that when both a
// `command` field and the args JSON exist, the structured command wins
// (so regex matches against the command don't get confused by JSON
// quoting of the args blob).
func TestCheckL0GateUsesCommandOverArgsJSON(t *testing.T) {
	engine := l0_rules.NewEngine()
	if err := engine.AddRule(l0_rules.L0Rule{
		ID:      "mkfs",
		Type:    "command",
		Pattern: `\bmkfs\b`,
		Action:  "block",
	}); err != nil {
		t.Fatalf("AddRule: %v", err)
	}
	gk := security.NewGatekeeper(engine, nil, nil, nil, "", security.GatekeeperOptions{})

	// Args JSON contains "command":"echo mkfs" as a quoted string, which
	// would match if we used the raw JSON. But the structured command
	// field is "echo hello", which must NOT match.
	toolInput := map[string]any{"command": "echo hello"}
	args := []byte(`{"command":"echo mkfs"}`)
	_, blocked := checkL0Gate(gk, toolInput, args)
	if blocked {
		t.Fatalf("structured command must take precedence over args JSON; got blocked")
	}
}
