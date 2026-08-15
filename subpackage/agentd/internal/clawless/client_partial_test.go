//go:build linux

package clawless

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// partialServer is an httptest server that records every batch POST body
// and replays a sequence of canned responses (status + body); after the
// sequence is exhausted the last response repeats. bodies[i] is the
// decoded JSON array of the i-th request.
type partialServer struct {
	srv       *httptest.Server
	responses []partialResponse
	calls     atomic.Int64
	bodies    [][]map[string]any
}

type partialResponse struct {
	status int
	body   string
}

func newPartialServer(t *testing.T, status int, body string) *partialServer {
	return newPartialServerSeq(t, []partialResponse{{status: status, body: body}})
}

func newPartialServerSeq(t *testing.T, responses []partialResponse) *partialServer {
	t.Helper()
	ps := &partialServer{responses: responses}
	ps.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch []map[string]any
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Errorf("decode request body: %v", err)
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		ps.bodies = append(ps.bodies, batch)
		n := int(ps.calls.Add(1)) - 1
		resp := responses[len(responses)-1]
		if n < len(responses) {
			resp = responses[n]
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.status)
		fmt.Fprint(w, resp.body)
	}))
	t.Cleanup(ps.srv.Close)
	return ps
}

// TestWriteReviewLogsRetriesPartial207 verifies that a 207 Multi-Status
// from the review-logs route (partial ingest failure) is surfaced instead
// of being swallowed as success, and that exactly the failed records are
// retried once with their idempotency keys unchanged (server dedups).
func TestWriteReviewLogsRetriesPartial207(t *testing.T) {
	ps := newPartialServerSeq(t, []partialResponse{
		{http.StatusMultiStatus, `{"success":true,"partial":true,"data":[{},null],"errors":[null,"boom"],"failed":1}`},
		{http.StatusOK, `{"success":true,"data":[{}]}`},
	})

	c := NewClient(ps.srv.URL, "k", nil)
	logs := []ReviewLog{
		{TaskID: "t1", SessionID: "s1", RunID: "r1", Command: "echo one", Level: "L0", Decision: "allowed", IdempotencyKey: "review:k1"},
		{TaskID: "t2", SessionID: "s1", RunID: "r1", Command: "echo two", Level: "L0", Decision: "blocked", IdempotencyKey: "review:k2"},
	}

	if err := c.WriteReviewLogs(context.Background(), logs); err != nil {
		t.Fatalf("expected retry to succeed, got error: %v", err)
	}
	if got := ps.calls.Load(); got != 2 {
		t.Fatalf("expected 2 calls (initial + one retry), got %d", got)
	}
	if len(ps.bodies) != 2 {
		t.Fatalf("recorded %d bodies, want 2", len(ps.bodies))
	}
	// The retry must contain ONLY the failed record, with its idempotency
	// key unchanged so the server dedup stays consistent.
	retry := ps.bodies[1]
	if len(retry) != 1 {
		t.Fatalf("retry batch size = %d, want 1", len(retry))
	}
	if retry[0]["idempotency_key"] != "review:k2" {
		t.Errorf("retry idempotency_key = %v, want review:k2", retry[0]["idempotency_key"])
	}
	if retry[0]["span_id"] != "review:k2" {
		t.Errorf("retry span_id = %v, want review:k2", retry[0]["span_id"])
	}
}

// TestWriteReviewLogsPartial207StillFailingErrors: when the retry also
// reports a partial failure, the call must return an error (no infinite
// retry loop).
func TestWriteReviewLogsPartial207StillFailingErrors(t *testing.T) {
	ps := newPartialServer(t, http.StatusMultiStatus,
		`{"success":true,"partial":true,"data":[null],"errors":["boom"],"failed":1}`)

	c := NewClient(ps.srv.URL, "k", nil)
	logs := []ReviewLog{{TaskID: "t1", RunID: "r1", Command: "x", IdempotencyKey: "review:k1"}}

	err := c.WriteReviewLogs(context.Background(), logs)
	if err == nil {
		t.Fatal("expected error when retry still returns partial failure")
	}
	if got := ps.calls.Load(); got != 2 {
		t.Fatalf("expected exactly 2 calls (initial + single retry), got %d", got)
	}
}

// TestWriteReviewLogs207WithoutPartialMarkerIsSuccess: a 207 whose body
// does not carry the partial-failure marker must be treated as success
// (same lenient stance as other doRequest callers).
func TestWriteReviewLogs207WithoutPartialMarkerIsSuccess(t *testing.T) {
	ps := newPartialServer(t, http.StatusMultiStatus, `{"success":true,"data":[{}]}`)
	c := NewClient(ps.srv.URL, "k", nil)
	logs := []ReviewLog{{TaskID: "t1", RunID: "r1", Command: "x", IdempotencyKey: "review:k1"}}
	if err := c.WriteReviewLogs(context.Background(), logs); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := ps.calls.Load(); got != 1 {
		t.Fatalf("expected exactly 1 call, got %d", got)
	}
}

// TestWriteToolActivityLogsRetriesPartial207 mirrors the review-logs test
// for the tool-activity route.
func TestWriteToolActivityLogsRetriesPartial207(t *testing.T) {
	ps := newPartialServerSeq(t, []partialResponse{
		{http.StatusMultiStatus, `{"success":true,"partial":true,"data":[null,{}],"errors":["db down",null],"failed":1}`},
		{http.StatusOK, `{"success":true,"data":[{}]}`},
	})

	c := NewClient(ps.srv.URL, "k", nil)
	logs := []ToolActivityLog{
		{TaskID: "t1", SessionID: "s1", RunID: "r1", ToolName: "exec", ToolCallID: "c1", IdempotencyKey: "tool:k1"},
		{TaskID: "t2", SessionID: "s1", RunID: "r1", ToolName: "exec", ToolCallID: "c2", IdempotencyKey: "tool:k2"},
	}

	if err := c.WriteToolActivityLogs(context.Background(), logs); err != nil {
		t.Fatalf("expected retry to succeed, got error: %v", err)
	}
	if got := ps.calls.Load(); got != 2 {
		t.Fatalf("expected 2 calls, got %d", got)
	}
	retry := ps.bodies[1]
	if len(retry) != 1 {
		t.Fatalf("retry batch size = %d, want 1", len(retry))
	}
	if retry[0]["idempotency_key"] != "tool:k1" {
		t.Errorf("retry idempotency_key = %v, want tool:k1", retry[0]["idempotency_key"])
	}
}

// TestWriteReviewLogsAllFailed500IsError: the all-failed path (500) is
// already a >=400 error for doRequest and must not be retried as partial.
func TestWriteReviewLogsAllFailed500IsError(t *testing.T) {
	ps := newPartialServer(t, http.StatusInternalServerError, `{"success":false,"error":"all writes failed"}`)
	c := NewClient(ps.srv.URL, "k", nil)
	logs := []ReviewLog{{TaskID: "t1", RunID: "r1", Command: "x", IdempotencyKey: "review:k1"}}
	err := c.WriteReviewLogs(context.Background(), logs)
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	if got := ps.calls.Load(); got != 1 {
		t.Fatalf("expected exactly 1 call (no partial retry for 500), got %d", got)
	}
}

// TestParsePartialCallback unit-tests the 207 body decoder: null entries
// are successes, string entries are failures, failed=0 is a success, and
// non-partial / malformed bodies yield nil.
func TestParsePartialCallback(t *testing.T) {
	got := parsePartialCallback([]byte(`{"success":true,"partial":true,"data":[{},null],"errors":[null,"e1"],"failed":1}`))
	if got == nil {
		t.Fatal("expected partial error")
	}
	if got.Failed != 1 || len(got.FailedIndexes) != 1 || got.FailedIndexes[0] != 1 {
		t.Fatalf("bad decode: %+v", got)
	}

	if parsePartialCallback([]byte(`{"success":true,"data":[]}`)) != nil {
		t.Error("non-partial body must parse as success")
	}
	if parsePartialCallback([]byte(`not json`)) != nil {
		t.Error("malformed body must parse as success")
	}
	if parsePartialCallback([]byte(`{"success":true,"partial":true,"errors":[],"failed":0}`)) != nil {
		t.Error("failed=0 must parse as success")
	}
}

// TestPartialCallbackErrorMessage asserts the error is a typed
// *PartialCallbackError for callers that want to branch on it.
func TestPartialCallbackErrorMessage(t *testing.T) {
	pErr := &PartialCallbackError{FailedIndexes: []int{1}, Errors: []string{"", "boom"}, Failed: 1}
	var target error = pErr
	var decoded *PartialCallbackError
	if !errors.As(target, &decoded) {
		t.Fatal("errors.As failed for *PartialCallbackError")
	}
	if decoded.Error() == "" {
		t.Error("Error() must be non-empty")
	}
}
