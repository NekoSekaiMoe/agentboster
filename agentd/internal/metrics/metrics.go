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
