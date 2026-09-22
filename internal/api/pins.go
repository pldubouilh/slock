package api

import (
	"context"
	"net/http"
	"time"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/realtime"
)

// maxPins bounds a pins listing. Pinning is a curation gesture — a channel
// with thousands of them has stopped meaning anything — but the cap keeps the
// query indexed regardless of what a workspace gets up to.
const maxPins = 200

// pinTarget resolves the message behind a pin request and checks the caller may
// act on it. Deliberately the same rule as reactions (see reactionTarget):
// anyone who can read the channel can pin in it, so a public channel behaves
// consistently whichever of the two you reach for.
func (s *Server) pinTarget(r *http.Request) (messageID, channelID int64, err error) {
	me := currentUser(r)
	messageID, err = httpx.PathInt(r, "id")
	if err != nil {
		return 0, 0, err
	}

	ctx := r.Context()
	var deletedAt *time.Time
	err = s.DB.Pool.QueryRow(ctx,
		`SELECT channel_id, deleted_at FROM messages WHERE id = $1`, messageID).Scan(&channelID, &deletedAt)
	if err != nil {
		if isNoRows(err) {
			return 0, 0, httpx.ErrNotFound
		}
		return 0, 0, err
	}
	if deletedAt != nil {
		return 0, 0, httpx.BadRequest("That message was deleted.")
	}
	if err := s.requireMembership(ctx, channelID, me); err != nil {
		return 0, 0, err
	}
	return messageID, channelID, nil
}

// publishPin tells the channel a message's pinned state changed, so every open
// client repaints its star and any open pins list refreshes.
func (s *Server) publishPin(ctx context.Context, messageID, channelID int64, pinned bool) {
	s.publishToChannel(ctx, channelID, realtime.Event{Type: "pin", Data: map[string]any{
		"message_id": messageID,
		"channel_id": channelID,
		"pinned":     pinned,
	}}, 0)
}

// handlePinMessage pins a message in its channel. Pinning twice is a no-op
// rather than an error: the client toggles optimistically and may race itself.
func (s *Server) handlePinMessage(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	messageID, channelID, err := s.pinTarget(r)
	if err != nil {
		return err
	}
	if _, err := s.DB.Pool.Exec(r.Context(),
		`INSERT INTO pins (message_id, channel_id, user_id) VALUES ($1, $2, $3)
		 ON CONFLICT (message_id) DO NOTHING`, messageID, channelID, me.ID); err != nil {
		return err
	}
	s.publishPin(r.Context(), messageID, channelID, true)
	httpx.NoContent(w)
	return nil
}

// handleUnpinMessage removes the pin. Any member may unpin, matching who may
// pin — a pin belongs to the channel, not to the person who placed it.
func (s *Server) handleUnpinMessage(w http.ResponseWriter, r *http.Request) error {
	messageID, channelID, err := s.pinTarget(r)
	if err != nil {
		return err
	}
	if _, err := s.DB.Pool.Exec(r.Context(),
		`DELETE FROM pins WHERE message_id = $1`, messageID); err != nil {
		return err
	}
	s.publishPin(r.Context(), messageID, channelID, false)
	httpx.NoContent(w)
	return nil
}

// handleListPins returns a channel's pinned messages, most recently pinned
// first, hydrated like any other message list. Access mirrors message history.
func (s *Server) handleListPins(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireMembership(ctx, id, me); err != nil {
		return err
	}

	limit := httpx.Clamp(httpx.QueryInt(r, "limit", 50), 1, maxPins)

	// A soft-deleted message keeps its pin row (the delete is reversible in
	// principle and the cascade only fires on a hard delete), so filter here
	// the same way every other message query does.
	rows, err := s.DB.Pool.Query(ctx,
		`SELECT `+messageCols+`, p.user_id, p.created_at
		   FROM pins p
		   JOIN messages m ON m.id = p.message_id
		  WHERE p.channel_id = $1 AND m.deleted_at IS NULL
		    AND ($3::timestamptz IS NULL OR m.created_at >= $3)
		  ORDER BY p.created_at DESC
		  LIMIT $2`, id, limit, me.HistoryCutoff)
	if err != nil {
		return err
	}
	defer rows.Close()

	type pinned struct {
		db.Message
		PinnedBy *int64    `json:"pinned_by"`
		PinnedAt time.Time `json:"pinned_at"`
	}
	out := []pinned{}
	msgs := []db.Message{}
	for rows.Next() {
		var p pinned
		p.Attachments = []db.Attachment{}
		p.Reactions = []db.Reaction{}
		if err := rows.Scan(&p.ID, &p.ChannelID, &p.UserID, &p.Body, &p.CreatedAt,
			&p.EditedAt, &p.DeletedAt, &p.Kind, &p.PinnedBy, &p.PinnedAt); err != nil {
			return err
		}
		if p.Kind == "user" {
			p.Kind = "" // implicit on the wire, like scanMessage
		}
		out = append(out, p)
		msgs = append(msgs, p.Message)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	if err := s.hydrate(ctx, msgs, me.ID); err != nil {
		return err
	}
	for i := range out {
		out[i].Message = msgs[i]
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"pins": out})
	return nil
}
