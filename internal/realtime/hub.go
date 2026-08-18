// Package realtime is the server-sent-events fan-out. One Hub per process.
package realtime

import (
	"sync"
	"sync/atomic"
)

// Event is one SSE frame. Type becomes the SSE event name; Data is JSON-encoded.
type Event struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// Client is a single open SSE stream. Never write to C from outside the hub.
type Client struct {
	ID     uint64
	UserID int64
	C      chan Event
	closed atomic.Bool

	// visible mirrors the tab's Page Visibility state: an open stream from a
	// backgrounded tab keeps the user "online" for presence but must not
	// suppress web push. The client reports changes via /api/events/visible.
	visible atomic.Bool
}

// Hub tracks every open stream, grouped by user (a user may have several tabs).
type Hub struct {
	mu      sync.RWMutex
	clients map[int64]map[uint64]*Client
	nextID  atomic.Uint64
}

func NewHub() *Hub {
	return &Hub{clients: make(map[int64]map[uint64]*Client)}
}

// Subscribe registers a new stream for userID. visible is the tab's state at
// connect time (EventSource reconnects happen in hidden tabs too). wasOffline
// reports whether this is the user's only connection, which is the signal to
// broadcast presence.
func (h *Hub) Subscribe(userID int64, visible bool) (c *Client, wasOffline bool) {
	c = &Client{
		ID:     h.nextID.Add(1),
		UserID: userID,
		C:      make(chan Event, 64),
	}
	c.visible.Store(visible)
	h.mu.Lock()
	defer h.mu.Unlock()
	byUser, ok := h.clients[userID]
	if !ok {
		byUser = make(map[uint64]*Client)
		h.clients[userID] = byUser
		wasOffline = true
	}
	byUser[c.ID] = c
	return c, wasOffline
}

// Unsubscribe drops a stream. nowOffline reports whether the user has no
// remaining connections.
func (h *Hub) Unsubscribe(c *Client) (nowOffline bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	byUser, ok := h.clients[c.UserID]
	if !ok {
		return false
	}
	if _, ok := byUser[c.ID]; !ok {
		return false
	}
	delete(byUser, c.ID)
	if len(byUser) == 0 {
		delete(h.clients, c.UserID)
		nowOffline = true
	}
	if c.closed.CompareAndSwap(false, true) {
		close(c.C)
	}
	return nowOffline
}

// PublishUser delivers ev to every stream belonging to userID.
func (h *Hub) PublishUser(userID int64, ev Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	h.publishLocked(userID, ev)
}

// PublishUsers delivers ev to each user in the list, once per open stream.
func (h *Hub) PublishUsers(userIDs []int64, ev Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, uid := range userIDs {
		h.publishLocked(uid, ev)
	}
}

// PublishAll delivers ev to every connected user.
func (h *Hub) PublishAll(ev Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for uid := range h.clients {
		h.publishLocked(uid, ev)
	}
}

// publishLocked requires at least a read lock. A slow client is skipped rather
// than allowed to block the sender; it will resync on reconnect.
func (h *Hub) publishLocked(userID int64, ev Event) {
	for _, c := range h.clients[userID] {
		if c.closed.Load() {
			continue
		}
		select {
		case c.C <- ev:
		default:
		}
	}
}

// IsOnline reports whether the user has at least one open stream.
func (h *Hub) IsOnline(userID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID]) > 0
}

// HasVisible reports whether the user has at least one stream whose tab is
// currently visible. This, not IsOnline, is the "don't send push" signal: a
// stream from a backgrounded tab means the user is not looking at slock.
func (h *Hub) HasVisible(userID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients[userID] {
		if c.visible.Load() {
			return true
		}
	}
	return false
}

// SetVisible records a visibility change for one of userID's streams. It
// reports whether the stream exists and belongs to userID.
func (h *Hub) SetVisible(userID int64, clientID uint64, visible bool) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.clients[userID][clientID]
	if !ok {
		return false
	}
	c.visible.Store(visible)
	return true
}

// OnlineUsers lists every user with an open stream.
func (h *Hub) OnlineUsers() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]int64, 0, len(h.clients))
	for uid := range h.clients {
		out = append(out, uid)
	}
	return out
}
