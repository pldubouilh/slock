package api

import (
	"context"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/realtime"
)

// handleDeleteChannel permanently deletes a named channel or a note: its messages,
// pins, reactions, memberships and queued pushes go with it (ON DELETE
// CASCADE), and its files once nothing else uses them. Creator (while they
// can still read it) or admin, like the other channel settings. The body must
// repeat the channel's name — the client makes you type it, and a stray API
// call cannot wipe a channel by id alone. DMs are closed, never deleted.
func (s *Server) handleDeleteChannel(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Name string `json:"name"`
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
	if !strings.EqualFold(strings.TrimPrefix(strings.TrimSpace(in.Name), "#"), basics.Name) {
		if basics.Kind == db.KindNote {
			return httpx.BadRequest("Type the note's title to confirm.")
		}
		return httpx.BadRequest("Type the channel's name to confirm.")
	}

	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Who to tell, and which files may now be unused — read before the rows go.
	rows, err := tx.Query(ctx, `SELECT user_id FROM channel_members WHERE channel_id = $1`, id)
	if err != nil {
		return err
	}
	members, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return err
	}
	rows, err = tx.Query(ctx,
		`SELECT DISTINCT a.sha256 FROM attachments a JOIN messages m ON m.id = a.message_id
		  WHERE m.channel_id = $1`, id)
	if err != nil {
		return err
	}
	shas, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM channels WHERE id = $1`, id); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	ev := realtime.Event{Type: "channel.delete", Data: map[string]any{"channel_id": id}}
	if basics.IsPrivate {
		s.Hub.PublishUsers(members, ev)
	} else if basics.Kind == db.KindNote {
		s.announcePublicNote(ctx, ev)
	} else {
		// Everyone who can see a public channel lists it, member or not.
		s.announcePublicChannel(ctx, basics.Name, ev)
	}
	// Detached: the request is done; this is housekeeping.
	go s.dropUnusedFiles(context.Background(), shas)
	httpx.NoContent(w)
	return nil
}

// dropUnusedFiles removes stored files no attachment, avatar or workspace icon
// points at any more. The store is content-addressed, so the same bytes can
// back several attachments; only the last reference may delete them.
func (s *Server) dropUnusedFiles(ctx context.Context, shas []string) {
	for _, sha := range shas {
		var used bool
		err := s.DB.Pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM attachments WHERE sha256 = $1)
			     OR EXISTS (SELECT 1 FROM users WHERE avatar_sha = $1)
			     OR EXISTS (SELECT 1 FROM settings WHERE key = $2 AND value = $1)`,
			sha, settingWorkspaceIconSHA).Scan(&used)
		if err != nil {
			log.Printf("api: file %s still in use?: %v", sha, err)
			continue
		}
		if used {
			continue
		}
		if err := s.Media.Delete(sha); err != nil {
			log.Printf("api: delete file %s: %v", sha, err)
		}
	}
}
