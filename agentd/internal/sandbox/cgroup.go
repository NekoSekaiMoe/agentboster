//go:build linux
// +build linux

package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// CgroupSample is a single sandbox's resource usage snapshot read from
// the host-side cgroup v2 hierarchy. All fields are -1 when reading is
// unavailable (cgroup v1, missing sandbox, kernel without accounting).
//
//   - CPUUsec: user + system CPU consumed by the cgroup (microseconds)
//   - MemoryCurrent: current resident memory (bytes)
//   - MemoryMax: peak resident memory (bytes)
//   - PidsCurrent: current process count
//   - ReadErrors: number of files that could not be parsed (for debug)
type CgroupSample struct {
	SandboxID     string `json:"sandbox_id"`
	CPUUsec       int64  `json:"cpu_usec"`
	MemoryCurrent int64  `json:"memory_current"`
	MemoryMax     int64  `json:"memory_max"`
	PidsCurrent   int64  `json:"pids_current"`
	ReadErrors    int    `json:"read_errors"`
}

// cgroupPathCache maps sandbox id → resolved cgroup v2 path (or "" when
// no path could be found). Negative lookups are cached too so we don't
// fork docker inspect / glob on every metrics tick.
var (
	cgroupPathCacheMu sync.RWMutex
	cgroupPathCache   = make(map[string]string)
)

// ResolveCgroupPath returns the host-side cgroup v2 path for a sandbox
// of the given type, or "" when none can be found. The lookup is
// cached for the lifetime of the process — cgroup paths don't move
// once a container is created.
//
// Heuristics (tried in order):
//  1. Docker (light + strict): glob /sys/fs/cgroup/system.slice/docker-<id>*,
//     then /sys/fs/cgroup/docker/<id>, then the legacy
//     /sys/fs/cgroup/systemd/docker-<id>*
//  2. LXC: /sys/fs/cgroup/lxc.payload.<path>, where path is the
//     container name (stored as Sandbox.Path by the LXC provider).
//  3. Other types: not supported → returns "".
//
// All filesystem access is bounded and any error becomes a ""
// (no sample is better than a wrong sample).
func ResolveCgroupPath(sandboxType, sandboxID, sandboxPath string) string {
	key := sandboxType + "/" + sandboxID
	cgroupPathCacheMu.RLock()
	cached, ok := cgroupPathCache[key]
	cgroupPathCacheMu.RUnlock()
	if ok {
		return cached
	}

	resolved := cgroupPathResolver(sandboxType, sandboxID, sandboxPath)

	cgroupPathCacheMu.Lock()
	cgroupPathCache[key] = resolved
	cgroupPathCacheMu.Unlock()
	return resolved
}

// cgroupPathResolver is the live resolver. Indirected as a var so
// tests can swap it without depending on real /sys/fs/cgroup layout.
var cgroupPathResolver = resolveCgroupPathUncached

func resolveCgroupPathUncached(sandboxType, sandboxID, sandboxPath string) string {
	const cgroupRoot = "/sys/fs/cgroup"

	switch sandboxType {
	case "docker", "docker-strict":
		// Rootless + rootful docker both expose the scope under
		// system.slice (systemd-managed) when the host uses cgroup v2.
		patterns := []string{
			filepath.Join(cgroupRoot, "system.slice", "docker-"+sandboxID+"*.scope"),
			filepath.Join(cgroupRoot, "docker", sandboxID),
			filepath.Join(cgroupRoot, "systemd", "docker-"+sandboxID+"*"),
		}
		for _, p := range patterns {
			if match, _ := filepath.Glob(p); len(match) > 0 {
				if isDir(match[0]) {
					return match[0]
				}
			}
		}
		return ""

	case "lxc":
		if sandboxPath == "" {
			return ""
		}
		candidate := filepath.Join(cgroupRoot, "lxc.payload."+sandboxPath)
		if isDir(candidate) {
			return candidate
		}
		return ""

	default:
		return ""
	}
}

// SampleCgroup reads a single cgroup v2 snapshot for the sandbox.
// Returns a zero-value sample (with ReadErrors>0) when the path is
// unknown or the files are unreadable — never returns nil so callers
// can always index into the result.
//
// On cgroup v1 hosts (or hosts without memory accounting), the values
// are -1 and the caller should treat them as "no data".
func SampleCgroup(sandboxType, sandboxID, sandboxPath string) CgroupSample {
	sample := CgroupSample{
		SandboxID:     sandboxID,
		CPUUsec:       -1,
		MemoryCurrent: -1,
		MemoryMax:     -1,
		PidsCurrent:   -1,
	}

	path := ResolveCgroupPath(sandboxType, sandboxID, sandboxPath)
	if path == "" {
		return sample
	}

	// cpu.stat (v2): contains "usage_usec <n>" lines.
	if cpuUsec, ok := readCgroupCPUStat(filepath.Join(path, "cpu.stat")); ok {
		sample.CPUUsec = cpuUsec
	} else {
		sample.ReadErrors++
	}

	// memory.current: single numeric line (bytes).
	if cur, ok := readCgroupSingleInt(filepath.Join(path, "memory.current")); ok {
		sample.MemoryCurrent = cur
	} else {
		sample.ReadErrors++
	}

	// memory.max (peak): optional — soft limit only.
	if max, ok := readCgroupSingleInt(filepath.Join(path, "memory.peak")); ok {
		sample.MemoryMax = max
	}

	// pids.current: single numeric line.
	if pids, ok := readCgroupSingleInt(filepath.Join(path, "pids.current")); ok {
		sample.PidsCurrent = pids
	} else {
		sample.ReadErrors++
	}

	return sample
}

// readCgroupCPUStat parses cpu.stat (cgroup v2) and returns the sum
// of usage_usec + user_usec + system_usec. Returns false when the
// file is missing or unparseable.
func readCgroupCPUStat(path string) (int64, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	var total int64
	found := false
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		switch fields[0] {
		case "usage_usec", "user_usec", "system_usec":
			if v, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
				total += v
				found = true
			}
		}
	}
	return total, found
}

// readCgroupSingleInt reads a single-integer cgroup control file
// (memory.current, memory.peak, pids.current). Returns false on
// missing/unparseable.
func readCgroupSingleInt(path string) (int64, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	line := strings.SplitN(strings.TrimSpace(string(data)), "\n", 2)[0]
	v, err := strconv.ParseInt(line, 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// isDir is a thin helper that returns false on any error.
func isDir(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.IsDir()
}

// SampleAllCgroups takes a snapshot of every active sandbox in the
// manager. Called by the metrics collector on each tick. Failed reads
// still produce a CgroupSample entry (with ReadErrors>0) so downstream
// consumers can tell "no data this tick" from "sandbox gone".
//
// The CPU usage number returned by cgroup v2 is a cumulative counter
// (microseconds since sandbox start). To convert to a percentage of
// one core you need to diff two samples and divide by the elapsed
// wall-clock time — we keep the raw counter here so the consumer
// (NodeSelector on the Web side) can choose its own smoothing window.
func (m *Manager) SampleAllCgroups() []CgroupSample {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]CgroupSample, 0, len(m.sandboxes))
	for id, sb := range m.sandboxes {
		out = append(out, SampleCgroup(sb.Type, id, sb.Path))
	}
	return out
}

// String is a convenience formatter for logs / debug output.
func (s CgroupSample) String() string {
	return fmt.Sprintf(
		"sb=%s cpu_usec=%d mem_cur=%d mem_peak=%d pids=%d errs=%d",
		s.SandboxID, s.CPUUsec, s.MemoryCurrent, s.MemoryMax, s.PidsCurrent, s.ReadErrors,
	)
}

// time package is imported to keep this file go-imports-stable when
// future changes add a TTL / timestamp field. Remove when this
// becomes a lint error.
var _ = time.Second
