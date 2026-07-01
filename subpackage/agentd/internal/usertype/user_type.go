package usertype

// UserType mirrors Manboster's root/admin/user/unknown tool guard levels.
type UserType string

const (
	Unknown UserType = "unknown"
	User    UserType = "user"
	Admin   UserType = "admin"
	Root    UserType = "root"
)

var rank = map[UserType]int{
	Unknown: 0,
	User:    1,
	Admin:   2,
	Root:    3,
}

// Resolve maps Web roles to the daemon guard level. owner/root are explicit
// root roles; admin never promotes to root. "readonly" is intentionally
// mapped to Unknown so readonly (viewer) users cannot execute any tools —
// they may only observe task state via the Web UI.
func Resolve(roles []string) UserType {
	for _, role := range roles {
		if role == "owner" || role == "root" {
			return Root
		}
	}
	for _, role := range roles {
		if role == "admin" {
			return Admin
		}
	}
	for _, role := range roles {
		if role == "user" {
			return User
		}
	}
	// "readonly" and any unrecognized role → Unknown (no tool access).
	return Unknown
}

func Normalize(value string) UserType {
	switch value {
	case string(Root):
		return Root
	case string(Admin):
		return Admin
	case string(Unknown):
		return Unknown
	default:
		return User
	}
}

func CanUse(roles []string, minUserType string) bool {
	actual := Resolve(roles)
	required := Normalize(minUserType)
	return rank[actual] >= rank[required]
}
