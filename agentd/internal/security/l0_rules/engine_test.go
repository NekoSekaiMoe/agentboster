//go:build linux

package l0_rules

import "testing"

func TestEngineBlocksMatchingRule(t *testing.T) {
	engine := NewEngine()
	if err := engine.Reload([]L0Rule{{
		ID:      "block-rm",
		Pattern: "rm -rf",
		Type:    "command",
		Action:  "block",
	}}); err != nil {
		t.Fatalf("reload: %v", err)
	}

	result, err := engine.Check("rm -rf /tmp/example", "")
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if result == nil || !result.Blocked {
		t.Fatalf("expected command to be blocked")
	}
}

func TestEngineInvalidRuleReturnsError(t *testing.T) {
	engine := NewEngine()
	if err := engine.AddRule(L0Rule{
		ID:      "bad-regex",
		Pattern: "[",
		Type:    "command",
		Action:  "block",
	}); err != nil {
		t.Fatalf("add rule: %v", err)
	}

	if _, err := engine.Check("echo ok", ""); err == nil {
		t.Fatalf("expected invalid rule to return an error")
	}
}
