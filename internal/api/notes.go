package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/realtime"
	"slock/internal/textop"
)

// Shared notes are channels of kind 'note' (see migration 0013): the channel
// endpoints handle their name, privacy, members and deletion, and these
// handle the text. Several people edit one note at once: each client sends
// its edits as textop operations made against the revision it last saw, the
// server rebases them over whatever landed since (textop.Transform), applies
// them, and streams every applied edit to the note's members as note.op, in
// revision order. A client that sees a gap in the revisions fetches the
// missing edits with GET /api/notes/{id}/ops.

const (
	maxNoteNameLen = 80
	// maxNoteLen bounds a note's text, in UTF-16 units (the unit of every
	// position in an edit). Roughly a 200-page book.
	maxNoteLen = 500_000
	// noteOpsKept is how many past edits a note keeps for rebasing and for
	// catching up: a client further behind than this reloads the note.
	noteOpsKept = 1000
)

// normalizeNoteName trims a note title. Unlike channel names a title is free
// text, spaces and capitals included; it just has to fit on one line.
func normalizeNoteName(raw string) (string, error) {
	name := strings.Join(strings.FieldsFunc(raw, unicode.IsSpace), " ")
	if name == "" || utf8.RuneCountInString(name) > maxNoteNameLen {
		return "", httpx.BadRequest("Note titles are 1-80 characters.")
	}
	return name, nil
}

// unrestricted reports whether u may see every public channel and note, i.e.
// is not a "limited" user confined to an allowlist.
func unrestricted(u *db.User) bool {
	all, _ := u.AllowedChannelsSQL()
	return all
}

// announcePublicNote sends an event about a public note to everyone who lists
// it: every user who is not limited to an allowlist (a limited user only ever
// sees the notes they were invited to).
func (s *Server) announcePublicNote(ctx context.Context, ev realtime.Event) {
	rows, err := s.DB.Pool.Query(ctx, `SELECT id FROM users WHERE allowed_channels = '*'`)
	if err != nil {
		log.Printf("api: announce note: %v", err)
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	s.Hub.PublishUsers(ids, ev)
}

// handleCreateNote creates a note, private unless asked otherwise, with the
// caller as its only member.
func (s *Server) handleCreateNote(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	var in struct {
		Name      string `json:"name"`
		IsPrivate *bool  `json:"is_private"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	name, err := normalizeNoteName(in.Name)
	if err != nil {
		return err
	}
	private := in.IsPrivate == nil || *in.IsPrivate
	if !private && !unrestricted(me) {
		return httpx.ErrForbidden // a limited user cannot publish to everyone
	}

	ctx := r.Context()
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id int64
	if err := tx.QueryRow(ctx,
		`INSERT INTO channels (kind, name, is_private, created_by) VALUES ('note', $1, $2, $3) RETURNING id`,
		name, private, me.ID).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, id, me.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO notes (channel_id, updated_by) VALUES ($1, $2)`, id, me.ID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	ch, err := s.loadChannel(ctx, id, me.ID)
	if err != nil {
		return err
	}
	if !ch.IsPrivate {
		broadcast := *ch
		broadcast.IsMember = false
		s.announcePublicNote(ctx, realtime.Event{Type: "channel.new", Data: map[string]any{"channel": broadcast}})
	}
	s.Hub.PublishUser(me.ID, realtime.Event{Type: "channel.new", Data: map[string]any{"channel": ch}})
	httpx.JSON(w, http.StatusCreated, map[string]any{"channel": ch})
	return nil
}

// noteBasics loads a channel for a note endpoint: it must be a note the
// caller may read.
func (s *Server) noteBasics(ctx context.Context, id int64, me *db.User) (*channelBasics, error) {
	b, err := s.channelBasics(ctx, id)
	if err != nil {
		return nil, err
	}
	if b.Kind != db.KindNote {
		return nil, httpx.ErrNotFound
	}
	if err := s.requireMembership(ctx, id, me); err != nil {
		return nil, err
	}
	return b, nil
}

// handleGetNote returns a note's text and the revision it is at.
func (s *Server) handleGetNote(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.noteBasics(ctx, id, me); err != nil {
		return err
	}
	var (
		body      string
		rev       int64
		updatedAt time.Time
		updatedBy *int64
	)
	if err := s.DB.Pool.QueryRow(ctx,
		`SELECT body, rev, updated_at, updated_by FROM notes WHERE channel_id = $1`, id).
		Scan(&body, &rev, &updatedAt, &updatedBy); err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"note": map[string]any{
		"channel_id": id, "body": body, "rev": rev,
		"updated_at": updatedAt, "updated_by": updatedBy,
	}})
	return nil
}

// noteOp is one applied edit, as stored and as streamed.
type noteOp struct {
	ChannelID int64      `json:"channel_id"`
	Rev       int64      `json:"rev"`
	UserID    *int64     `json:"user_id"`
	ClientOp  string     `json:"client_op"`
	Op        *textop.Op `json:"op"`
}

// handleNoteOps lists the edits after ?since=, oldest first, so a client
// that missed some (a dropped stream, a slow connection) can catch up. 409
// when they have been pruned: the client reloads the note instead.
func (s *Server) handleNoteOps(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	since := int64(httpx.QueryInt(r, "since", 0))
	ctx := r.Context()
	if _, err := s.noteBasics(ctx, id, me); err != nil {
		return err
	}
	var rev int64
	if err := s.DB.Pool.QueryRow(ctx, `SELECT rev FROM notes WHERE channel_id = $1`, id).Scan(&rev); err != nil {
		return err
	}
	ops, err := s.loadNoteOps(ctx, s.DB.Pool, id, since)
	if err != nil {
		return err
	}
	if int64(len(ops)) != rev-since {
		return httpx.Conflict("This note changed too much since; reload it.")
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"rev": rev, "ops": ops})
	return nil
}

// rowsQuerier is what loadNoteOps reads through: the pool, or a transaction.
type rowsQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// loadNoteOps reads the stored edits of a note after revision since.
func (s *Server) loadNoteOps(ctx context.Context, q rowsQuerier, channelID, since int64) ([]noteOp, error) {
	rows, err := q.Query(ctx,
		`SELECT rev, user_id, client_op, op FROM note_ops WHERE channel_id = $1 AND rev > $2 ORDER BY rev`,
		channelID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ops := []noteOp{}
	for rows.Next() {
		o := noteOp{ChannelID: channelID, Op: &textop.Op{}}
		var raw []byte
		if err := rows.Scan(&o.Rev, &o.UserID, &o.ClientOp, &raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, o.Op); err != nil {
			return nil, err
		}
		ops = append(ops, o)
	}
	return ops, rows.Err()
}

// noteLock serialises the edits of one note inside this process, from the
// row lock to the publish, so note.op frames leave in revision order.
func (s *Server) noteLock(id int64) *sync.Mutex {
	m, _ := s.noteLocks.LoadOrStore(id, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// handleNoteEdit applies one edit. The body names the revision the edit was
// made against (base_rev); the server rebases it over every edit applied
// since, applies it, and answers with the revision it became. client_op makes
// a retried send safe: an edit already applied answers with its revision.
// Editing a public note you are not in joins you, like posting to a channel.
func (s *Server) handleNoteEdit(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		BaseRev  int64     `json:"base_rev"`
		ClientOp string    `json:"client_op"`
		Op       textop.Op `json:"op"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return httpx.BadRequest("Invalid edit.")
	}
	if len(in.ClientOp) > maxClientID {
		return httpx.BadRequest("Invalid client_op.")
	}
	ctx := r.Context()
	if _, err := s.noteBasics(ctx, id, me); err != nil {
		return err
	}
	member, err := s.isMember(ctx, id, me.ID)
	if err != nil {
		return err
	}

	mu := s.noteLock(id)
	mu.Lock()
	defer mu.Unlock()

	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var body string
	var rev int64
	if err := tx.QueryRow(ctx, `SELECT body, rev FROM notes WHERE channel_id = $1 FOR UPDATE`, id).Scan(&body, &rev); err != nil {
		return err
	}
	if in.ClientOp != "" {
		var done int64
		err := tx.QueryRow(ctx, `SELECT rev FROM note_ops WHERE channel_id = $1 AND client_op = $2`, id, in.ClientOp).Scan(&done)
		if err == nil {
			httpx.JSON(w, http.StatusOK, map[string]any{"rev": done})
			return nil
		}
		if !isNoRows(err) {
			return err
		}
	}
	if in.BaseRev < 0 || in.BaseRev > rev {
		return httpx.BadRequest("Invalid base_rev.")
	}
	since, err := s.loadNoteOps(ctx, tx, id, in.BaseRev)
	if err != nil {
		return err
	}
	if int64(len(since)) != rev-in.BaseRev {
		return httpx.Conflict("This note changed too much since; reload it.")
	}
	op := &in.Op
	for _, o := range since {
		if op, _, err = textop.Transform(op, o.Op); err != nil {
			return httpx.BadRequest("That edit does not match the note.")
		}
	}
	next, err := op.Apply(body)
	if err != nil {
		return httpx.BadRequest("That edit does not match the note.")
	}
	if op.TargetLen() > maxNoteLen && op.TargetLen() > op.BaseLen() {
		return httpx.BadRequest("This note is too long.")
	}
	rev++
	raw, err := json.Marshal(op)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO note_ops (channel_id, rev, user_id, client_op, op) VALUES ($1, $2, $3, $4, $5)`,
		id, rev, me.ID, in.ClientOp, raw); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE notes SET body = $2, rev = $3, updated_at = now(), updated_by = $4 WHERE channel_id = $1`,
		id, next, rev, me.ID); err != nil {
		return err
	}
	if rev%100 == 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM note_ops WHERE channel_id = $1 AND rev <= $2`, id, rev-noteOpsKept); err != nil {
			return err
		}
	}
	if !member {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, me.ID); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	if !member {
		s.publishMembers(ctx, id)
	}
	uid := me.ID
	s.publishToChannel(ctx, id, realtime.Event{Type: "note.op", Data: noteOp{
		ChannelID: id, Rev: rev, UserID: &uid, ClientOp: in.ClientOp, Op: op,
	}}, 0)
	httpx.JSON(w, http.StatusOK, map[string]any{"rev": rev})
	return nil
}

// handleNoteCaret relays where the caller's caret (or selection) is in a note
// to its other members, as note.caret: {channel_id, user_id, rev, start,
// end}. Positions count UTF-16 units in the text at revision rev; receivers
// shift them through the edits since. start < 0 means "gone" (the caller
// left the note). Nothing is stored, like typing.
func (s *Server) handleNoteCaret(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Rev   int64 `json:"rev"`
		Start int   `json:"start"`
		End   int   `json:"end"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.noteBasics(ctx, id, me); err != nil {
		return err
	}
	if in.Start < 0 {
		in.Start, in.End = -1, -1
	} else if in.End < in.Start {
		in.End = in.Start
	}
	s.publishToChannel(ctx, id, realtime.Event{Type: "note.caret", Data: map[string]any{
		"channel_id": id, "user_id": me.ID, "rev": in.Rev, "start": in.Start, "end": in.End,
	}}, me.ID)
	httpx.NoContent(w)
	return nil
}

// fillNoteRevs sets each note's NoteRev, so a client can tell which of the
// notes it keeps for offline reading changed since it saved them.
func (s *Server) fillNoteRevs(ctx context.Context, notes []db.Channel) error {
	if len(notes) == 0 {
		return nil
	}
	ids := make([]int64, len(notes))
	at := make(map[int64]int, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
		at[n.ID] = i
	}
	rows, err := s.DB.Pool.Query(ctx, `SELECT channel_id, rev FROM notes WHERE channel_id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, rev int64
		if err := rows.Scan(&id, &rev); err != nil {
			return err
		}
		notes[at[id]].NoteRev = rev
	}
	return rows.Err()
}
