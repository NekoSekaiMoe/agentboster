//go:build linux

package security

import "testing"

func TestParseGroupIDsIncludesPrimaryAndSupplementaryGroups(t *testing.T) {
	groupIDs, err := parseGroupIDs("1001 998 1001 999\n", 1001)
	if err != nil {
		t.Fatalf("parseGroupIDs: %v", err)
	}

	want := []int{1001, 998, 999}
	if len(groupIDs) != len(want) {
		t.Fatalf("expected %v, got %v", want, groupIDs)
	}
	for i := range want {
		if groupIDs[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, groupIDs)
		}
	}
}

func TestParseGroupIDsRejectsInvalidGroupID(t *testing.T) {
	if _, err := parseGroupIDs("1001 docker\n", 1001); err == nil {
		t.Fatal("expected invalid group id error")
	}
}
