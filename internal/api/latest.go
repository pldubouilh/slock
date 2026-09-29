package api

import (
	"net/http"
	"strconv"
	"strings"

	"slock/internal/db"
	"slock/internal/httpx"
)

// handleLatest is the "Latest" meta-channel: the newest messages across every
// channel and DM the caller belongs to, newest last, paged backwards with
// ?before=<message id>. Membership (not mere readability) scopes it, so it
// follows what the sidebar shows rather than every public channel.
//
//	?dms=0         leave DMs out (default: included)
//	?only=1,2,3    restrict named channels to these ids (the client's
//	               favourites); DMs are governed by ?dms alone. An empty
//	               ?only= means "no named channels".
//
// The same rules as a channel's history apply: the allowlist, the per-user
// history cutoff, no deleted messages, and no system notes (they are channel
// housekeeping, not news).
func (s *Server) handleLatest(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	q := r.URL.Query()
	limit := httpx.Clamp(httpx.QueryInt(r, "limit", 50), 1, 100)
	before := int64(httpx.QueryInt(r, "before", 0))

	args := []any{me.ID, me.HistoryCutoff}
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	where := []string{
		"m.deleted_at IS NULL",
		"m.kind = 'user'",
		"($2::timestamptz IS NULL OR m.created_at >= $2)",
	}
	if allowAll, allowed := me.AllowedChannelsSQL(); !allowAll {
		where = append(where, "(c.kind = 'dm' OR c.name = ANY("+arg(allowed)+"::text[]))")
	}
	if q.Get("dms") == "0" {
		where = append(where, "c.kind <> 'dm'")
	}
	if q.Has("only") {
		ids := []int64{}
		for part := range strings.SplitSeq(q.Get("only"), ",") {
			if id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64); err == nil && id > 0 {
				ids = append(ids, id)
			}
		}
		where = append(where, "(c.kind = 'dm' OR m.channel_id = ANY("+arg(ids)+"::bigint[]))")
	}
	if before > 0 {
		where = append(where, "m.id < "+arg(before))
	}

	rows, err := s.DB.Pool.Query(r.Context(),
		`SELECT `+messageCols+`
		   FROM messages m
		   JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $1
		   JOIN channels c ON c.id = m.channel_id
		  WHERE `+strings.Join(where, " AND ")+`
		  ORDER BY m.id DESC
		  LIMIT `+arg(limit+1), args...)
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
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	if err := s.hydrate(r.Context(), msgs, me.ID); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"messages": msgs, "has_more": hasMore})
	return nil
}
