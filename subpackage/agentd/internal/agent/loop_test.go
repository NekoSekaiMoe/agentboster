//go:build linux

package agent

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// TestBuildProxyMessages_PreservesToolCallPairing is the P9 regression
// test. It verifies that the loop's message history — an assistant turn
// that requested a tool call, followed by the tool result — is converted
// to clawless.Message in a way that preserves the OpenAI tool-calling
// protocol invariants the upstream provider requires:
//
//  1. The assistant message carries tool_calls (not just text Content).
//  2. The tool message carries tool_call_id matching the assistant's
//     tool_call.ID.
//
// Before P9, the assistant's ToolCall was dropped (only Content stored)
// and the tool message had no tool_call_id, which orphaned every tool
// result and broke multi-turn tool calling on spec-compliant providers.
func TestBuildProxyMessages_PreservesToolCallPairing(t *testing.T) {
	args := json.RawMessage(`{"path":"/a.txt"}`)
	msgs := []Message{
		{Role: "user", Content: "read /a.txt"},
		{
			Role:    "assistant",
			Content: "",
			ToolCalls: []ToolCall{
				{ID: "call_1", Name: "read", Arguments: args},
			},
		},
		{
			Role:       "tool",
			Content:    `{"success":true,"data":"hello"}`,
			ToolCallID: "call_1",
			Name:       "read",
		},
	}

	out := buildProxyMessages(msgs)

	if len(out) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(out))
	}

	// (1) assistant message must carry the tool_call.
	assistant := out[1]
	if assistant.Role != "assistant" {
		t.Fatalf("expected assistant, got %q", assistant.Role)
	}
	if len(assistant.ToolCalls) != 1 {
		t.Fatalf("assistant must carry 1 tool_call, got %d", len(assistant.ToolCalls))
	}
	tc := assistant.ToolCalls[0]
	if tc.ID != "call_1" {
		t.Errorf("tool_call ID: want call_1, got %s", tc.ID)
	}
	if tc.Function.Name != "read" {
		t.Errorf("tool_call name: want read, got %s", tc.Function.Name)
	}
	if tc.Function.Arguments != `{"path":"/a.txt"}` {
		t.Errorf("tool_call args: want raw JSON, got %s", tc.Function.Arguments)
	}
	if tc.Type != "function" {
		t.Errorf("tool_call type: want function, got %s", tc.Type)
	}

	// (2) tool message must carry the matching tool_call_id.
	tool := out[2]
	if tool.Role != "tool" {
		t.Fatalf("expected tool, got %q", tool.Role)
	}
	if tool.ToolCallID != "call_1" {
		t.Errorf("tool_call_id: want call_1, got %s (must match the assistant tool_call.ID)", tool.ToolCallID)
	}
	if tool.Name != "read" {
		t.Errorf("tool name: want read, got %s", tool.Name)
	}
}

// TestBuildProxyMessages_TextOnlyTurn is the non-regression counterpart:
// a plain user→assistant text conversation must round-trip without
// synthesizing tool_call fields (which would also break the protocol —
// empty tool_calls arrays are rejected by some providers).
func TestBuildProxyMessages_TextOnlyTurn(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: "hello"},
	}
	out := buildProxyMessages(msgs)

	if len(out) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(out))
	}
	if out[1].Role != "assistant" {
		t.Fatalf("expected assistant, got %q", out[1].Role)
	}
	if len(out[1].ToolCalls) != 0 {
		t.Errorf("text-only assistant must not carry tool_calls, got %d", len(out[1].ToolCalls))
	}
	if out[1].ToolCallID != "" {
		t.Errorf("text-only assistant must not carry tool_call_id, got %q", out[1].ToolCallID)
	}
}

// TestClawlessMessageWireShape locks the JSON tags on clawless.Message so
// a future refactor can't silently drop the tool-calling fields from the
// wire payload. The field names must match the OpenAI spec exactly.
func TestClawlessMessageWireShape(t *testing.T) {
	m := clawless.Message{
		Role: "assistant",
		ToolCalls: []clawless.ToolCall{{
			ID:   "call_x",
			Type: "function",
			Function: clawless.ToolCallFunction{
				Name:      "read",
				Arguments: `{"path":"/x"}`,
			},
		}},
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{
		`"role":"assistant"`,
		`"tool_calls":[{"id":"call_x","type":"function","function":{"name":"read","arguments":"{\"path\":\"/x\"}"}}]`,
	} {
		if !containsStr(s, want) {
			t.Errorf("wire shape missing %q\nfull: %s", want, s)
		}
	}

	// tool result message
	tm := clawless.Message{Role: "tool", Content: "ok", ToolCallID: "call_x", Name: "read"}
	b2, err := json.Marshal(tm)
	if err != nil {
		t.Fatal(err)
	}
	s2 := string(b2)
	for _, want := range []string{
		`"role":"tool"`,
		`"tool_call_id":"call_x"`,
		`"name":"read"`,
	} {
		if !containsStr(s2, want) {
			t.Errorf("tool wire shape missing %q\nfull: %s", want, s2)
		}
	}
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// TestDropOrphanToolResults_TrimLeadingOrphan is the P9 compaction
// regression test. When compactContext's keep-N slice cuts between an
// assistant tool_call and its tool result, the kept tail starts with an
// orphan role=tool message that has no preceding assistant tool_call.
// Feeding that to the provider triggers the exact 400 P9 fixed, so
// dropOrphanToolResults must trim it — while PRESERVING other leading
// messages (system, summary).
func TestDropOrphanToolResults_TrimLeadingOrphan(t *testing.T) {
	// Simulate the kept tail after a compaction cut: the assistant that
	// emitted call_42 was in the discarded head; only its tool result
	// survived into the tail.
	msgs := []Message{
		{Role: "tool", Content: "orphan result", ToolCallID: "call_42", Name: "read"}, // orphan
		{Role: "assistant", Content: "based on the file..."},
	}
	out := dropOrphanToolResults(msgs)
	if len(out) != 1 || out[0].Role != "assistant" {
		t.Fatalf("orphan tool message must be trimmed; got %+v", out)
	}
}

// TestDropOrphanToolResults_KeepPairedToolResult verifies the happy path:
// when the assistant tool_call is in the kept slice, the tool result is
// preserved (not trimmed) — otherwise the model loses the tool's output.
func TestDropOrphanToolResults_KeepPairedToolResult(t *testing.T) {
	msgs := []Message{
		{
			Role:    "assistant",
			Content: "",
			ToolCalls: []ToolCall{
				{ID: "call_7", Name: "read", Arguments: json.RawMessage(`{}`)},
			},
		},
		{Role: "tool", Content: "result", ToolCallID: "call_7", Name: "read"},
		{Role: "assistant", Content: "final answer"},
	}
	out := dropOrphanToolResults(msgs)
	if len(out) != 3 {
		t.Fatalf("no messages should be trimmed; got %d: %+v", len(out), out)
	}
	if out[1].Role != "tool" || out[1].ToolCallID != "call_7" {
		t.Errorf("paired tool result must be kept intact; got %+v", out[1])
	}
}

// TestDropOrphanToolResults_NoToolMessages is the non-regression guard:
// a plain conversation must pass through unchanged.
func TestDropOrphanToolResults_NoToolMessages(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: "hello"},
	}
	out := dropOrphanToolResults(msgs)
	if len(out) != 2 {
		t.Fatalf("plain conversation must be unchanged; got %d", len(out))
	}
}

// TestBuildProxyMessages_PreservesAllToolCalls is the P9 regression test
// for parallel tool calls. When the model emits multiple tool_calls in
// one assistant turn, the conversation history must record ALL of them
// (not just the one the loop executes) — otherwise we silently rewrite
// the model's intent and confuse it on the next turn. The loop still
// executes only the first per turn, so only the first gets a role=tool
// result; the model observes the rest went unanswered and can retry.
func TestBuildProxyMessages_PreservesAllToolCalls(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "read two files"},
		{
			Role:    "assistant",
			Content: "",
			ToolCalls: []ToolCall{
				{ID: "call_1", Name: "read", Arguments: json.RawMessage(`{"path":"/a"}`)},
				{ID: "call_2", Name: "read", Arguments: json.RawMessage(`{"path":"/b"}`)},
			},
		},
		// Only call_1 was executed this turn; call_2 has no result yet.
		{Role: "tool", Content: "a-contents", ToolCallID: "call_1", Name: "read"},
	}
	out := buildProxyMessages(msgs)
	if len(out) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(out))
	}
	assistant := out[1]
	if len(assistant.ToolCalls) != 2 {
		t.Fatalf("assistant must carry BOTH tool_calls (faithful history); got %d", len(assistant.ToolCalls))
	}
	if assistant.ToolCalls[0].ID != "call_1" || assistant.ToolCalls[1].ID != "call_2" {
		t.Errorf("tool_call IDs not preserved: got %s, %s",
			assistant.ToolCalls[0].ID, assistant.ToolCalls[1].ID)
	}
	// Wire shape: both must serialize with their function.name/arguments.
	for i, want := range []string{"/a", "/b"} {
		if !containsStr(assistant.ToolCalls[i].Function.Arguments, want) {
			t.Errorf("tool_call[%d] arguments lost path %q; got %s", i, want, assistant.ToolCalls[i].Function.Arguments)
		}
	}
	// The tool result pairs with the executed call only.
	if out[2].ToolCallID != "call_1" {
		t.Errorf("tool result must pair with executed call_1; got %s", out[2].ToolCallID)
	}
}

// TestDropOrphanToolResults_PreservesSystemAndSummary is the regression
// test for the compactContext prefix-truncation bug. An earlier version
// of dropOrphanToolResults did msgs[firstKept:] once it found an orphan,
// which discarded EVERY leading message — including the system prompt
// (safety instructions + tool list) and the compaction summary. That
// broke the agent's safety boundary AND lost the conversation recap.
// The filter-based implementation must drop ONLY the orphan tool row
// and keep system + summary intact.
func TestDropOrphanToolResults_PreservesSystemAndSummary(t *testing.T) {
	msgs := []Message{
		{Role: "system", Content: "## safety prompt + tool list"},
		{Role: "system", Content: "## compaction summary: prior context"},
		{Role: "tool", Content: "orphan result", ToolCallID: "call_gone", Name: "read"},
		{Role: "user", Content: "next request"},
		{Role: "assistant", Content: "reply"},
	}
	out := dropOrphanToolResults(msgs)
	if len(out) != 4 {
		t.Fatalf("must drop only the orphan (5→4); got %d: %+v", len(out), out)
	}
	// System messages must survive in order.
	if out[0].Role != "system" || !strings.Contains(out[0].Content, "safety") {
		t.Errorf("first system message (safety prompt) lost: %+v", out[0])
	}
	if out[1].Role != "system" || !strings.Contains(out[1].Content, "summary") {
		t.Errorf("compaction summary lost: %+v", out[1])
	}
	// The orphan tool row must be gone; no role=tool should remain.
	for i, m := range out {
		if m.Role == "tool" {
			t.Errorf("orphan tool row survived at index %d: %+v", i, m)
		}
	}
}
