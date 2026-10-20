package api

import (
	"testing"

	"slock/internal/db"
)

func TestNormalizeNoteName(t *testing.T) {
	for in, want := range map[string]string{
		"  Meeting   notes ": "Meeting notes",
		"Line\nbreak":        "Line break",
		"Été 2026 — plans":   "Été 2026 — plans",
	} {
		if got, err := normalizeNoteName(in); err != nil || got != want {
			t.Errorf("normalizeNoteName(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", string(make([]rune, 81))} {
		if _, err := normalizeNoteName(in); err == nil {
			t.Errorf("normalizeNoteName(%q) accepted", in)
		}
	}
}

func TestCanAdminPrivateNote(t *testing.T) {
	owner, other := int64(1), int64(2)
	admin := &db.User{ID: other, IsAdmin: true}
	creator := &db.User{ID: owner}
	for _, c := range []struct {
		kind    string
		private bool
		u       *db.User
		want    bool
	}{
		{db.KindNote, true, admin, false}, // an admin cannot take over someone's private note
		{db.KindNote, true, creator, true},
		{db.KindNote, false, admin, true}, // public notes stay moderatable
		{db.KindChannel, true, admin, true},
	} {
		b := &channelBasics{Kind: c.kind, IsPrivate: c.private, CreatedBy: &owner}
		if got := canAdminChannel(b, c.u); got != c.want {
			t.Errorf("%s private=%v admin=%v: got %v", c.kind, c.private, c.u.IsAdmin, got)
		}
	}
}
