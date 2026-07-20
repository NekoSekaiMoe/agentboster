package clipboard

import "testing"

// TestInitIdempotent asserts the documented behavior of Init: it can be called
// many times safely and returns the same result every call. On a headless CI
// box Init may return an error (no display); on a developer machine with a
// display it may succeed. Both paths must be stable and panic-free, and the
// Read/Write helpers must not panic regardless of which path Init took.
func TestInitIdempotent(t *testing.T) {
	err1 := Init()
	err2 := Init()
	if err1 != err2 {
		t.Errorf("Init returned different errors across calls: %v then %v", err1, err2)
	}
	// Helpers must not panic regardless of Init outcome. We discard their
	// results; this is purely a "doesn't blow up" smoke test.
	_, _ = ReadText()
	_ = WriteText("hello")
	_, _ = ReadImage()
}

// TestWriteReadTextRoundtrip is skipped when Init fails (headless), since the
// upstream backend can't store anything without a display. On a machine with
// a clipboard, it verifies a basic write->read cycle survives intact.
func TestWriteReadTextRoundtrip(t *testing.T) {
	if err := Init(); err != nil {
		t.Skipf("clipboard backend unavailable, skipping roundtrip: %v", err)
	}
	const payload = "computer-use-mcp/clipboard: roundtrip ✦"
	if err := WriteText(payload); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	got, err := ReadText()
	if err != nil {
		t.Fatalf("ReadText: %v", err)
	}
	if got != payload {
		t.Errorf("roundtrip mismatch: got %q, want %q", got, payload)
	}
}
