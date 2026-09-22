package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgconn"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/realtime"
)

// channelCols is the fixed prefix of every channel SELECT so the scan helper
// below stays in step with the queries.
const channelCols = `c.id, c.kind, c.name, c.topic, c.is_private, c.created_by, c.created_at, c.last_message_at`

// maxChannelNameLen bounds a normalised channel name.
const maxChannelNameLen = 40

// unreadCap is the largest unread count the server will compute. Counting
// exactly means scanning every message newer than a read marker, so the cost
// grows with history forever; stopping at the cap keeps every unread query an
// indexed lookup of at most this many rows. Clients render a capped value as
// "99+", which is all anyone reads a badge for anyway.
const unreadCap = 100

// normalizeChannelName lowercases, turns whitespace into dashes and drops
// everything outside [a-z0-9-_]. It returns an error when nothing usable is
// left or the result is too long.
func normalizeChannelName(raw string) (string, error) {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case unicode.IsSpace(r):
			b.WriteByte('-')
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" || len(name) > maxChannelNameLen {
		return "", httpx.BadRequest("Channel names are 1-40 characters of letters, numbers, - or _.")
	}
	return name, nil
}

// normalizeChannelToken lowercases one channel name for an allowlist, keeping
// only the characters normalizeChannelName allows and dropping the rest (a
// leading '#', spaces). Returns "" for a token with nothing usable.
func normalizeChannelToken(raw string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		}
	}
	return strings.Trim(b.String(), "-")
}

// normalizeAllowedChannels canonicalises an admin's comma-separated allowlist
// into storage form: "*" (no restriction) or a lowercased, de-duplicated,
// space-free comma-joined list. Blank, "*", or all-garbage input means "*" so a
// user is never silently locked out of every channel by a stray keystroke.
func normalizeAllowedChannels(raw string) string {
	if raw = strings.TrimSpace(raw); raw == "" || raw == "*" {
		return "*"
	}
	var names []string
	seen := map[string]bool{}
	for part := range strings.SplitSeq(raw, ",") {
		if n := normalizeChannelToken(part); n != "" && !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return "*"
	}
	return strings.Join(names, ",")
}

// dmKey is the canonical key for a 1:1 conversation: both ids sorted ascending
// and joined with a colon. A self-DM is "N:N".
func dmKey(a, b int64) string {
	if a > b {
		a, b = b, a
	}
	return strconv.FormatInt(a, 10) + ":" + strconv.FormatInt(b, 10)
}

// isUniqueViolation reports whether err is a Postgres unique-constraint error.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// channelScanner is the row shape shared by the list and single-channel queries.
type channelScanner interface {
	Scan(dest ...any) error
}

func scanChannel(row channelScanner) (*db.Channel, error) {
	var c db.Channel
	var isMember bool
	err := row.Scan(&c.ID, &c.Kind, &c.Name, &c.Topic, &c.IsPrivate, &c.CreatedBy, &c.CreatedAt,
		&c.LastMessageAt, &isMember, &c.Muted, &c.UnreadCount, &c.MemberCount, &c.PeerUserID)
	if err != nil {
		return nil, err
	}
	c.IsMember = isMember
	return &c, nil
}

// viewerChannelQuery selects one channel with the per-viewer fields filled in.
// $1 is the channel id, $2 the viewer.
var viewerChannelQuery = fmt.Sprintf(`
SELECT `+channelCols+`,
       (cm.user_id IS NOT NULL) AS is_member,
       COALESCE(cm.muted, false) AS muted,
       COALESCE((SELECT count(*) FROM (
                    SELECT 1 FROM messages m
                     WHERE m.channel_id = c.id AND m.deleted_at IS NULL
                       AND m.user_id <> $2 AND m.id > cm.last_read_message_id
                       AND m.kind = 'user' -- system notes never count as unread
                       -- limited-history users: pre-account messages are not unread
                       AND m.created_at >= COALESCE((SELECT history_cutoff FROM users WHERE id = $2), '-infinity'::timestamptz)
                     ORDER BY m.id DESC
                     LIMIT %d
                 ) capped), 0) AS unread_count,
       (SELECT count(*) FROM channel_members x WHERE x.channel_id = c.id) AS member_count,
       CASE WHEN c.kind = 'dm' THEN
            (SELECT COALESCE(MIN(NULLIF(x.user_id, $2)), $2)
               FROM channel_members x WHERE x.channel_id = c.id)
       END AS peer_user_id
  FROM channels c
  LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
 WHERE c.id = $1`, unreadCap)

// loadChannel fetches one channel as seen by viewerID.
func (s *Server) loadChannel(ctx context.Context, channelID, viewerID int64) (*db.Channel, error) {
	c, err := scanChannel(s.DB.Pool.QueryRow(ctx, viewerChannelQuery, channelID, viewerID))
	if err != nil {
		if isNoRows(err) {
			return nil, httpx.ErrNotFound
		}
		return nil, err
	}
	return c, nil
}

// channelBasics is the small row we read before permission checks.
type channelBasics struct {
	ID        int64
	Kind      string
	Name      string
	IsPrivate bool
	CreatedBy *int64
}

func (s *Server) channelBasics(ctx context.Context, channelID int64) (*channelBasics, error) {
	var b channelBasics
	err := s.DB.Pool.QueryRow(ctx,
		`SELECT id, kind, name, is_private, created_by FROM channels WHERE id = $1`, channelID).
		Scan(&b.ID, &b.Kind, &b.Name, &b.IsPrivate, &b.CreatedBy)
	if err != nil {
		if isNoRows(err) {
			return nil, httpx.ErrNotFound
		}
		return nil, err
	}
	return &b, nil
}

// canAdminChannel reports whether the user may rename a channel or remove members.
func canAdminChannel(b *channelBasics, u *db.User) bool {
	return u.IsAdmin || (b.CreatedBy != nil && *b.CreatedBy == u.ID)
}

// requireChannelAdmin gates channel management: workspace admins, or the
// creator while they can still read the channel. Without the read check a
// creator who was removed from their private channel (or whose allowlist no
// longer covers it) could flip it public and read it again.
func (s *Server) requireChannelAdmin(ctx context.Context, b *channelBasics, u *db.User) error {
	if !canAdminChannel(b, u) {
		return httpx.ErrForbidden
	}
	if u.IsAdmin {
		return nil
	}
	return s.requireMembership(ctx, b.ID, u)
}

// publishMembers sends channel.members to the channel plus the given extra
// users (a user who just left is no longer a member but still needs the frame).
func (s *Server) publishMembers(ctx context.Context, channelID int64, extra ...int64) {
	ids, err := s.channelMemberIDs(ctx, channelID)
	if err != nil {
		return
	}
	if ids == nil {
		ids = []int64{}
	}
	ev := realtime.Event{Type: "channel.members", Data: map[string]any{
		"channel_id":   channelID,
		"members":      ids,
		"member_count": len(ids),
	}}
	s.Hub.PublishUsers(ids, ev)
	for _, id := range extra {
		s.Hub.PublishUser(id, ev)
	}
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

// listChannelsQuery returns every channel the caller may see in one pass:
// public channels, private channels they belong to, and their DMs. All the
// per-viewer aggregates are computed with grouped CTEs rather than per row.
var listChannelsQuery = fmt.Sprintf(`
WITH my AS (
    SELECT channel_id, last_read_message_id, muted
      FROM channel_members WHERE user_id = $1
), visible AS (
    SELECT c.* FROM channels c
     WHERE ((c.kind = 'channel' AND (NOT c.is_private OR c.id IN (SELECT channel_id FROM my)))
        OR (c.kind = 'dm' AND c.id IN (SELECT channel_id FROM my)
            AND (c.last_message_at IS NOT NULL OR c.created_by = $1)))
       -- limited users ($2 false) only see allowlisted named channels; DMs
       -- are never restricted.
       AND (c.kind = 'dm' OR $2 OR c.name = ANY($3::text[]))
), counts AS (
    SELECT cm.channel_id, count(*) AS member_count
      FROM channel_members cm
      JOIN visible v ON v.id = cm.channel_id
     GROUP BY cm.channel_id
), unread AS (
    -- Counting every unread message means scanning all history on each call,
    -- which grows without bound. The UI renders anything at the cap as "99+",
    -- so stop there: this walks messages_channel_idx and quits after unreadCap
    -- rows per channel.
    SELECT my.channel_id,
           (SELECT count(*) FROM (
                SELECT 1 FROM messages m
                 WHERE m.channel_id = my.channel_id
                   AND m.id > my.last_read_message_id
                   AND m.user_id <> $1
                   AND m.deleted_at IS NULL
                   AND m.kind = 'user'
                   -- limited-history users: pre-account messages are not unread
                   AND m.created_at >= COALESCE((SELECT history_cutoff FROM users WHERE id = $1), '-infinity'::timestamptz)
                 -- ORDER BY is what makes the planner reach for
                 -- messages_unread_idx instead of walking the primary key.
                 ORDER BY m.id DESC
                 LIMIT %d
            ) capped) AS unread_count
      FROM my
), peers AS (
    SELECT cm.channel_id, COALESCE(MIN(NULLIF(cm.user_id, $1)), $1) AS peer_id
      FROM channel_members cm
      JOIN visible v ON v.id = cm.channel_id AND v.kind = 'dm'
     GROUP BY cm.channel_id
)
SELECT c.id, c.kind, c.name, c.topic, c.is_private, c.created_by, c.created_at, c.last_message_at,
       (my.channel_id IS NOT NULL) AS is_member,
       COALESCE(my.muted, false) AS muted,
       COALESCE(unread.unread_count, 0) AS unread_count,
       COALESCE(counts.member_count, 0) AS member_count,
       peers.peer_id
  FROM visible c
  LEFT JOIN my ON my.channel_id = c.id
  LEFT JOIN counts ON counts.channel_id = c.id
  LEFT JOIN unread ON unread.channel_id = c.id
  LEFT JOIN peers ON peers.channel_id = c.id`, unreadCap)

// announcePublicChannel fans an event about a public channel out to every user
// whose allowlist permits that channel — unrestricted users and limited users
// with the name listed. It replaces a blanket PublishAll so a "limited" user is
// not told about a channel they cannot open. allowed_channels is stored
// lowercased and space-free (see normalizeAllowedChannels), matching the
// lowercased channel name.
func (s *Server) announcePublicChannel(ctx context.Context, channelName string, ev realtime.Event) {
	rows, err := s.DB.Pool.Query(ctx,
		`SELECT id FROM users
		  WHERE allowed_channels = '*'
		     OR lower($1) = ANY(string_to_array(allowed_channels, ','))`, channelName)
	if err != nil {
		log.Printf("api: announce channel %q: %v", channelName, err)
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			log.Printf("api: announce channel %q: %v", channelName, err)
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Printf("api: announce channel %q: %v", channelName, err)
		return
	}
	s.Hub.PublishUsers(ids, ev)
}

// handleListChannels returns {channels, dms} for the caller: every public
// channel plus private ones they belong to, and their DM conversations, each
// with unread_count, member_count and last_message_at.
func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	allowAll, allowed := me.AllowedChannelsSQL()
	rows, err := s.DB.Pool.Query(r.Context(), listChannelsQuery, me.ID, allowAll, allowed)
	if err != nil {
		return err
	}
	defer rows.Close()

	channels := []db.Channel{}
	dms := []db.Channel{}
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return err
		}
		if c.Kind == db.KindDM {
			dms = append(dms, *c)
		} else {
			channels = append(channels, *c)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	sort.Slice(channels, func(i, j int) bool { return channels[i].Name < channels[j].Name })
	sort.Slice(dms, func(i, j int) bool {
		a, b := dms[i].LastMessageAt, dms[j].LastMessageAt
		switch {
		case a != nil && b != nil && !a.Equal(*b):
			return a.After(*b)
		case a != nil && b == nil:
			return true
		case a == nil && b != nil:
			return false
		}
		return dms[i].ID > dms[j].ID
	})

	httpx.JSON(w, http.StatusOK, map[string]any{"channels": channels, "dms": dms})
	return nil
}

// handleCreateChannel normalises the name, creates the channel, joins the
// creator, and publishes channel.new.
func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	var in struct {
		Name      string `json:"name"`
		Topic     string `json:"topic"`
		IsPrivate bool   `json:"is_private"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	name, err := normalizeChannelName(in.Name)
	if err != nil {
		return err
	}
	// The creator joins what they create; a limited user must not end up a
	// member (and live recipient) of a channel outside their allowlist.
	if !me.ChannelAllowed(name) {
		return httpx.ErrForbidden
	}
	topic := strings.TrimSpace(in.Topic)
	if len(topic) > 500 {
		topic = topic[:500]
	}

	ctx := r.Context()
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var id int64
	// The unique index is the arbiter: no SELECT-then-INSERT race here.
	err = tx.QueryRow(ctx,
		`INSERT INTO channels (kind, name, topic, is_private, created_by)
		 VALUES ('channel', $1, $2, $3, $4) RETURNING id`,
		name, topic, in.IsPrivate, me.ID).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return httpx.Conflict("That channel name is taken.")
		}
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, id, me.ID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	ch, err := s.loadChannel(ctx, id, me.ID)
	if err != nil {
		return err
	}

	// Broadcast copy carries is_member=false because it is the same payload for
	// everyone; the creator gets a corrected frame right after.
	if !ch.IsPrivate {
		broadcast := *ch
		broadcast.IsMember = false
		broadcast.UnreadCount = 0
		s.announcePublicChannel(ctx, ch.Name, realtime.Event{Type: "channel.new", Data: map[string]any{"channel": broadcast}})
		s.Hub.PublishUser(me.ID, realtime.Event{Type: "channel.new", Data: map[string]any{"channel": ch}})
	} else {
		s.publishToChannel(ctx, id, realtime.Event{Type: "channel.new", Data: map[string]any{"channel": ch}}, 0)
	}

	s.postSystemMessage(ctx, id, me.ID, me.DisplayName, "created this channel")
	httpx.JSON(w, http.StatusCreated, map[string]any{"channel": ch})
	return nil
}

// handleGetChannel returns one channel including its member ids.
func (s *Server) handleGetChannel(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireMembership(ctx, id, me); err != nil {
		return err
	}
	ch, err := s.loadChannel(ctx, id, me.ID)
	if err != nil {
		return err
	}
	members, err := s.channelMemberIDs(ctx, id)
	if err != nil {
		return err
	}
	if members == nil {
		members = []int64{}
	}
	ch.Members = members
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": ch})
	return nil
}

// handleUpdateChannel renames or re-topics a channel (creator or admin only).
func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Name      *string `json:"name"`
		Topic     *string `json:"topic"`
		IsPrivate *bool   `json:"is_private"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	basics, err := s.channelBasics(ctx, id)
	if err != nil {
		return err
	}
	if basics.Kind == db.KindDM {
		return httpx.ErrForbidden
	}
	if err := s.requireChannelAdmin(ctx, basics, me); err != nil {
		return err
	}

	// One statement, placeholders numbered as the args accumulate.
	var set []string
	var args []any
	if in.Name != nil {
		name, err := normalizeChannelName(*in.Name)
		if err != nil {
			return err
		}
		args = append(args, name)
		set = append(set, "name = $"+strconv.Itoa(len(args)))
	}
	if in.Topic != nil {
		topic := strings.TrimSpace(*in.Topic)
		if len(topic) > 500 {
			topic = topic[:500]
		}
		args = append(args, topic)
		set = append(set, "topic = $"+strconv.Itoa(len(args)))
	}
	privacyChanged := in.IsPrivate != nil && *in.IsPrivate != basics.IsPrivate
	if in.IsPrivate != nil {
		args = append(args, *in.IsPrivate)
		set = append(set, "is_private = $"+strconv.Itoa(len(args)))
	}
	if len(set) > 0 {
		args = append(args, id)
		sql := `UPDATE channels SET ` + strings.Join(set, ", ") + ` WHERE id = $` + strconv.Itoa(len(args))
		if _, err := s.DB.Pool.Exec(ctx, sql, args...); err != nil {
			if isUniqueViolation(err) {
				return httpx.Conflict("That channel name is taken.")
			}
			return err
		}
	}

	ch, err := s.loadChannel(ctx, id, me.ID)
	if err != nil {
		return err
	}
	if privacyChanged {
		// Privacy flips who may see the channel: made private, non-members must
		// drop it; made public, everyone (allowlist permitting) may now see and
		// join it. Per-viewer is_member and visibility are awkward to express in
		// one broadcast frame, so — a rare admin action — every client just
		// refetches its channel list, which reflects the new access exactly
		// (and carries any name/topic change in the same update). Members still
		// get the live channel.update for a snappy header/lock change.
		s.publishToChannel(ctx, id, realtime.Event{Type: "channel.update", Data: map[string]any{"channel": ch}}, 0)
		s.Hub.PublishAll(realtime.Event{Type: "channels.resync", Data: map[string]any{}})
	} else {
		ev := realtime.Event{Type: "channel.update", Data: map[string]any{"channel": ch}}
		if ch.IsPrivate {
			s.publishToChannel(ctx, id, ev, 0)
		} else {
			s.Hub.PublishAll(ev)
		}
	}

	// Activity notes, after the update is live.
	if in.Name != nil && ch.Name != basics.Name {
		s.postSystemMessage(ctx, id, me.ID, me.DisplayName, "renamed the channel to #"+ch.Name)
	}
	if privacyChanged {
		if ch.IsPrivate {
			s.postSystemMessage(ctx, id, me.ID, me.DisplayName, "made this channel private")
		} else {
			s.postSystemMessage(ctx, id, me.ID, me.DisplayName, "made this channel public")
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": ch})
	return nil
}

// handleJoinChannel adds the caller to a public channel.
func (s *Server) handleJoinChannel(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	basics, err := s.channelBasics(ctx, id)
	if err != nil {
		return err
	}
	if basics.Kind != db.KindChannel || basics.IsPrivate {
		return httpx.ErrForbidden
	}
	if !me.ChannelAllowed(basics.Name) {
		return httpx.ErrForbidden // a limited user cannot join outside its allowlist
	}
	tag, err := s.DB.Pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, me.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.publishMembers(ctx, id)
		s.postSystemMessage(ctx, id, me.ID, me.DisplayName, "joined the channel")
	}
	ch, err := s.loadChannel(ctx, id, me.ID)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": ch})
	return nil
}

// handleLeaveChannel removes the caller from a channel.
func (s *Server) handleLeaveChannel(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	basics, err := s.channelBasics(ctx, id)
	if err != nil {
		return err
	}
	if basics.Kind != db.KindChannel {
		return httpx.ErrForbidden
	}
	tag, err := s.DB.Pool.Exec(ctx,
		`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, id, me.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.publishMembers(ctx, id, me.ID)
	}
	httpx.NoContent(w)
	return nil
}

// handleAddMember adds another user to a channel and publishes channel.new to
// them plus channel.members to the channel.
func (s *Server) handleAddMember(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		UserID int64 `json:"user_id"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.UserID <= 0 {
		return httpx.BadRequest("A user_id is required.")
	}
	ctx := r.Context()
	basics, err := s.channelBasics(ctx, id)
	if err != nil {
		return err
	}
	if basics.Kind != db.KindChannel {
		return httpx.ErrForbidden
	}
	if !me.IsAdmin {
		member, err := s.isMember(ctx, id, me.ID)
		if err != nil {
			return err
		}
		if !member {
			return httpx.ErrForbidden
		}
	}
	var active bool
	var allowedChannels, addedName string
	if err := s.DB.Pool.QueryRow(ctx, `SELECT is_active, allowed_channels, display_name FROM users WHERE id = $1`, in.UserID).Scan(&active, &allowedChannels, &addedName); err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}
	if !active {
		return httpx.BadRequest("That account is deactivated.")
	}
	// Don't add a limited user to a channel outside their allowlist — that would
	// make them a member of a channel they still cannot open.
	if target := (db.User{AllowedChannels: allowedChannels}); !target.ChannelAllowed(basics.Name) {
		return httpx.Conflict("That user is limited to a set of channels that does not include this one.")
	}

	tag, err := s.DB.Pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, in.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		if ch, err := s.loadChannel(ctx, id, in.UserID); err == nil {
			s.Hub.PublishUser(in.UserID, realtime.Event{Type: "channel.new", Data: map[string]any{"channel": ch}})
		}
		s.publishMembers(ctx, id)
		// Attribute the note to the joiner, like a self-join.
		s.postSystemMessage(ctx, id, in.UserID, addedName, "joined the channel")
	}
	httpx.NoContent(w)
	return nil
}

// handleRemoveMember removes a user (creator or admin only).
func (s *Server) handleRemoveMember(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	target, err := httpx.PathInt(r, "userID")
	if err != nil {
		return err
	}
	ctx := r.Context()
	basics, err := s.channelBasics(ctx, id)
	if err != nil {
		return err
	}
	if basics.Kind != db.KindChannel {
		return httpx.ErrForbidden
	}
	if err := s.requireChannelAdmin(ctx, basics, me); err != nil {
		return err
	}
	tag, err := s.DB.Pool.Exec(ctx,
		`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, id, target)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.publishMembers(ctx, id, target)
	}
	httpx.NoContent(w)
	return nil
}

// handleSetMute turns web push for a channel on or off. Muting is per-member,
// not a property of the channel, so it lives on channel_members and any member
// may set their own.
func (s *Server) handleSetMute(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Muted bool `json:"muted"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}

	tag, err := s.DB.Pool.Exec(r.Context(),
		`UPDATE channel_members SET muted = $1 WHERE channel_id = $2 AND user_id = $3`,
		in.Muted, id, me.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.ErrForbidden
	}

	// Other tabs of the same person need to redraw the channel row.
	s.Hub.PublishUser(me.ID, realtime.Event{Type: "channel.mute", Data: map[string]any{
		"channel_id": id,
		"muted":      in.Muted,
	}})
	httpx.NoContent(w)
	return nil
}

// handleMarkRead advances channel_members.last_read_message_id and echoes
// channel.read to the caller's other tabs.
func (s *Server) handleMarkRead(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		LastMessageID int64 `json:"last_message_id"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.LastMessageID < 0 {
		return httpx.BadRequest("Invalid last_message_id.")
	}

	var stored int64
	err = s.DB.Pool.QueryRow(r.Context(),
		`UPDATE channel_members SET last_read_message_id = GREATEST(last_read_message_id, $1)
		  WHERE channel_id = $2 AND user_id = $3 RETURNING last_read_message_id`,
		in.LastMessageID, id, me.ID).Scan(&stored)
	if err != nil {
		// Not a member: nothing to remember, but not an error either.
		if isNoRows(err) {
			httpx.NoContent(w)
			return nil
		}
		return err
	}
	// Reading cancels any push still queued for this channel: this is the
	// grace period doing its job. The worker re-checks read state at delivery
	// anyway, so this is an optimisation, not the only guard.
	_, _ = s.DB.Pool.Exec(r.Context(),
		`DELETE FROM push_queue
		  WHERE user_id = $1 AND channel_id = $2 AND message_id <= $3`,
		me.ID, id, stored)
	s.Hub.PublishUser(me.ID, realtime.Event{Type: "channel.read", Data: map[string]any{
		"channel_id":           id,
		"last_read_message_id": stored,
	}})
	httpx.NoContent(w)
	return nil
}

// handleTyping publishes a typing event to the rest of the channel. It never
// writes to the database: clients call this every few keystrokes.
func (s *Server) handleTyping(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	// Read access gates who may emit "typing": otherwise a non-member could
	// inject a fake indicator into a private channel or DM. requireMembership
	// still lets any signed-in user type in a public channel (auto-join on send).
	if err := s.requireMembership(r.Context(), id, me); err != nil {
		return err
	}
	s.publishToChannel(r.Context(), id, realtime.Event{Type: "typing", Data: map[string]any{
		"channel_id": id,
		"user_id":    me.ID,
	}}, me.ID)
	httpx.NoContent(w)
	return nil
}

// handleOpenDM finds or creates the 1:1 DM channel with another user.
func (s *Server) handleOpenDM(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	var in struct {
		UserID int64 `json:"user_id"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.UserID <= 0 {
		return httpx.BadRequest("A user_id is required.")
	}
	ctx := r.Context()

	var active bool
	if err := s.DB.Pool.QueryRow(ctx, `SELECT is_active FROM users WHERE id = $1`, in.UserID).Scan(&active); err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}
	if !active {
		return httpx.BadRequest("That account is deactivated.")
	}

	key := dmKey(me.ID, in.UserID)
	// Insert-or-ignore then read back: two callers racing both end up on the
	// row the unique index kept.
	tag, err := s.DB.Pool.Exec(ctx,
		`INSERT INTO channels (kind, name, dm_key, created_by) VALUES ('dm', '', $1, $2)
		 ON CONFLICT (dm_key) WHERE dm_key IS NOT NULL DO NOTHING`, key, me.ID)
	if err != nil {
		return err
	}
	created := tag.RowsAffected() > 0

	var id int64
	if err := s.DB.Pool.QueryRow(ctx, `SELECT id FROM channels WHERE dm_key = $1`, key).Scan(&id); err != nil {
		return err
	}

	members := []int64{me.ID}
	if in.UserID != me.ID {
		members = append(members, in.UserID)
	}
	for _, uid := range members {
		if _, err := s.DB.Pool.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			id, uid); err != nil {
			return err
		}
	}

	ch, err := s.loadChannel(ctx, id, me.ID)
	if err != nil {
		return err
	}
	if created && in.UserID != me.ID {
		if peerView, err := s.loadChannel(ctx, id, in.UserID); err == nil {
			s.Hub.PublishUser(in.UserID, realtime.Event{Type: "channel.new", Data: map[string]any{"channel": peerView}})
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": ch})
	return nil
}

// touchChannel bumps last_message_at; kept here so both message inserts and
// any future writers agree on the column.
func touchChannel(ctx context.Context, ex interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, channelID int64, at time.Time) error {
	_, err := ex.Exec(ctx, `UPDATE channels SET last_message_at = $2 WHERE id = $1`, channelID, at)
	return err
}
