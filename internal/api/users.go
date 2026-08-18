package api

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/realtime"
)

const (
	maxDisplayNameLen = 60
	maxStatusTextLen  = 80
	avatarColorCount  = 12
)

// publicUserColumns is userColumns minus the email and the password flag: what
// every signed-in user is allowed to see about everyone else.
const publicUserColumns = `u.id, u.display_name, u.avatar_color, u.status_text,
	u.is_admin, u.is_active, u.is_bot, u.created_at, u.last_seen_at, u.avatar_sha`

func scanPublicUserRow(row pgx.Row, u *db.User) error {
	if err := row.Scan(&u.ID, &u.DisplayName, &u.AvatarColor, &u.StatusText,
		&u.IsAdmin, &u.IsActive, &u.IsBot, &u.CreatedAt, &u.LastSeenAt, &u.AvatarSHA); err != nil {
		return err
	}
	u.SetAvatarURL()
	return nil
}

// handleListUsers returns every active user (no emails).
func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.DB.Pool.Query(r.Context(),
		`SELECT `+publicUserColumns+` FROM users u WHERE u.is_active ORDER BY lower(u.display_name), u.id`)
	if err != nil {
		return err
	}
	defer rows.Close()

	users := []db.User{}
	for rows.Next() {
		var u db.User
		if err := scanPublicUserRow(rows, &u); err != nil {
			return err
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"users": users})
	return nil
}

// handleUpdateMe patches display_name / avatar_color / status_text and
// broadcasts user.update so other clients relabel messages live.
func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		DisplayName *string `json:"display_name"`
		AvatarColor *int16  `json:"avatar_color"`
		StatusText  *string `json:"status_text"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.DisplayName == nil && in.AvatarColor == nil && in.StatusText == nil {
		return httpx.BadRequest("Nothing to update.")
	}

	if in.DisplayName != nil {
		name := strings.TrimSpace(*in.DisplayName)
		if name == "" || utf8.RuneCountInString(name) > maxDisplayNameLen {
			return httpx.BadRequest("Display name must be 1 to 60 characters.")
		}
		in.DisplayName = &name
	}
	if in.AvatarColor != nil && (*in.AvatarColor < 0 || *in.AvatarColor >= avatarColorCount) {
		return httpx.BadRequest("Avatar colour must be between 0 and 11.")
	}
	if in.StatusText != nil {
		status := strings.TrimSpace(*in.StatusText)
		if utf8.RuneCountInString(status) > maxStatusTextLen {
			return httpx.BadRequest("Status must be at most 80 characters.")
		}
		in.StatusText = &status
	}

	var u db.User
	row := s.DB.Pool.QueryRow(r.Context(),
		`UPDATE users u SET
			display_name = COALESCE($2::text, u.display_name),
			avatar_color = COALESCE($3::smallint, u.avatar_color),
			status_text  = COALESCE($4::text, u.status_text)
		 WHERE u.id = $1
		 RETURNING `+publicUserColumns,
		currentUser(r).ID, in.DisplayName, in.AvatarColor, in.StatusText)
	if err := scanPublicUserRow(row, &u); err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}

	s.Hub.PublishAll(realtime.Event{Type: "user.update", Data: map[string]any{"user": u}})

	httpx.JSON(w, http.StatusOK, map[string]any{"user": u})
	return nil
}
