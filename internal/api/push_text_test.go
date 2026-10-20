package api

import "testing"

func TestFoldMore(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"plain", "plain"},
		{"a\n[more]\nhidden\n[/more]\nb", "a\n…\nb"},
		{"a\n [MORE] \nhidden", "a\n…"},
		{"a\n[more]\nx\n[more]\nb", "a\n…\nb"}, // a second [more] closes
		{"a\n[/more]\nb", "a\n[/more]\nb"},     // a stray close stays
	} {
		if got := foldMore(c.in); got != c.want {
			t.Errorf("foldMore(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
