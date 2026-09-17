package api

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/realtime"
)

// tempPasswordBytes is the entropy of an admin-generated password: 12 random
// bytes, base64url encoded to 16 characters.
const tempPasswordBytes = 12

// handleAdminListUsers returns all users including inactive ones, with emails.
func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.DB.Pool.Query(r.Context(),
		`SELECT `+userColumns+` FROM users u WHERE NOT u.is_bot
		  ORDER BY lower(u.display_name), u.id`)
	if err != nil {
		return err
	}
	defer rows.Close()

	users := []db.User{}
	for rows.Next() {
		var u db.User
		if err := scanUserRow(rows, &u); err != nil {
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

// placeholderName derives a legible stand-in display name from an email until
// the user sets their own on first login: the local part, capped.
func placeholderName(email string) string {
	name := email
	if at := strings.IndexByte(email, '@'); at > 0 {
		name = email[:at]
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return "New user"
	}
	if utf8.RuneCountInString(name) > maxDisplayNameLen {
		r := []rune(name)
		name = string(r[:maxDisplayNameLen])
	}
	return name
}

// handleAdminCreateUser creates a user with a generated temporary password,
// auto-joins #general, returns the password once, and mails a welcome
// best-effort when SendGrid is configured.
func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email   string `json:"email"`
		IsAdmin bool   `json:"is_admin"`
		// DisplayName is optional now: the web UI omits it (the user picks a
		// name on first login), but the CLI and any older client may still send
		// one, in which case it is used as the initial name.
		DisplayName string `json:"display_name"`
		// LimitHistory hides everything said before this account existed:
		// history pages, search, pins, attachment lists, unread counts.
		LimitHistory bool `json:"limit_history"`
		// AllowedChannels restricts a "limited" user to named channels ("*" or
		// blank = every channel). DMs are never restricted.
		AllowedChannels string `json:"allowed_channels"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	email := strings.TrimSpace(in.Email)
	if !looksLikeEmail(email) {
		return httpx.BadRequest("A valid email address is required.")
	}
	// A supplied name wins; otherwise a placeholder derived from the email
	// stands in until the user chooses one on first login (keeps the NOT NULL
	// column and the UI legible).
	name := strings.TrimSpace(in.DisplayName)
	if name == "" {
		name = placeholderName(email)
	} else if utf8.RuneCountInString(name) > maxDisplayNameLen {
		return httpx.BadRequest("Display name must be 1 to 60 characters.")
	}
	allowed := normalizeAllowedChannels(in.AllowedChannels)

	tempPassword, err := newToken(tempPasswordBytes)
	if err != nil {
		return err
	}
	hash, err := hashPassword(tempPassword)
	if err != nil {
		return err
	}

	var u db.User
	row := s.DB.Pool.QueryRow(r.Context(),
		`INSERT INTO users (email, display_name, password_hash, avatar_color, is_admin, must_change_pw, history_cutoff, allowed_channels)
		 VALUES ($1, $2, $3, $4, $5, TRUE, CASE WHEN $6 THEN now() END, $7)
		 RETURNING `+userColumnsBare,
		email, name, hash, avatarColorFor(email), in.IsAdmin, in.LimitHistory, allowed)
	if err := scanUserRow(row, &u); err != nil {
		if isUniqueViolation(err) {
			return httpx.Conflict("That email address is already registered.")
		}
		return err
	}

	// Everyone starts in #general when it exists — unless a limited user's
	// allowlist excludes it (membership is kept in step with access so realtime
	// never reaches a channel the user cannot open).
	if u.ChannelAllowed("general") {
		if _, err := s.DB.Pool.Exec(r.Context(),
			`INSERT INTO channel_members (channel_id, user_id)
			 SELECT c.id, $1::bigint FROM channels c WHERE c.kind = 'channel' AND lower(c.name) = 'general'
			 ON CONFLICT DO NOTHING`, u.ID); err != nil {
			log.Printf("api: auto-join general for user %d: %v", u.ID, err)
		}
	}

	s.sendWelcome(u.Email, u.DisplayName, tempPassword)

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"user":          u,
		"temp_password": tempPassword,
	})
	return nil
}

// handleAdminUpdateUser patches display_name / is_admin / is_active. An admin
// may not demote or deactivate themselves. Deactivating drops all sessions and
// push subscriptions.
func (s *Server) handleAdminUpdateUser(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		DisplayName     *string `json:"display_name"`
		IsAdmin         *bool   `json:"is_admin"`
		IsActive        *bool   `json:"is_active"`
		AllowedChannels *string `json:"allowed_channels"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.DisplayName == nil && in.IsAdmin == nil && in.IsActive == nil && in.AllowedChannels == nil {
		return httpx.BadRequest("Nothing to update.")
	}
	if in.DisplayName != nil {
		name := strings.TrimSpace(*in.DisplayName)
		if name == "" || utf8.RuneCountInString(name) > maxDisplayNameLen {
			return httpx.BadRequest("Display name must be 1 to 60 characters.")
		}
		in.DisplayName = &name
	}
	if in.AllowedChannels != nil {
		normalized := normalizeAllowedChannels(*in.AllowedChannels)
		in.AllowedChannels = &normalized
	}

	me := currentUser(r)
	if id == me.ID {
		if in.IsAdmin != nil && !*in.IsAdmin {
			return httpx.Conflict("You cannot remove your own admin rights.")
		}
		if in.IsActive != nil && !*in.IsActive {
			return httpx.Conflict("You cannot deactivate your own account.")
		}
	}

	var u db.User
	row := s.DB.Pool.QueryRow(r.Context(),
		`UPDATE users SET
			display_name     = COALESCE($2::text, display_name),
			is_admin         = COALESCE($3::boolean, is_admin),
			is_active        = COALESCE($4::boolean, is_active),
			allowed_channels = COALESCE($5::text, allowed_channels)
		 WHERE id = $1
		 RETURNING `+userColumnsBare,
		id, in.DisplayName, in.IsAdmin, in.IsActive, in.AllowedChannels)
	if err := scanUserRow(row, &u); err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}

	// Tightening the allowlist drops memberships in now-forbidden named channels
	// so access and membership stay in step (otherwise realtime would keep
	// reaching a channel the user can no longer open). DMs are never touched.
	if in.AllowedChannels != nil {
		if allowAll, allowed := u.AllowedChannelsSQL(); !allowAll {
			if _, err := s.DB.Pool.Exec(r.Context(),
				`DELETE FROM channel_members cm USING channels c
				  WHERE cm.user_id = $1 AND cm.channel_id = c.id
				    AND c.kind = 'channel' AND NOT (c.name = ANY($2::text[]))`,
				u.ID, allowed); err != nil {
				return err
			}
		}
		// Nudge the affected user's own clients to refresh their channel list so
		// the change is live, not pending a reconnect.
		s.Hub.PublishUser(u.ID, realtime.Event{Type: "channels.resync", Data: map[string]any{}})
	}

	if !u.IsActive {
		if _, err := s.DB.Pool.Exec(r.Context(), `DELETE FROM sessions WHERE user_id = $1`, u.ID); err != nil {
			return err
		}
		if _, err := s.DB.Pool.Exec(r.Context(), `DELETE FROM push_subscriptions WHERE user_id = $1`, u.ID); err != nil {
			return err
		}
	}

	// Other clients render names and colours from their own user cache.
	public := u
	public.Email = ""
	public.MustChangePW = false
	public.AllowedChannels = "" // a user's allowlist is not other users' business
	s.Hub.PublishAll(realtime.Event{Type: "user.update", Data: map[string]any{"user": public}})

	httpx.JSON(w, http.StatusOK, map[string]any{"user": u})
	return nil
}

// handleAdminResetPassword sets a new temporary password and returns it once.
func (s *Server) handleAdminResetPassword(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	tempPassword, err := newToken(tempPasswordBytes)
	if err != nil {
		return err
	}
	hash, err := hashPassword(tempPassword)
	if err != nil {
		return err
	}

	var email, name string
	err = s.DB.Pool.QueryRow(r.Context(),
		`UPDATE users SET password_hash = $2, must_change_pw = TRUE WHERE id = $1
		 RETURNING email, display_name`, id, hash).Scan(&email, &name)
	if err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}

	// Every existing session used the old password; none of them survive.
	if _, err := s.DB.Pool.Exec(r.Context(), `DELETE FROM sessions WHERE user_id = $1`, id); err != nil {
		return err
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"temp_password": tempPassword})
	return nil
}

// sendWelcome mails the temporary password in the background. Delivery is
// best-effort: the admin always has the password from the response.
func (s *Server) sendWelcome(email, name, tempPassword string) {
	loginURL := s.Cfg.BaseURL + "/"
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.Mailer.SendWelcome(ctx, email, name, tempPassword, loginURL); err != nil {
			log.Printf("api: send welcome to %s: %v", email, err)
		}
	}()
}

// looksLikeEmail is a deliberately loose check: real validation is delivery.
func looksLikeEmail(email string) bool {
	if len(email) < 3 || len(email) > 254 || strings.ContainsAny(email, " \t\r\n") {
		return false
	}
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return false
	}
	return strings.Contains(email[at+1:], ".")
}

// avatarColorFor picks a stable default colour so new users are not all grey.
func avatarColorFor(seed string) int16 {
	var sum uint32
	for i := 0; i < len(seed); i++ {
		sum = sum*31 + uint32(seed[i])
	}
	return int16(sum % avatarColorCount)
}
