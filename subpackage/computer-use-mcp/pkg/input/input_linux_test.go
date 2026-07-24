//go:build linux

package input

import (
	"reflect"
	"testing"
	"unsafe"
)

// TestRuneToKeysym pins the Unicode→X11-keysym convention the pure-XTest typing
// fallback relies on. This logic is display-independent, so it runs in headless
// CI where the XTest path itself cannot be exercised.
func TestRuneToKeysym(t *testing.T) {
	cases := []struct {
		name string
		in   rune
		want uint64
	}{
		{"ascii lower", 'a', 0x61},
		{"ascii upper", 'A', 0x41},
		{"digit", '0', 0x30},
		{"space", ' ', 0x20},
		{"shifted symbol", '!', 0x21},
		{"tilde", '~', 0x7e},
		{"latin1 high", 'é', 0x00e9}, // U+00E9, maps to identical keysym
		{"latin1 max", 'ÿ', 0x00ff},  // U+00FF boundary of the direct-map range
		{"newline->Return", '\n', XK_Return},
		{"carriage->Return", '\r', XK_Return},
		{"tab", '\t', XK_Tab},
		{"cjk", '好', 0x01000000 | 0x597d}, // outside Latin-1 → Unicode keysym range
		{"emoji", '✦', 0x01000000 | 0x2726},
		{"nul->none", 0x00, 0},
		{"bell->none", 0x07, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := runeToKeysym(c.in); got != c.want {
				t.Errorf("runeToKeysym(%q) = %#x, want %#x", c.in, got, c.want)
			}
		})
	}
}

// syntheticKeyMapper builds a keyMapper populated with a synthetic keymap,
// WITHOUT touching X11 (no display, no FFI calls). Layout encoded below:
//
//	kc=10 (minKC): levels [0]='a', [1]='A'
//	kc=11          : levels [0]='1', [1]='!'
//	kc=12          : levels [0]=0,   [1]=0   ← spare (NoSymbol at both levels)
//	kc=13          : levels [0]=0,   [1]=0   ← spare
//
// This gives us keysyms at level 0 and level 1 (to exercise needShift) plus
// two spares for remap round-robin / eviction tests.
func syntheticKeyMapper() *keyMapper {
	const minKC, perKC int32 = 10, 2
	keysyms := []uint64{
		0x61, 0x41, // kc=10: 'a' / 'A'
		0x31, 0x21, // kc=11: '1' / '!'
		0x00, 0x00, // kc=12: spare
		0x00, 0x00, // kc=13: spare
	}
	return &keyMapper{
		minKC:    minKC,
		maxKC:    13,
		perKC:    perKC,
		keysyms:  keysyms,
		spares:   []int32{12, 13},
		remapped: map[uint64]int32{},
	}
}

// TestKeyMapperLookupLevel0And1 covers the two levels of the cached-mapping
// branch in lookup: an unshifted keysym returns needShift=false, a shifted
// keysym returns needShift=true, and a missing keysym returns ok=false.
func TestKeyMapperLookupLevel0And1(t *testing.T) {
	km := syntheticKeyMapper()

	if kc, needShift, ok := km.lookup(0x61); !ok || kc != 10 || needShift { // 'a'
		t.Errorf("lookup('a') = (kc=%d, needShift=%v, ok=%v), want (10, false, true)", kc, needShift, ok)
	}
	if kc, needShift, ok := km.lookup(0x41); !ok || kc != 10 || !needShift { // 'A'
		t.Errorf("lookup('A') = (kc=%d, needShift=%v, ok=%v), want (10, true, true)", kc, needShift, ok)
	}
	if kc, needShift, ok := km.lookup(0x31); !ok || kc != 11 || needShift { // '1'
		t.Errorf("lookup('1') = (kc=%d, needShift=%v, ok=%v), want (11, false, true)", kc, needShift, ok)
	}
	if kc, needShift, ok := km.lookup(0x21); !ok || kc != 11 || !needShift { // '!'
		t.Errorf("lookup('!') = (kc=%d, needShift=%v, ok=%v), want (11, true, true)", kc, needShift, ok)
	}
	if _, _, ok := km.lookup(0x9999); ok { // not on the layout
		t.Errorf("lookup(missing) returned ok=true, want false")
	}
}

// remapCall records a single XChangeKeyboardMapping invocation: the keycode
// rewritten and the (perKC) keysyms written to it. Collected by the stubs
// installed for the remap/restore tests.
type remapCall struct {
	kc      int32
	keysyms []uint64
}

// withRemapStubs replaces the package-level xChangeKeyboardMapping and xSync
// FFI variables with test stubs that append to *calls, restoring the
// originals on cleanup. xSync becomes a no-op so remap's cache write isn't
// gated on a real sync. The change stub copies perKC (always 2 in the
// synthetic mapper) keysyms out of the C-style pointer arg.
func withRemapStubs(t *testing.T, calls *[]remapCall) {
	t.Helper()
	prevChange, prevSync := xChangeKeyboardMapping, xSync
	xChangeKeyboardMapping = func(_ uintptr, kc int32, _ int32, keysyms *uint64, _ int32) int {
		copied := []uint64{
			*keysyms,
			*(*uint64)(unsafe.Add(unsafe.Pointer(keysyms), 8)),
		}
		*calls = append(*calls, remapCall{kc: kc, keysyms: copied})
		return 1
	}
	xSync = func(uintptr, int32) int { return 1 }
	t.Cleanup(func() {
		xChangeKeyboardMapping, xSync = prevChange, prevSync
	})
}

// TestKeyMapperRemapRoundRobinAndCache drives remap with distinct unmapped
// keysyms and asserts: (1) spares are handed out in order (12 then 13), (2) a
// repeat of an already-remapped keysym is served from the cache with no new
// XChangeKeyboardMapping call, (3) the cache maps keysym→keycode as assigned.
func TestKeyMapperRemapRoundRobinAndCache(t *testing.T) {
	km := syntheticKeyMapper()
	var calls []remapCall
	withRemapStubs(t, &calls)

	const alpha, beta uint64 = 0x03b1, 0x03b2 // α, β

	kc, ok := km.remap(alpha)
	if !ok || kc != 12 {
		t.Fatalf("remap(α) = (kc=%d, ok=%v), want (12, true)", kc, ok)
	}
	kc, ok = km.remap(beta)
	if !ok || kc != 13 {
		t.Fatalf("remap(β) = (kc=%d, ok=%v), want (13, true)", kc, ok)
	}
	if got := len(calls); got != 2 {
		t.Fatalf("expected exactly 2 XChangeKeyboardMapping calls so far, got %d", got)
	}

	// α is cached → must NOT issue another XChangeKeyboardMapping, must return
	// the same keycode (12) it was originally assigned.
	kc, ok = km.remap(alpha)
	if !ok || kc != 12 {
		t.Errorf("cached remap(α) = (kc=%d, ok=%v), want (12, true)", kc, ok)
	}
	if got := len(calls); got != 2 {
		t.Errorf("cached remap issued a new XChangeKeyboardMapping (calls=%d), want 2", got)
	}

	if !reflect.DeepEqual(km.remapped, map[uint64]int32{alpha: 12, beta: 13}) {
		t.Errorf("remapped cache = %v, want {α:12, β:13}", km.remapped)
	}
}

// TestKeyMapperRemapEvictsStaleAssignment is the regression test for the
// round-robin overwrite bug. With 2 spares, a 3rd distinct keysym (γ) reuses
// spare 12 — the same keycode α was assigned. Before the fix, α's stale cache
// entry survived and a later remap(α) would return 12 even though the server
// had rebound 12 to γ. The fix evicts the stale entry, so remap(α) must now
// miss and claim the next spare fresh.
func TestKeyMapperRemapEvictsStaleAssignment(t *testing.T) {
	km := syntheticKeyMapper()
	var calls []remapCall
	withRemapStubs(t, &calls)

	const alpha, beta, gamma uint64 = 0x03b1, 0x03b2, 0x03b3 // α, β, γ

	km.remap(alpha) // → 12
	km.remap(beta)  // → 13
	km.remap(gamma) // → reuses 12 (round-robin), must evict α's cache entry

	// α should no longer be cached: its keycode was rebound to γ.
	if _, stillCached := km.remapped[alpha]; stillCached {
		t.Errorf("α still cached after its keycode (12) was rebound to γ; stale cache would mistype")
	}
	if km.remapped[gamma] != 12 {
		t.Errorf("γ not cached at kc=12, got remapped=%v", km.remapped)
	}

	// Re-requesting α must claim a fresh spare (round-robin wraps to 13) and
	// issue a new XChangeKeyboardMapping, rather than returning the stale 12
	// that now maps to γ.
	callsBefore := len(calls)
	kc, ok := km.remap(alpha)
	if !ok {
		t.Fatalf("remap(α) after eviction returned ok=false")
	}
	if len(calls) != callsBefore+1 {
		t.Errorf("remap(α) after eviction didn't issue a new XChangeKeyboardMapping (calls %d→%d), want a fresh claim", callsBefore, len(calls))
	}
	if kc == 12 {
		t.Errorf("remap(α) returned the rebound kc=12 — it would type γ, not α")
	}
}

// TestKeyMapperRestoreZeroesAllRemapped drives restore() and asserts it issues
// one XChangeKeyboardMapping per remapped keycode, writing NoSymbol (0) to
// every level — i.e. it reverts the user's layout to its original state. This
// guards against a partial restore that would leave junk keysyms behind.
func TestKeyMapperRestoreZeroesAllRemapped(t *testing.T) {
	km := syntheticKeyMapper()
	var calls []remapCall
	withRemapStubs(t, &calls)

	const alpha, beta uint64 = 0x03b1, 0x03b2
	km.remap(alpha) // → 12
	km.remap(beta)  // → 13

	callsBefore := len(calls)
	km.restore()

	if got := len(calls) - callsBefore; got != 2 {
		t.Fatalf("restore issued %d XChangeKeyboardMapping calls, want 2 (one per remapped keycode)", got)
	}
	// The two calls must target kc 12 and 13 and write all-zero keysyms.
	seen := map[int32]bool{}
	for _, c := range calls[callsBefore:] {
		seen[c.kc] = true
		for i, ks := range c.keysyms {
			if ks != 0 {
				t.Errorf("restore wrote keysym %d at kc=%d level=%d, want 0 (NoSymbol)", ks, c.kc, i)
			}
		}
	}
	if !seen[12] || !seen[13] {
		t.Errorf("restore didn't revert both remapped keycodes (seen=%v), want {12,13}", seen)
	}
}

// TestKeyMapperLookupNoCachedMappingFallsBackToServer pins the fallback branch
// of lookup: when perKC/keysyms are empty (e.g. FFI unavailable at construct
// time), lookup defers to the server-side xKeysymToKeycode resolver. We stub
// that resolver to return a known keycode and assert it's returned with
// needShift=false.
func TestKeyMapperLookupNoCachedMappingFallsBackToServer(t *testing.T) {
	km := &keyMapper{display: 0xdead, remapped: map[uint64]int32{}} // perKC=0 → fallback branch

	prev := xKeysymToKeycode
	xKeysymToKeycode = func(_ uintptr, _ uint64) byte { return 42 }
	t.Cleanup(func() { xKeysymToKeycode = prev })

	kc, needShift, ok := km.lookup(0x61) // 'a', but resolved via stub
	if !ok || kc != 42 || needShift {
		t.Errorf("fallback lookup = (kc=%d, needShift=%v, ok=%v), want (42, false, true)", kc, needShift, ok)
	}
}
