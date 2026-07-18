//go:build linux

package metrics

import (
	"strings"
	"testing"
)

// --- ToolLatency ---

func TestToolLatency_DefaultsMaxSamplesWhenZeroOrNegative(t *testing.T) {
	for _, n := range []int{0, -1, -100} {
		l := NewToolLatency(n)
		if l.maxSamples != 1000 {
			t.Errorf("NewToolLatency(%d).maxSamples = %d, want 1000", n, l.maxSamples)
		}
	}
}

func TestToolLatency_CountAndPercentileEmpty(t *testing.T) {
	l := NewToolLatency(100)
	if l.Count() != 0 {
		t.Errorf("Count on empty = %d, want 0", l.Count())
	}
	if p := l.Percentile(50); p != 0 {
		t.Errorf("Percentile on empty = %f, want 0", p)
	}
}

func TestToolLatency_PercentileBasic(t *testing.T) {
	// 0, 10, 20, ..., 90, 100 — 11 evenly-spaced samples. p50 should
	// land somewhere in the middle (around 50), p100 must be the max
	// (100), p0 must be the min (0).
	l := NewToolLatency(100)
	for i := 0; i <= 10; i++ {
		l.Record(float64(i * 10))
	}
	if got := l.Count(); got != 11 {
		t.Fatalf("Count = %d, want 11", got)
	}
	if p0 := l.Percentile(0); p0 != 0 {
		t.Errorf("Percentile(0) = %f, want 0", p0)
	}
	if p100 := l.Percentile(100); p100 != 100 {
		t.Errorf("Percentile(100) = %f, want 100", p100)
	}
	p50 := l.Percentile(50)
	if p50 < 40 || p50 > 60 {
		t.Errorf("Percentile(50) = %f, want within [40, 60]", p50)
	}
}

func TestToolLatency_RingBufferEvictsOldest(t *testing.T) {
	// maxSamples = 3: Record 4 values; the first should be evicted.
	l := NewToolLatency(3)
	l.Record(1)
	l.Record(2)
	l.Record(3)
	l.Record(4)

	if got := l.Count(); got != 3 {
		t.Fatalf("Count = %d, want 3 (ring buffer should cap)", got)
	}
	// After eviction samples are {2,3,4}; min (p0) should be 2.
	if p0 := l.Percentile(0); p0 != 2 {
		t.Errorf("Percentile(0) after eviction = %f, want 2 (oldest should be gone)", p0)
	}
	if p100 := l.Percentile(100); p100 != 4 {
		t.Errorf("Percentile(100) = %f, want 4", p100)
	}
}

// --- SubagentTokenUsage ---

func TestSubagentTokenUsage_AccumulatesPerID(t *testing.T) {
	u := NewSubagentTokenUsage()
	u.Record("sa1", 100, 50)
	u.Record("sa1", 200, 60)
	u.Record("sa2", 10, 5)

	got := u.Get("sa1")
	if got == nil {
		t.Fatal("Get(sa1) = nil, want a bucket")
	}
	if got.InputTokens != 300 {
		t.Errorf("sa1 InputTokens = %d, want 300", got.InputTokens)
	}
	if got.OutputTokens != 110 {
		t.Errorf("sa1 OutputTokens = %d, want 110", got.OutputTokens)
	}
	if got.TotalTokens != 410 {
		t.Errorf("sa1 TotalTokens = %d, want 410", got.TotalTokens)
	}
}

func TestSubagentTokenUsage_GetReturnsCopy(t *testing.T) {
	// Get documents returning a defensive copy so callers can't
	// mutate the live bucket. Verify by mutating the returned pointer
	// and confirming the next Get sees the original tally.
	u := NewSubagentTokenUsage()
	u.Record("sa1", 100, 50)

	first := u.Get("sa1")
	first.InputTokens = 99999 // mutate

	second := u.Get("sa1")
	if second.InputTokens == 99999 {
		t.Error("Get did not return a defensive copy; mutation leaked")
	}
}

func TestSubagentTokenUsage_GetUnknownID(t *testing.T) {
	u := NewSubagentTokenUsage()
	if got := u.Get("nope"); got != nil {
		t.Errorf("Get on unknown id = %+v, want nil", got)
	}
}

func TestSubagentTokenUsage_AllReturnsAllIDs(t *testing.T) {
	u := NewSubagentTokenUsage()
	u.Record("a", 1, 0)
	u.Record("b", 0, 1)
	u.Record("c", 5, 5)

	all := u.All()
	if len(all) != 3 {
		t.Fatalf("All = %d entries, want 3", len(all))
	}
	for _, id := range []string{"a", "b", "c"} {
		if _, ok := all[id]; !ok {
			t.Errorf("All missing id %q", id)
		}
	}
	// All also returns copies — verify the live store isn't exposed.
	// Go doesn't allow assigning to a map element's field directly,
	// so reassign the whole struct.
	bucket := all["a"]
	bucket.InputTokens = -1
	all["a"] = bucket
	if got := u.Get("a"); got.InputTokens == -1 {
		t.Error("All leaked mutation into the live store")
	}
}

// --- EnhancedCollector ---

func TestEnhancedCollector_LatencyTracksPerTool(t *testing.T) {
	c := NewEnhancedCollector()
	c.RecordToolLatency("read_file", 5.0)
	c.RecordToolLatency("read_file", 15.0)
	c.RecordToolLatency("write_file", 50.0)

	// Verify the latencies were tracked under their respective tool
	// names — the PrometheusExport output names them, so we grep it
	// rather than reaching into the unexported map.
	out := c.PrometheusExport()
	for _, want := range []string{"read_file", "write_file"} {
		if !strings.Contains(out, want) {
			t.Errorf("PrometheusExport missing tool %q in output:\n%s", want, out)
		}
	}
}

func TestEnhancedCollector_SubagentTokensExported(t *testing.T) {
	c := NewEnhancedCollector()
	c.RecordSubagentTokens("sa1", 100, 200)
	c.RecordSubagentTokens("sa2", 50, 50)

	out := c.PrometheusExport()
	for _, want := range []string{"sa1", "sa2"} {
		if !strings.Contains(out, want) {
			t.Errorf("PrometheusExport missing subagent %q in output:\n%s", want, out)
		}
	}
}

func TestEnhancedCollector_PrometheusExportIncludesUptime(t *testing.T) {
	c := NewEnhancedCollector()
	out := c.PrometheusExport()
	if !strings.Contains(out, "agentd_uptime_seconds") {
		t.Errorf("expected 'agentd_uptime_seconds' in Prometheus output")
	}
}

func TestEnhancedCollector_NoDataNoExportSection(t *testing.T) {
	// With no latency or token data, the export should still contain
	// the uptime metric but NOT the tool/token sections. This guards
	// against accidentally emitting empty metrics blocks that would
	// confuse scrapers.
	c := NewEnhancedCollector()
	out := c.PrometheusExport()

	if !strings.Contains(out, "agentd_uptime_seconds") {
		t.Error("uptime section missing")
	}
	if strings.Contains(out, "agentd_tool_latency_ms") {
		t.Error("tool latency section should be absent when no samples recorded")
	}
	if strings.Contains(out, "agentd_subagent_tokens_total") {
		t.Error("subagent tokens section should be absent when no usage recorded")
	}
}
