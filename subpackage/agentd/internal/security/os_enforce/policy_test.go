//go:build linux
// +build linux

package os_enforce

import (
	"testing"
)

// TestBaselineMaskedPaths_CoversKeyInfoLeaks locks in the kernel
// info-leak vectors that the masked-paths baseline MUST cover — these
// are the paths Docker/gVisor mask by default and that L0 rules do not
// enumerate. A daemon with an empty L0 rule set still needs defense-in-
// depth against /proc/kcore (physical memory), /proc/sched_debug
// (scheduler info), /sys/firmware (EFI tables), and host SSH keys.
func TestBaselineMaskedPaths_CoversKeyInfoLeaks(t *testing.T) {
	masked := BaselineMaskedPaths()
	want := []string{
		"/proc/kcore",       // physical memory image — classic escape
		"/proc/sched_debug", // scheduler debug info
		"/proc/keys",        // kernel keyring
		"/sys/firmware",     // EFI/firmware tables
		"/etc/ssh",          // host SSH secrets
		"/root/.ssh",        // host root SSH secrets
	}
	for _, p := range want {
		found := false
		for _, m := range masked {
			if m == p {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("BaselineMaskedPaths must cover %q (kernel info-leak / host secret vector)", p)
		}
	}
}

// TestFromL0Rules_AppliesBaselineEvenWithNoPathRules is the regression
// test for the gap the P7 audit flagged: previously masked/readonly
// paths were derived ONLY from L0 path rules, so a daemon with an empty
// or minimal L0 config got no path-level defense-in-depth. The baseline
// (Docker-default info-leak vectors) must be applied unconditionally.
func TestFromL0Rules_AppliesBaselineEvenWithNoPathRules(t *testing.T) {
	// Empty L0 rules — no path rules at all.
	policy := FromL0Rules(nil)
	if policy == nil {
		t.Fatal("FromL0Rules(nil) returned nil")
	}
	// /proc/kcore is in the baseline; it must be masked even with no L0.
	found := false
	for _, m := range policy.MaskedPaths {
		if m == "/proc/kcore" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("baseline /proc/kcore must be masked even with no L0 path rules; got masked=%v", policy.MaskedPaths)
	}
	// /proc must be readonly (baseline).
	procRO := false
	for _, r := range policy.ReadonlyPaths {
		if r == "/proc" {
			procRO = true
			break
		}
	}
	if !procRO {
		t.Errorf("baseline /proc must be readonly even with no L0 path rules; got readonly=%v", policy.ReadonlyPaths)
	}
}

// TestDangerousCaps_CoversEscapePrimitives verifies the capability drop
// list covers the capabilities most commonly used in container-escape
// CVEs (SYS_ADMIN for mount/namespace, SYS_PTRACE for process injection,
// NET_ADMIN for network stack abuse, MKNOD for device creation).
func TestDangerousCaps_CoversEscapePrimitives(t *testing.T) {
	drop := DangerousCaps()
	want := []string{
		"CAP_SYS_ADMIN",  // mount, namespace — #1 escape primitive
		"CAP_SYS_PTRACE", // process injection
		"CAP_NET_ADMIN",  // network stack abuse
		"CAP_NET_RAW",    // raw sockets (spoofing, scanning)
		"CAP_MKNOD",      // device node creation
		"CAP_SYS_MODULE", // kernel module loading
		"CAP_SYS_RAWIO",  // raw disk I/O
	}
	for _, c := range want {
		found := false
		for _, d := range drop {
			if d == c {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("DangerousCaps must drop %s (common escape primitive)", c)
		}
	}
}
