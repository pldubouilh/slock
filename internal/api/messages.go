package api

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/realtime"
)

const (
	maxBodyRunes  = 8000
	maxEmojiBytes = 24
	maxClientID   = 64
)

// messageCols is the column list every message query shares.
const messageCols = `m.id, m.channel_id, m.user_id, m.body, m.created_at, m.edited_at, m.deleted_at`

func scanMessage(row interface{ Scan(...any) error }) (db.Message, error) {
	var m db.Message
	err := row.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Body, &m.CreatedAt, &m.EditedAt, &m.DeletedAt)
	m.Attachments = []db.Attachment{}
	m.Reactions = []db.Reaction{}
	return m, err
}

// hydrate fills attachments and aggregated reactions for a batch of messages in
// two queries, whatever the batch size. Every message-returning endpoint goes
// through here so the wire shape is identical everywhere.
func (s *Server) hydrate(ctx context.Context, msgs []db.Message, viewerID int64) error {
	if len(msgs) == 0 {
		return nil
	}
	ids := make([]int64, len(msgs))
	byID := make(map[int64]*db.Message, len(msgs))
	for i := range msgs {
		msgs[i].Attachments = []db.Attachment{}
		msgs[i].Reactions = []db.Reaction{}
		ids[i] = msgs[i].ID
		byID[msgs[i].ID] = &msgs[i]
	}

	rows, err := s.DB.Pool.Query(ctx,
		`SELECT id, message_id, uploader_id, filename, mime, size_bytes, is_image,
		        width, height, has_display, has_thumb
		   FROM attachments WHERE message_id = ANY($1) ORDER BY id`, ids)
	if err != nil {
		return err
	}
	for rows.Next() {
		var a db.Attachment
		if err := rows.Scan(&a.ID, &a.MessageID, &a.UploaderID, &a.Filename, &a.Mime, &a.SizeBytes,
			&a.IsImage, &a.Width, &a.Height, &a.HasDisplay, &a.HasThumb); err != nil {
			rows.Close()
			return err
		}
		if a.MessageID != nil {
			// A deleted message keeps its attachment rows (soft delete), but
			// they must not travel to clients — the body is already scrubbed.
			if m := byID[*a.MessageID]; m != nil && m.DeletedAt == nil {
				m.Attachments = append(m.Attachments, a)
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	rrows, err := s.DB.Pool.Query(ctx,
		`SELECT message_id, emoji, count(*)::int, array_agg(user_id ORDER BY user_id),
		        bool_or(user_id = $2)
		   FROM reactions WHERE message_id = ANY($1)
		  GROUP BY message_id, emoji
		  ORDER BY message_id, min(created_at)`, ids, viewerID)
	if err != nil {
		return err
	}
	defer rrows.Close()
	for rrows.Next() {
		var mid int64
		var re db.Reaction
		if err := rrows.Scan(&mid, &re.Emoji, &re.Count, &re.UserIDs, &re.Mine); err != nil {
			return err
		}
		if m := byID[mid]; m != nil {
			m.Reactions = append(m.Reactions, re)
		}
	}
	return rrows.Err()
}

// loadReactions aggregates the reactions of a single message.
func (s *Server) loadReactions(ctx context.Context, messageID, viewerID int64) ([]db.Reaction, error) {
	rows, err := s.DB.Pool.Query(ctx,
		`SELECT emoji, count(*)::int, array_agg(user_id ORDER BY user_id), bool_or(user_id = $2)
		   FROM reactions WHERE message_id = $1
		  GROUP BY emoji ORDER BY min(created_at)`, messageID, viewerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []db.Reaction{}
	for rows.Next() {
		var re db.Reaction
		if err := rows.Scan(&re.Emoji, &re.Count, &re.UserIDs, &re.Mine); err != nil {
			return nil, err
		}
		out = append(out, re)
	}
	return out, rows.Err()
}

// loadMessage reads one message with its hydration, no permission check.
func (s *Server) loadMessage(ctx context.Context, id, viewerID int64) (*db.Message, error) {
	m, err := scanMessage(s.DB.Pool.QueryRow(ctx,
		`SELECT `+messageCols+` FROM messages m WHERE m.id = $1`, id))
	if err != nil {
		if isNoRows(err) {
			return nil, httpx.ErrNotFound
		}
		return nil, err
	}
	batch := []db.Message{m}
	if err := s.hydrate(ctx, batch, viewerID); err != nil {
		return nil, err
	}
	return &batch[0], nil
}

// handleListMessages pages a channel's history (before/after/limit), oldest
// first, with attachments and aggregated reactions hydrated.
func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireMembership(ctx, id, me.ID); err != nil {
		return err
	}

	limit := httpx.Clamp(httpx.QueryInt(r, "limit", 50), 1, 200)
	before := int64(httpx.QueryInt(r, "before", 0))
	after := int64(httpx.QueryInt(r, "after", 0))

	// Fetch one extra row to know whether another page exists.
	var (
		sql      string
		args     []any
		ascOrder bool
	)
	switch {
	case after > 0:
		sql = `SELECT ` + messageCols + ` FROM messages m
		        WHERE m.channel_id = $1 AND m.id > $2 ORDER BY m.id ASC LIMIT $3`
		args = []any{id, after, limit + 1}
		ascOrder = true
	case before > 0:
		sql = `SELECT ` + messageCols + ` FROM messages m
		        WHERE m.channel_id = $1 AND m.id < $2 ORDER BY m.id DESC LIMIT $3`
		args = []any{id, before, limit + 1}
	default:
		sql = `SELECT ` + messageCols + ` FROM messages m
		        WHERE m.channel_id = $1 ORDER BY m.id DESC LIMIT $2`
		args = []any{id, limit + 1}
	}

	rows, err := s.DB.Pool.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	msgs := []db.Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return err
		}
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	hasMore := len(msgs) > limit
	if hasMore {
		msgs = msgs[:limit]
	}
	if !ascOrder {
		for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
			msgs[i], msgs[j] = msgs[j], msgs[i]
		}
	}
	if err := s.hydrate(ctx, msgs, me.ID); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"messages": msgs, "has_more": hasMore})
	return nil
}

// handleCreateMessage inserts a message, attaches any uploaded attachment ids
// owned by the caller, bumps channels.last_message_at, publishes message.new
// to the channel, and fires notifyNewMessage in a goroutine.
func (s *Server) handleCreateMessage(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Body          string  `json:"body"`
		AttachmentIDs []int64 `json:"attachment_ids"`
		ClientID      string  `json:"client_id"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	body := strings.TrimRight(in.Body, " \t\r\n")
	if utf8.RuneCountInString(body) > maxBodyRunes {
		return httpx.BadRequest("Message is too long.")
	}
	if body == "" && len(in.AttachmentIDs) == 0 {
		return httpx.BadRequest("Write something or attach a file.")
	}
	if len(in.AttachmentIDs) > 20 {
		return httpx.BadRequest("Too many attachments.")
	}
	if len(in.ClientID) > maxClientID {
		return httpx.BadRequest("Invalid client_id.")
	}

	ctx := r.Context()
	basics, err := s.channelBasics(ctx, id)
	if err != nil {
		return err
	}
	member, err := s.isMember(ctx, id, me.ID)
	if err != nil {
		return err
	}
	autoJoin := false
	if !member {
		if basics.Kind != db.KindChannel || basics.IsPrivate {
			return httpx.ErrForbidden
		}
		autoJoin = true
	}

	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if autoJoin {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			id, me.ID); err != nil {
			return err
		}
	}

	var msg db.Message
	msg.ChannelID, msg.UserID, msg.Body = id, me.ID, body
	if err := tx.QueryRow(ctx,
		`INSERT INTO messages (channel_id, user_id, body) VALUES ($1, $2, $3)
		 RETURNING id, created_at`, id, me.ID, body).Scan(&msg.ID, &msg.CreatedAt); err != nil {
		return err
	}

	if len(in.AttachmentIDs) > 0 {
		tag, err := tx.Exec(ctx,
			`UPDATE attachments SET message_id = $1
			  WHERE id = ANY($2) AND uploader_id = $3 AND message_id IS NULL`,
			msg.ID, in.AttachmentIDs, me.ID)
		if err != nil {
			return err
		}
		if int(tag.RowsAffected()) != len(in.AttachmentIDs) {
			return httpx.BadRequest("Some attachments are unknown or already used.")
		}
	}

	if err := touchChannel(ctx, tx, id, msg.CreatedAt); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	batch := []db.Message{msg}
	if err := s.hydrate(ctx, batch, me.ID); err != nil {
		return err
	}
	msg = batch[0]
	msg.ClientID = in.ClientID

	channel := &db.Channel{ID: basics.ID, Kind: basics.Kind, Name: basics.Name, IsPrivate: basics.IsPrivate}
	if autoJoin {
		s.publishMembers(ctx, id)
	}
	// Everyone in the channel gets it, sender included: the client dedupes on
	// client_id against its optimistic row.
	s.publishToChannel(ctx, id, realtime.Event{Type: "message.new", Data: map[string]any{
		"message": msg,
		"channel": map[string]any{"id": basics.ID, "kind": basics.Kind, "name": basics.Name},
		"user":    map[string]any{"id": me.ID, "display_name": me.DisplayName},
	}}, 0)

	// Detached context: the request is done by the time push finishes.
	notified := msg
	go s.notifyNewMessage(context.Background(), &notified, channel, me)

	httpx.JSON(w, http.StatusCreated, map[string]any{"message": msg})
	return nil
}

// handleUpdateMessage edits the body (author only) and publishes message.update.
func (s *Server) handleUpdateMessage(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Body string `json:"body"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	body := strings.TrimRight(in.Body, " \t\r\n")
	if utf8.RuneCountInString(body) > maxBodyRunes {
		return httpx.BadRequest("Message is too long.")
	}

	ctx := r.Context()
	var (
		authorID  int64
		channelID int64
		deletedAt *time.Time
		hasAttach bool
	)
	err = s.DB.Pool.QueryRow(ctx,
		`SELECT m.user_id, m.channel_id, m.deleted_at,
		        EXISTS(SELECT 1 FROM attachments a WHERE a.message_id = m.id)
		   FROM messages m WHERE m.id = $1`, id).Scan(&authorID, &channelID, &deletedAt, &hasAttach)
	if err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}
	if authorID != me.ID {
		return httpx.ErrForbidden
	}
	if deletedAt != nil {
		return httpx.BadRequest("That message was deleted.")
	}
	if body == "" && !hasAttach {
		return httpx.BadRequest("Write something or attach a file.")
	}

	if _, err := s.DB.Pool.Exec(ctx,
		`UPDATE messages SET body = $1, edited_at = now() WHERE id = $2`, body, id); err != nil {
		return err
	}
	msg, err := s.loadMessage(ctx, id, me.ID)
	if err != nil {
		return err
	}
	s.publishToChannel(ctx, channelID, realtime.Event{
		Type: "message.update", Data: map[string]any{"message": msg},
	}, 0)
	httpx.JSON(w, http.StatusOK, map[string]any{"message": msg})
	return nil
}

// handleDeleteMessage soft-deletes (author or admin) and publishes message.delete.
func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var authorID, channelID int64
	var deletedAt *time.Time
	err = s.DB.Pool.QueryRow(ctx,
		`SELECT user_id, channel_id, deleted_at FROM messages WHERE id = $1`, id).
		Scan(&authorID, &channelID, &deletedAt)
	if err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}
	if authorID != me.ID && !me.IsAdmin {
		return httpx.ErrForbidden
	}

	if deletedAt == nil {
		tx, err := s.DB.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx,
			`UPDATE messages SET deleted_at = now(), body = '' WHERE id = $1`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM reactions WHERE message_id = $1`, id); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}

	s.publishToChannel(ctx, channelID, realtime.Event{Type: "message.delete", Data: map[string]any{
		"message_id": id,
		"channel_id": channelID,
	}}, 0)
	httpx.NoContent(w)
	return nil
}

// reactionTarget resolves the message behind a reaction request and checks the
// caller may read its channel. ServeMux has already unescaped the {emoji}
// path segment, so PathValue is the decoded emoji.
func (s *Server) reactionTarget(r *http.Request) (messageID, channelID int64, emoji string, err error) {
	me := currentUser(r)
	messageID, err = httpx.PathInt(r, "id")
	if err != nil {
		return 0, 0, "", err
	}
	emoji = strings.TrimSpace(r.PathValue("emoji"))
	if emoji == "" || len(emoji) > maxEmojiBytes || strings.ContainsAny(emoji, "\n\r\t") {
		return 0, 0, "", httpx.BadRequest("Invalid emoji.")
	}

	ctx := r.Context()
	var deletedAt *time.Time
	err = s.DB.Pool.QueryRow(ctx,
		`SELECT channel_id, deleted_at FROM messages WHERE id = $1`, messageID).Scan(&channelID, &deletedAt)
	if err != nil {
		if isNoRows(err) {
			return 0, 0, "", httpx.ErrNotFound
		}
		return 0, 0, "", err
	}
	if deletedAt != nil {
		return 0, 0, "", httpx.BadRequest("That message was deleted.")
	}
	if err := s.requireMembership(ctx, channelID, me.ID); err != nil {
		return 0, 0, "", err
	}
	return messageID, channelID, emoji, nil
}

// publishReactions broadcasts the fresh aggregate for a message. `mine` is
// per-recipient and a broadcast has one payload, so it goes out as false and
// each client derives its own value from user_ids.
func (s *Server) publishReactions(ctx context.Context, messageID, channelID int64) {
	list, err := s.loadReactions(ctx, messageID, 0)
	if err != nil {
		return
	}
	for i := range list {
		list[i].Mine = false
	}
	s.publishToChannel(ctx, channelID, realtime.Event{Type: "reaction", Data: map[string]any{
		"message_id": messageID,
		"channel_id": channelID,
		"reactions":  list,
	}}, 0)
}

// handleAddReaction adds the caller's reaction and publishes the new aggregate.
func (s *Server) handleAddReaction(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	messageID, channelID, emoji, err := s.reactionTarget(r)
	if err != nil {
		return err
	}
	if _, err := s.DB.Pool.Exec(r.Context(),
		`INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		messageID, me.ID, emoji); err != nil {
		return err
	}
	s.publishReactions(r.Context(), messageID, channelID)
	httpx.NoContent(w)
	return nil
}

// handleRemoveReaction removes it and publishes the new aggregate.
func (s *Server) handleRemoveReaction(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	messageID, channelID, emoji, err := s.reactionTarget(r)
	if err != nil {
		return err
	}
	if _, err := s.DB.Pool.Exec(r.Context(),
		`DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
		messageID, me.ID, emoji); err != nil {
		return err
	}
	s.publishReactions(r.Context(), messageID, channelID)
	httpx.NoContent(w)
	return nil
}
