//go:build linux
// +build linux

package sandbox

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSampleCgroup_NoPathReturnsSentinel(t *testing.T) {
	// Clear cache so the unknown type doesn't get a stale "" from cache.
	cgroupPathCacheMu.Lock()
	cgroupPathCache = make(map[string]string)
	cgroupPathCacheMu.Unlock()

	s := SampleCgroup("kubernetes", "nope", "")
	if s.CPUUsec != -1 || s.MemoryCurrent != -1 || s.PidsCurrent != -1 {
		t.Errorf("expected sentinel -1 across the board, got %+v", s)
	}
	if s.SandboxID != "nope" {
		t.Errorf("SandboxID not echoed back: %+v", s)
	}
}

func TestSampleCgroup_ParsesV2Files(t *testing.T) {
	dir := t.TempDir()

	// cpu.stat: usage_usec + user_usec + system_usec
	if err := os.WriteFile(filepath.Join(dir, "cpu.stat"), []byte(
		"usage_usec 1000000\nuser_usec 700000\nsystem_usec 300000\nnr_periods 10\n",
	), 0o644); err != nil {
		t.Fatal(err)
	}
	// memory.current: bytes
	if err := os.WriteFile(filepath.Join(dir, "memory.current"), []byte("8388608\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// memory.peak: bytes
	if err := os.WriteFile(filepath.Join(dir, "memory.peak"), []byte("16777216\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// pids.current
	if err := os.WriteFile(filepath.Join(dir, "pids.current"), []byte("42\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Override resolver to point at our temp dir.
	origResolver := cgroupPathResolver
	cgroupPathResolver = func(_, _, _ string) string { return dir }
	defer func() { cgroupPathResolver = origResolver }()

	// Also clear cache so the override is consulted.
	cgroupPathCacheMu.Lock()
	cgroupPathCache = make(map[string]string)
	cgroupPathCacheMu.Unlock()

	s := SampleCgroup("docker", "abc", "")

	if s.CPUUsec != 2000000 {
		t.Errorf("CPUUsec = %d; want 2000000 (1M usage + 700k user + 300k system)", s.CPUUsec)
	}
	if s.MemoryCurrent != 8388608 {
		t.Errorf("MemoryCurrent = %d; want 8388608", s.MemoryCurrent)
	}
	if s.MemoryMax != 16777216 {
		t.Errorf("MemoryMax = %d; want 16777216", s.MemoryMax)
	}
	if s.PidsCurrent != 42 {
		t.Errorf("PidsCurrent = %d; want 42", s.PidsCurrent)
	}
	if s.ReadErrors != 0 {
		t.Errorf("ReadErrors = %d; want 0", s.ReadErrors)
	}
}

func TestSampleCgroup_BumpsReadErrorsOnPartialFailure(t *testing.T) {
	dir := t.TempDir()

	// Only cpu.stat exists; memory.* and pids.current are missing.
	if err := os.WriteFile(filepath.Join(dir, "cpu.stat"), []byte(
		"usage_usec 500\n",
	), 0o644); err != nil {
		t.Fatal(err)
	}

	origResolver := cgroupPathResolver
	cgroupPathResolver = func(_, _, _ string) string { return dir }
	defer func() { cgroupPathResolver = origResolver }()

	cgroupPathCacheMu.Lock()
	cgroupPathCache = make(map[string]string)
	cgroupPathCacheMu.Unlock()

	s := SampleCgroup("docker", "abc", "")

	if s.CPUUsec != 500 {
		t.Errorf("CPUUsec = %d; want 500", s.CPUUsec)
	}
	if s.MemoryCurrent != -1 {
		t.Errorf("MemoryCurrent = %d; want -1 (missing file)", s.MemoryCurrent)
	}
	if s.PidsCurrent != -1 {
		t.Errorf("PidsCurrent = %d; want -1 (missing file)", s.PidsCurrent)
	}
	// Two missing required files: memory.current + pids.current.
	if s.ReadErrors != 2 {
		t.Errorf("ReadErrors = %d; want 2", s.ReadErrors)
	}
	// memory.peak is optional and should not bump ReadErrors when absent.
	if s.MemoryMax != -1 {
		t.Errorf("MemoryMax = %d; want -1 (missing optional file)", s.MemoryMax)
	}
}

func TestResolveCgroupPath_CachesNegativeLookups(t *testing.T) {
	cgroupPathCacheMu.Lock()
	cgroupPathCache = make(map[string]string)
	cgroupPathCacheMu.Unlock()

	first := ResolveCgroupPath("unknown-type", "id1", "")
	second := ResolveCgroupPath("unknown-type", "id1", "")
	if first != "" || second != "" {
		t.Errorf("unknown type should resolve to empty, got %q / %q", first, second)
	}

	cgroupPathCacheMu.RLock()
	_, ok := cgroupPathCache["unknown-type/id1"]
	cgroupPathCacheMu.RUnlock()
	if !ok {
		t.Error("negative lookup should be cached for future calls")
	}
}

func TestReadCgroupCPUStat_ParsesAllThreeCounters(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cpu.stat")
	if err := os.WriteFile(path, []byte(
		"usage_usec 100\nuser_usec 20\nsystem_usec 30\nnr_periods 5\nnr_throttled 0\n",
	), 0o644); err != nil {
		t.Fatal(err)
	}
	v, ok := readCgroupCPUStat(path)
	if !ok {
		t.Fatal("expected ok=true")
	}
	// 100 + 20 + 30 = 150
	if v != 150 {
		t.Errorf("cpu stat sum = %d; want 150", v)
	}
}

func TestReadCgroupCPUStat_MissingFileIsFalse(t *testing.T) {
	v, ok := readCgroupCPUStat(filepath.Join(t.TempDir(), "does-not-exist"))
	if ok {
		t.Error("expected ok=false on missing file")
	}
	if v != 0 {
		t.Errorf("value = %d; want 0 on failure", v)
	}
}

func TestReadCgroupSingleInt_HandlesNonNumeric(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "memory.current")
	if err := os.WriteFile(path, []byte("not-a-number\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := readCgroupSingleInt(path); ok {
		t.Error("expected ok=false on non-numeric content")
	}
}

func TestManagerSampleAllCgroups_NoSandboxes(t *testing.T) {
	m := &Manager{
		sandboxes: make(map[string]*Sandbox),
		providers: make(map[string]SandboxProvider),
	}
	samples := m.SampleAllCgroups()
	if len(samples) != 0 {
		t.Errorf("expected 0 samples on empty manager, got %d", len(samples))
	}
}
