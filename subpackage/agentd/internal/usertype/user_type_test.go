package usertype

import "testing"

func TestResolve(t *testing.T) {
	cases := []struct {
		name  string
		roles []string
		want  UserType
	}{
		{"nil", nil, Unknown},
		{"empty", []string{}, Unknown},
		{"owner", []string{"owner"}, Root},
		{"root", []string{"root"}, Root},
		{"admin", []string{"admin"}, Admin},
		{"user", []string{"user"}, User},
		{"readonly", []string{"readonly"}, Unknown},
		{"readonly+user", []string{"readonly", "user"}, User},
		{"admin+readonly", []string{"readonly", "admin"}, Admin},
		{"unknown_role", []string{"guest"}, Unknown},
		{"owner_takes_priority", []string{"user", "admin", "owner"}, Root},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Resolve(tc.roles)
			if got != tc.want {
				t.Errorf("Resolve(%v) = %q, want %q", tc.roles, got, tc.want)
			}
		})
	}
}

func TestCanUse(t *testing.T) {
	cases := []struct {
		name        string
		roles       []string
		minUserType string
		want        bool
	}{
		{"owner_can_use_root", []string{"owner"}, "root", true},
		{"user_can_use_user", []string{"user"}, "user", true},
		{"readonly_cannot_use_user", []string{"readonly"}, "user", false},
		{"readonly_can_use_unknown_min", []string{"readonly"}, "unknown", true},
		{"readonly_empty_min_defaults_user", []string{"readonly"}, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := CanUse(tc.roles, tc.minUserType)
			if got != tc.want {
				t.Errorf("CanUse(%v, %q) = %v, want %v", tc.roles, tc.minUserType, got, tc.want)
			}
		})
	}
}
