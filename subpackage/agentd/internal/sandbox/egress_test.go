//go:build linux
// +build linux

package sandbox

import (
	"net"
	"strings"
	"testing"
	"time"
)

func TestBuildEgressRules_EmptyInput(t *testing.T) {
	rules, script := BuildEgressRules(nil)
	if rules != nil {
		t.Fatalf("expected nil rules, got %v", rules)
	}
	if script != "" {
		t.Fatalf("expected empty script, got %q", script)
	}
}

func TestBuildEgressRules_GeneratesBothFamilies(t *testing.T) {
	// Inject deterministic resolutions via the cache so the test does
	// not depend on live DNS (which is flaky in CI / sandboxes).
	egressCacheMu.Lock()
	egressCache["github.com"] = egressCacheEntry{
		ips:        mustParseIPs(t, "140.82.112.3", "2606:50c0:8000::153"),
		resolvedAt: time.Now(),
	}
	egressCache["v4only.example"] = egressCacheEntry{
		ips:        mustParseIPs(t, "1.2.3.4"),
		resolvedAt: time.Now(),
	}
	egressCache["v6only.example"] = egressCacheEntry{
		ips:        mustParseIPs(t, "2001:db8::1"),
		resolvedAt: time.Now(),
	}
	egressCacheMu.Unlock()
	defer func() {
		egressCacheMu.Lock()
		egressCache = make(map[string]egressCacheEntry)
		egressCacheMu.Unlock()
	}()

	_, script := BuildEgressRules([]string{"github.com", "v4only.example", "v6only.example"})
	if script == "" {
		t.Fatal("expected non-empty script")
	}
	if !strings.Contains(script, "iptables") {
		t.Error("script should emit iptables block")
	}
	if !strings.Contains(script, "ip6tables") {
		t.Error("script should emit ip6tables block for IPv6 IPs")
	}
	if !strings.Contains(script, "140.82.112.3") {
		t.Error("script missing IPv4 from github.com")
	}
	if !strings.Contains(script, "2606:50c0:8000::153") {
		t.Error("script missing IPv6 from github.com")
	}
	if !strings.Contains(script, "1.2.3.4") {
		t.Error("script missing v4-only IP")
	}
	if !strings.Contains(script, "2001:db8::1") {
		t.Error("script missing v6-only IP")
	}
}

func TestBuildEgressRules_PureV4HasNoV6Block(t *testing.T) {
	egressCacheMu.Lock()
	egressCache["only4.example"] = egressCacheEntry{
		ips:        mustParseIPs(t, "10.0.0.1"),
		resolvedAt: time.Now(),
	}
	egressCacheMu.Unlock()
	defer func() {
		egressCacheMu.Lock()
		delete(egressCache, "only4.example")
		egressCacheMu.Unlock()
	}()

	_, script := BuildEgressRules([]string{"only4.example"})
	if strings.Contains(script, "ip6tables") {
		t.Errorf("v4-only allowlist must not emit ip6tables block: %s", script)
	}
	if !strings.Contains(script, "iptables") {
		t.Errorf("expected iptables block: %s", script)
	}
}

func TestBuildEgressRules_NoIPsReturnsEmpty(t *testing.T) {
	egressCacheMu.Lock()
	egressCache["nodomain.invalid"] = egressCacheEntry{
		ips:        nil,
		resolvedAt: time.Now(),
	}
	egressCacheMu.Unlock()
	defer func() {
		egressCacheMu.Lock()
		delete(egressCache, "nodomain.invalid")
		egressCacheMu.Unlock()
	}()

	_, script := BuildEgressRules([]string{"nodomain.invalid"})
	if script != "" {
		t.Errorf("expected empty script when no IPs resolve, got %s", script)
	}
}

func TestFlushEgressCacheFor_DropsOnlyMatchingPatterns(t *testing.T) {
	egressCacheMu.Lock()
	egressCache["keep.me"] = egressCacheEntry{
		ips:        mustParseIPs(t, "1.1.1.1"),
		resolvedAt: time.Now(),
	}
	egressCache["drop.me"] = egressCacheEntry{
		ips:        mustParseIPs(t, "2.2.2.2"),
		resolvedAt: time.Now(),
	}
	egressCacheMu.Unlock()

	flushEgressCacheFor([]string{"drop.me"})

	egressCacheMu.RLock()
	_, dropGone := egressCache["drop.me"]
	_, keepThere := egressCache["keep.me"]
	egressCacheMu.RUnlock()

	if dropGone {
		t.Error("flush should have removed drop.me")
	}
	if !keepThere {
		t.Error("flush should NOT have removed keep.me")
	}
}

func TestEgressRefresher_StopIsIdempotent(t *testing.T) {
	r := &egressRefresher{
		stopCh:    make(chan struct{}),
		sandboxID: "test",
		interval:  time.Hour,
	}
	r.stop()
	// Second stop must not panic (close of closed channel).
	r.stop()
}

func TestStopEgressRefresher_NoopWhenAbsent(t *testing.T) {
	m := &Manager{}
	// No refresher registered for this id; must not panic.
	m.StopEgressRefresher("does-not-exist")
}

func mustParseIPs(t *testing.T, ips ...string) []net.IP {
	t.Helper()
	out := make([]net.IP, 0, len(ips))
	for _, s := range ips {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("failed to parse ip %q", s)
		}
		out = append(out, ip)
	}
	return out
}
