package jsonstream

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestParseLine_KnownKinds(t *testing.T) {
	cases := []struct {
		name string
		line string
		wantKind EventKind
		wantMsg string
	}{
		{"log", `{"type":"log","level":"warn","message":"hi"}`, KindLog, "hi"},
		{"progress", `{"type":"progress","current":3,"total":10,"label":"scanning"}`, KindProgress, ""},
		{"result", `{"type":"result","data":{"x":1}}`, KindResult, ""},
		{"error", `{"type":"error","message":"boom","code":"E001"}`, KindError, "boom"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ev, err := ParseLine(c.line)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if ev.Kind != c.wantKind {
				t.Errorf("kind: got %q want %q", ev.Kind, c.wantKind)
			}
			if c.wantMsg != "" && ev.Message != c.wantMsg {
				t.Errorf("message: got %q want %q", ev.Message, c.wantMsg)
			}
		})
	}
}

func TestParseLine_NonJSONFallsBackToLog(t *testing.T) {
	ev, err := ParseLine("just plain text")
	if err == nil {
		t.Fatal("expected non-nil error for non-JSON line")
	}
	if ev.Kind != KindLog {
		t.Errorf("fallback kind: got %q want log", ev.Kind)
	}
	if ev.Message != "just plain text" {
		t.Errorf("fallback message should preserve raw line, got %q", ev.Message)
	}
	if ev.Level != "info" {
		t.Errorf("fallback level default: got %q want info", ev.Level)
	}
}

func TestParseLine_MissingTypeDefaultsToLog(t *testing.T) {
	// Valid JSON, but no `type` field. Should default to log, not error.
	ev, err := ParseLine(`{"message":"hello"}`)
	if err != nil {
		t.Fatalf("missing-type should not error, got %v", err)
	}
	if ev.Kind != KindLog {
		t.Errorf("missing-type kind: got %q want log", ev.Kind)
	}
	if ev.Message != "hello" {
		t.Errorf("message: got %q want hello", ev.Message)
	}
}

func TestParseLine_UnknownTypeDefaultsToLog(t *testing.T) {
	// Valid JSON with an unrecognized `type` value. Should not error, and
	// Kind should fall back to KindLog so partially-conforming children
	// still surface their text. The message must be preserved verbatim.
	ev, err := ParseLine(`{"type":"totally_unknown","message":"hey"}`)
	if err != nil {
		t.Fatalf("unknown-type should not error, got %v", err)
	}
	if ev.Kind != KindLog {
		t.Errorf("unknown-type kind: got %q want log", ev.Kind)
	}
	if ev.Message != "hey" {
		t.Errorf("message should be preserved, got %q want hey", ev.Message)
	}
}

func TestParseLine_MissingTypeWithoutMessageUsesRawLine(t *testing.T) {
	ev, err := ParseLine(`{"foo":1}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Kind != KindLog {
		t.Errorf("kind: got %q want log", ev.Kind)
	}
	// No "message" field -> fall back to raw line
	if ev.Message != `{"foo":1}` {
		t.Errorf("expected raw line as message, got %q", ev.Message)
	}
}

func TestParseLine_BlankLineReturnsEOF(t *testing.T) {
	for _, blank := range []string{"", "   ", "\t"} {
		_, err := ParseLine(blank)
		if !errors.Is(err, io.EOF) {
			t.Errorf("blank line %q: expected io.EOF, got %v", blank, err)
		}
	}
}

func TestParseLine_ProgressPointers(t *testing.T) {
	ev, err := ParseLine(`{"type":"progress","current":5,"total":20}`)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if ev.Current == nil || *ev.Current != 5 {
		t.Errorf("current: got %v", ev.Current)
	}
	if ev.Total == nil || *ev.Total != 20 {
		t.Errorf("total: got %v", ev.Total)
	}
}

func TestParseLine_ResultDataRawJSON(t *testing.T) {
	ev, err := ParseLine(`{"type":"result","data":{"nested":{"a":1}}}`)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(ev.Data) == 0 {
		t.Fatal("expected non-empty Data payload")
	}
	// Data is a RawMessage; just check it round-trips.
	got := string(ev.Data)
	if !strings.Contains(got, `"nested"`) {
		t.Errorf("expected nested payload preserved, got %s", got)
	}
}

func TestScanner_StreamOfMixedLines(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"log","level":"info","message":"starting"}`,
		``, // blank — skipped
		`{"type":"progress","current":1,"total":3}`,
		`not json at all`, // falls back to log
		`{"type":"result","data":{"answer":42}}`,
		``,
	}, "\n")
	sc := NewScanner(strings.NewReader(input))

	var kinds []EventKind
	for {
		ev, err := sc.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil && !errors.Is(err, io.EOF) {
			// Non-JSON line returns an error + a recovered event; we keep
			// going (don't break) so the fallback event is recorded.
		}
		kinds = append(kinds, ev.Kind)
	}
	want := []EventKind{KindLog, KindProgress, KindLog, KindResult}
	if len(kinds) != len(want) {
		t.Fatalf("event count: got %d want %d (%v)", len(kinds), len(want), kinds)
	}
	for i, k := range kinds {
		if k != want[i] {
			t.Errorf("kind[%d]: got %q want %q", i, k, want[i])
		}
	}
}

func TestScanner_LargeLineNotTruncated(t *testing.T) {
	// 2 MB single-line JSON result payload — must survive the scanner's
	// default 64KB cap (we raised it to 4MB).
	big := strings.Repeat("x", 2*1024*1024)
	line := `{"type":"result","data":"` + big + `"}`
	sc := NewScanner(strings.NewReader(line))
	ev, err := sc.Next()
	if errors.Is(err, io.EOF) {
		t.Fatal("expected the big line to scan, got EOF")
	}
	if ev.Kind != KindResult {
		t.Errorf("kind: got %q want result", ev.Kind)
	}
}

func TestScanner_ErrIsNilAfterCleanEOF(t *testing.T) {
	sc := NewScanner(strings.NewReader(`{"type":"log","message":"ok"}`))
	_, _ = sc.Next()
	_, _ = sc.Next() // EOF
	if err := sc.Err(); err != nil {
		t.Errorf("Err() should be nil after clean EOF, got %v", err)
	}
}
