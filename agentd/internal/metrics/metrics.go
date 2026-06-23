//go:build linux
// +build linux

package metrics

import (
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Collector collects system metrics and writes them to a JSON file.
type Collector struct {
	nodeID     string
	outputPath string
	interval   time.Duration
	stopCh     chan struct{}

	// P2.3: optional source of per-agent sandbox stats. Set via
	// SetAgentStatsFn by the agent manager before the collector's
	// first tick. Returns a slice of {agent_id, sandbox_id, type}
	// records for the metrics payload.
	agentStatsFn func() []AgentStat

	// P3.3: optional source of per-sandbox cgroup v2 resource counters
	// (CPU/memory/pids). Set via SetCgroupStatsFn by main.go after
	// the sandbox manager is constructed.
	cgroupStatsFn func() []AgentCgroupStat
}

// AgentStat is a single per-agent sandbox record returned by the agent
// manager for metrics collection.
type AgentStat struct {
	AgentID     string `json:"agent_id"`
	SandboxID   string `json:"sandbox_id"`
	SandboxType string `json:"sandbox_type"`
}

// AgentCgroupStat extends AgentStat with cgroup v2 resource counters
// for the sandbox. All CgroupSample fields default to -1 on cgroup v1
// hosts or when the path can't be resolved — consumers should treat
// -1 as "no data" and skip scoring.
type AgentCgroupStat struct {
	AgentID     string `json:"agent_id"`
	SandboxID   string `json:"sandbox_id"`
	SandboxType string `json:"sandbox_type"`
	CPUUsec     int64  `json:"cpu_usec"`
	MemoryCur   int64  `json:"memory_current"`
	MemoryPeak  int64  `json:"memory_peak"`
	PidsCurrent int64  `json:"pids_current"`
}

// SetAgentStatsFn wires the per-agent stats provider (called once at
// startup, after the agent manager is constructed).
func (c *Collector) SetAgentStatsFn(fn func() []AgentStat) {
	c.agentStatsFn = fn
}

// SetCgroupStatsFn wires the cgroup resource sampler. Called once at
// startup. When unset, cgroup_stats is omitted from the metrics
// payload entirely (cgroup v1 hosts, sandboxes without accounting).
func (c *Collector) SetCgroupStatsFn(fn func() []AgentCgroupStat) {
	c.cgroupStatsFn = fn
}

// New creates and starts a background metrics collector.
func New(nodeID, outputPath string, interval time.Duration) *Collector {
	c := &Collector{
		nodeID:     nodeID,
		outputPath: outputPath,
		interval:   interval,
		stopCh:     make(chan struct{}),
	}
	go c.run()
	return c
}

// Stop signals the background goroutine to stop.
func (c *Collector) Stop() {
	close(c.stopCh)
}

func (c *Collector) run() {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.collect()
		}
	}
}

func (c *Collector) collect() {
	m := map[string]any{
		"node_id":   c.nodeID,
		"timestamp": time.Now().Unix(),
	}

	if model := getCPUModel(); model != "" {
		m["cpu_model"] = model
	}

	if loadData, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(loadData))
		if len(fields) >= 1 {
			if load, parseErr := strconv.ParseFloat(fields[0], 64); parseErr == nil {
				numCPU := float64(getNumCPU())
				if numCPU > 0 {
					m["cpu_usage"] = load / numCPU
				}
			}
		}
	}

	if memData, err := os.ReadFile("/proc/meminfo"); err == nil {
		var memTotal, memAvailable float64
		for _, line := range strings.Split(string(memData), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				val, _ := strconv.ParseFloat(fields[1], 64)
				switch fields[0] {
				case "MemTotal:":
					memTotal = val
				case "MemAvailable:":
					memAvailable = val
				}
			}
		}
		if memTotal > 0 {
			m["mem_avail"] = memAvailable / memTotal
		}
	}

	var stat syscall.Statfs_t
	if err := syscall.Statfs("/tmp/agentd", &stat); err == nil {
		total := float64(stat.Blocks) * float64(stat.Bsize)
		avail := float64(stat.Bavail) * float64(stat.Bsize)
		if total > 0 {
			m["disk_avail"] = avail / total
		}
	}

	// P2.3: per-agent sandbox snapshot for /metrics observability.
	// The stats function returns one record per active sandbox; we
	// also count them per agent for quick "is this agent using too
	// many sandboxes?" diagnostics.
	if c.agentStatsFn != nil {
		stats := c.agentStatsFn()
		if len(stats) > 0 {
			perAgent := make(map[string]int)
			for _, s := range stats {
				perAgent[s.AgentID]++
			}
			m["sandboxes"] = stats
			m["sandbox_count_per_agent"] = perAgent
			m["sandbox_count_total"] = len(stats)
		} else {
			m["sandbox_count_total"] = 0
		}
	}

	// P3.3: per-sandbox cgroup v2 resource counters. The sampler
	// returns -1 across the board on cgroup v1 hosts, so we skip the
	// payload entirely when every entry is sentinel-valued — avoids
	// shipping a useless blob of -1s every tick.
	if c.cgroupStatsFn != nil {
		samples := c.cgroupStatsFn()
		if len(samples) > 0 {
			m["cgroup_stats"] = samples
		}
	}

	data, _ := json.Marshal(m)
	os.WriteFile(c.outputPath, data, 0o644)
}

func getNumCPU() int {
	if n := os.Getenv("GOMAXPROCS"); n != "" {
		if v, err := strconv.Atoi(n); err == nil && v > 0 {
			return v
		}
	}
	out, err := exec.Command("nproc").Output()
	if err == nil {
		if v, err := strconv.Atoi(strings.TrimSpace(string(out))); err == nil && v > 0 {
			return v
		}
	}
	return 1
}

func getCPUModel() string {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "model name") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return ""
}

// Read reads the latest metrics written by the collector.
func Read(outputPath string) (map[string]any, error) {
	data, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}
