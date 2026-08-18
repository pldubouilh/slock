package api

import "testing"

func TestParseAndNormalizeScope(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"*", "*"},
		{"", "*"},
		{"   ", "*"},
		{"#eng", "#eng"},
		{"#eng, @bob, #releases", "#eng, @bob, #releases"},
		{"eng,bob", "#eng, #bob"},            // bare words are channels
		{"#Eng, @Bob", "#eng, @bob"},         // case is normalised
		{"  #eng ,  , @bob  ", "#eng, @bob"}, // stray separators
		{"#eng @bob", "#eng, @bob"},          // whitespace separated
		{"#eng, *", "*"},                     // a star anywhere wins
		{"#", "*"},                           // nothing usable
	}
	for _, tc := range tests {
		if got := normalizeScope(tc.in); got != tc.want {
			t.Errorf("normalizeScope(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestScopeAllows(t *testing.T) {
	tests := []struct {
		scope string
		isDM  bool
		name  string
		want  bool
	}{
		{"*", false, "anything", true},
		{"*", true, "anyone", true},
		{"", false, "anything", true},

		{"#eng", false, "eng", true},
		{"#eng", false, "ENG", true},
		{"#eng", false, "engineering", false},
		{"#eng", true, "eng", false}, // a channel entry must not authorise the DM

		{"@bob", true, "bob", true},
		{"@bob", true, "Bob", true},
		{"@bob", false, "bob", false}, // and vice versa
		{"@bob", true, "bobby", false},

		{"#eng, @bob, #releases", false, "releases", true},
		{"#eng, @bob, #releases", true, "bob", true},
		{"#eng, @bob, #releases", false, "general", false},
		{"#eng, @bob, #releases", true, "alice", false},
	}
	for _, tc := range tests {
		if got := scopeAllows(tc.scope, tc.isDM, tc.name); got != tc.want {
			kind := "#"
			if tc.isDM {
				kind = "@"
			}
			t.Errorf("scopeAllows(%q, %s%s) = %v, want %v", tc.scope, kind, tc.name, got, tc.want)
		}
	}
}

// A token must never be usable just because a scope happens to be empty in the
// database — empty means "*" by design, so this pins that decision.
func TestEmptyScopeMeansEverywhere(t *testing.T) {
	if !scopeAllows("", false, "secret-channel") {
		t.Error("an empty scope is documented as unrestricted")
	}
}
