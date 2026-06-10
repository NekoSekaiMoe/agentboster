//go:build linux

package l2_auth

import (
	"strings"
	"testing"
)

func TestFormatCommandReviewHighlightsRiskySegments(t *testing.T) {
	review := FormatCommandReview(
		`echo ok && find . -type f -exec shred {} \;`,
		0.8,
		"deterministic L2 risk",
		"high",
	)

	if !strings.Contains(review, "+ echo ok") {
		t.Fatalf("expected safe segment in review, got:\n%s", review)
	}
	if !strings.Contains(review, `! find . -type f -exec shred {} \;`) {
		t.Fatalf("expected risky find segment in review, got:\n%s", review)
	}
	if !strings.Contains(review, "! Reason: deterministic L2 risk") {
		t.Fatalf("expected reason in review, got:\n%s", review)
	}
}

func TestSplitCommandSegmentsKeepsEscapedSemicolon(t *testing.T) {
	segments := splitCommandSegments(`find . -type f -exec shred {} \; && echo done`)
	if len(segments) != 2 {
		t.Fatalf("expected 2 segments, got %d: %#v", len(segments), segments)
	}
	if segments[0] != `find . -type f -exec shred {} \;` {
		t.Fatalf("unexpected first segment: %q", segments[0])
	}
}
