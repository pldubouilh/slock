package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"slock/internal/httpx"
	"slock/internal/realtime"
	"slock/internal/version"
)

const heartbeatInterval = 25 * time.Second

// handleEvents is the SSE stream: one long-lived response per open tab. It
// subscribes to the hub, sends `hello`, then pumps events until the client goes
// away, with a comment heartbeat to keep proxies from closing the connection.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) error {
	user := currentUser(r)

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	rc := http.NewResponseController(w)
	// ?visible=0 marks a stream opened by a hidden tab (EventSource reconnects
	// keep running in the background); visibility changes after connect arrive
	// via POST /api/events/visible.
	client, wasOffline := s.Hub.Subscribe(user.ID, r.URL.Query().Get("visible") != "0")
	defer s.teardownStream(client)

	if wasOffline {
		s.Hub.PublishAll(realtime.Event{
			Type: "presence",
			Data: map[string]any{"user_id": user.ID, "online": true},
		})
	}

	// The version rides along on every reconnect: that is how a client
	// notices it is talking to a newer build than the one it loaded.
	hello := realtime.Event{Type: "hello", Data: map[string]any{
		"user_id":     user.ID,
		"client_id":   client.ID,
		"online":      s.Hub.OnlineUsers(),
		"server_time": time.Now().UTC(),
		"version":     version.String(),
	}}
	if err := writeSSE(w, hello); err != nil {
		return nil
	}
	if err := rc.Flush(); err != nil {
		return nil
	}

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case ev, ok := <-client.C:
			if !ok {
				return nil
			}
			if err := writeSSE(w, ev); err != nil {
				return nil
			}
			if err := rc.Flush(); err != nil {
				return nil
			}
		case <-ticker.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return nil
			}
			if err := rc.Flush(); err != nil {
				return nil
			}
		case <-r.Context().Done():
			return nil
		}
	}
}

// handleEventsVisible records a tab visibility change for one of the caller's
// streams; the client_id comes from that stream's `hello` frame. A stale id
// (stream already closed) is not an error — the tab may race its own teardown.
func (s *Server) handleEventsVisible(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		ClientID uint64 `json:"client_id"`
		Visible  bool   `json:"visible"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	s.Hub.SetVisible(currentUser(r).ID, in.ClientID, in.Visible)
	httpx.NoContent(w)
	return nil
}

// teardownStream unsubscribes and, when this was the user's last stream, marks
// them offline for everyone else.
func (s *Server) teardownStream(client *realtime.Client) {
	if !s.Hub.Unsubscribe(client) {
		return
	}
	s.Hub.PublishAll(realtime.Event{
		Type: "presence",
		Data: map[string]any{"user_id": client.UserID, "online": false},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = s.DB.Pool.Exec(ctx, `UPDATE users SET last_seen_at = now() WHERE id = $1`, client.UserID)
}

// writeSSE emits one frame. json.Marshal cannot produce a raw newline, so the
// data field is always a single line and the frame stays well-formed.
func writeSSE(w io.Writer, ev realtime.Event) error {
	data, err := json.Marshal(ev.Data)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, data)
	return err
}
