//go:build linux

package metrics

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// ToolLatency tracks latency statistics for tool executions.
type ToolLatency struct {
	mu       sync.Mutex
	samples  []float64
	maxSamples int
}

// NewToolLatency creates a new latency tracker.
func NewToolLatency(maxSamples int) *ToolLatency {
	if maxSamples <= 0 {
		maxSamples = 1000
	}
	return &ToolLatency{
		samples:    make([]float64, 0, maxSamples),
		maxSamples: maxSamples,
	}
}

// Record adds a latency sample (in milliseconds).
func (t *ToolLatency) Record(ms float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.samples) >= t.maxSamples {
		t.samples = t.samples[1:]
	}
	t.samples = append(t.samples, ms)
}

// Percentile returns the pth percentile (0-100).
func (t *ToolLatency) Percentile(p float64) float64 {
	t.mu.Lock()
	sorted := make([]float64, len(t.samples))
	copy(sorted, t.samples)
	t.mu.Unlock()

	if len(sorted) == 0 {
		return 0
	}
	sort.Float64s(sorted)
	idx := int(float64(len(sorted)-1) * p / 100.0)
	return sorted[idx]
}

// Count returns the number of recorded samples.
func (t *ToolLatency) Count() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.samples)
}

// SubagentTokenUsage tracks token consumption per subagent.
type SubagentTokenUsage struct {
	mu    sync.Mutex
	usage map[string]*TokenBucket
}

// TokenBucket holds token counts for a single entity.
type TokenBucket struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
	TotalTokens  int64 `json:"total_tokens"`
}

// NewSubagentTokenUsage creates a new token usage tracker.
func NewSubagentTokenUsage() *SubagentTokenUsage {
	return &SubagentTokenUsage{
		usage: make(map[string]*TokenBucket),
	}
}

// Record adds token usage for a subagent.
func (s *SubagentTokenUsage) Record(subagentID string, input, output int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.usage[subagentID]
	if !ok {
		bucket = &TokenBucket{}
		s.usage[subagentID] = bucket
	}
	bucket.InputTokens += input
	bucket.OutputTokens += output
	bucket.TotalTokens += input + output
}

// Get returns token usage for a specific subagent.
func (s *SubagentTokenUsage) Get(subagentID string) *TokenBucket {
	s.mu.Lock()
	defer s.mu.Unlock()
	if bucket, ok := s.usage[subagentID]; ok {
		cp := *bucket
		return &cp
	}
	return nil
}

// All returns all tracked subagent token usage.
func (s *SubagentTokenUsage) All() map[string]TokenBucket {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make(map[string]TokenBucket, len(s.usage))
	for k, v := range s.usage {
		result[k] = *v
	}
	return result
}

// EnhancedCollector extends the base metrics collector with tool latency
// and subagent token tracking.
type EnhancedCollector struct {
	mu             sync.RWMutex
	toolLatencies  map[string]*ToolLatency
	subagentTokens *SubagentTokenUsage
	startTime      time.Time
}

// NewEnhancedCollector creates a new enhanced metrics collector.
func NewEnhancedCollector() *EnhancedCollector {
	return &EnhancedCollector{
		toolLatencies:  make(map[string]*ToolLatency),
		subagentTokens: NewSubagentTokenUsage(),
		startTime:      time.Now(),
	}
}

// RecordToolLatency records a tool execution latency.
func (c *EnhancedCollector) RecordToolLatency(toolName string, durationMs float64) {
	c.mu.Lock()
	lat, ok := c.toolLatencies[toolName]
	if !ok {
		lat = NewToolLatency(1000)
		c.toolLatencies[toolName] = lat
	}
	c.mu.Unlock()
	lat.Record(durationMs)
}

// RecordSubagentTokens records token usage for a subagent.
func (c *EnhancedCollector) RecordSubagentTokens(subagentID string, input, output int64) {
	c.subagentTokens.Record(subagentID, input, output)
}

// PrometheusExport returns metrics in Prometheus text exposition format.
func (c *EnhancedCollector) PrometheusExport() string {
	var b strings.Builder

	b.WriteString("# HELP agentd_uptime_seconds Daemon uptime in seconds\n")
	b.WriteString("# TYPE agentd_uptime_seconds gauge\n")
	fmt.Fprintf(&b, "agentd_uptime_seconds %f\n", time.Since(c.startTime).Seconds())

	c.mu.RLock()
	for tool, lat := range c.toolLatencies {
		fmt.Fprintf(&b, "# HELP agentd_tool_latency_ms Tool execution latency for %s\n", tool)
		fmt.Fprintf(&b, "# TYPE agentd_tool_latency_ms summary\n")
		fmt.Fprintf(&b, "agentd_tool_latency_ms{tool=\"%s\",quantile=\"0.5\"} %f\n", tool, lat.Percentile(50))
		fmt.Fprintf(&b, "agentd_tool_latency_ms{tool=\"%s\",quantile=\"0.95\"} %f\n", tool, lat.Percentile(95))
		fmt.Fprintf(&b, "agentd_tool_latency_ms{tool=\"%s\",quantile=\"0.99\"} %f\n", tool, lat.Percentile(99))
		fmt.Fprintf(&b, "agentd_tool_latency_ms_count{tool=\"%s\"} %d\n", tool, lat.Count())
	}
	c.mu.RUnlock()

	usage := c.subagentTokens.All()
	if len(usage) > 0 {
		b.WriteString("# HELP agentd_subagent_tokens_total Token usage per subagent\n")
		b.WriteString("# TYPE agentd_subagent_tokens_total counter\n")
		for id, bucket := range usage {
			fmt.Fprintf(&b, "agentd_subagent_tokens_total{subagent=\"%s\",type=\"input\"} %d\n", id, bucket.InputTokens)
			fmt.Fprintf(&b, "agentd_subagent_tokens_total{subagent=\"%s\",type=\"output\"} %d\n", id, bucket.OutputTokens)
		}
	}

	return b.String()
}
