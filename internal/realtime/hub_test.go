package realtime

import "testing"

func TestVisibility(t *testing.T) {
	h := NewHub()
	const user = int64(7)

	if h.HasVisible(user) {
		t.Fatal("no streams yet, HasVisible should be false")
	}

	// A hidden tab connects: online, but not visible.
	bg, wasOffline := h.Subscribe(user, false)
	if !wasOffline {
		t.Fatal("first stream should report wasOffline")
	}
	if !h.IsOnline(user) || h.HasVisible(user) {
		t.Fatalf("hidden stream: IsOnline=%v HasVisible=%v, want true/false", h.IsOnline(user), h.HasVisible(user))
	}

	// A visible tab joins.
	fg, _ := h.Subscribe(user, true)
	if !h.HasVisible(user) {
		t.Fatal("visible stream should make HasVisible true")
	}

	// The visible tab goes to the background.
	if !h.SetVisible(user, fg.ID, false) {
		t.Fatal("SetVisible should find the stream")
	}
	if h.HasVisible(user) {
		t.Fatal("both tabs hidden, HasVisible should be false")
	}

	// Wrong owner or unknown id must not flip anything.
	if h.SetVisible(user+1, fg.ID, true) {
		t.Fatal("SetVisible must reject a client id owned by another user")
	}
	if h.SetVisible(user, 999, true) {
		t.Fatal("SetVisible must reject an unknown client id")
	}

	// Hidden tab becomes visible again.
	if !h.SetVisible(user, bg.ID, true) {
		t.Fatal("SetVisible should find the background stream")
	}
	if !h.HasVisible(user) {
		t.Fatal("HasVisible should be true again")
	}

	h.Unsubscribe(bg)
	h.Unsubscribe(fg)
	if h.IsOnline(user) || h.HasVisible(user) {
		t.Fatal("all streams gone, user should be offline and not visible")
	}
}
