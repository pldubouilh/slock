package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/password"
)

const (
	minPasswordLen = 8
	// No algorithmic limit any more (PBKDF2 takes any length); this is just a
	// sanity bound so a megabyte of "password" cannot be posted.
	maxPasswordLen  = 256
	resetTokenTTL   = time.Hour
	defaultSessTTL  = 30 * 24 * time.Hour
	lastSeenRefresh = time.Minute
)

// userColumns is the shared SELECT list for a users row aliased as u;
// userColumnsBare is the same list for INSERT/UPDATE ... RETURNING.
const (
	userColumns = `u.id, u.email, u.display_name, u.avatar_color, u.status_text,
		u.is_admin, u.is_active, u.must_change_pw, u.created_at, u.last_seen_at, u.avatar_sha`
	userColumnsBare = `id, email, display_name, avatar_color, status_text,
		is_admin, is_active, must_change_pw, created_at, last_seen_at, avatar_sha`
)

// scanUserRow reads a row selected with userColumns.
func scanUserRow(row pgx.Row, u *db.User) error {
	if err := row.Scan(&u.ID, &u.Email, &u.DisplayName, &u.AvatarColor, &u.StatusText,
		&u.IsAdmin, &u.IsActive, &u.MustChangePW, &u.CreatedAt, &u.LastSeenAt, &u.AvatarSHA); err != nil {
		return err
	}
	u.SetAvatarURL()
	return nil
}

// newToken returns n cryptographically random bytes, base64url encoded.
func newToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashToken is the one-way transform applied before a token touches the
// database, so a database leak cannot be replayed as a session.
func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// validatePassword enforces the documented password policy.
func validatePassword(pw string) error {
	if len(pw) < minPasswordLen {
		return httpx.BadRequest("Password must be at least 8 characters.")
	}
	if len(pw) > maxPasswordLen {
		return httpx.BadRequest("Password must be at most 256 characters.")
	}
	return nil
}

// hashPassword derives a storable hash. Thin wrapper so call sites read well.
func hashPassword(pw string) (string, error) {
	return password.Hash(pw)
}

func (s *Server) sessionTTL() time.Duration {
	if s.Cfg.SessionTTL <= 0 {
		return defaultSessTTL
	}
	return s.Cfg.SessionTTL
}

// createSession mints a token, stores only its hash, and returns the token.
func (s *Server) createSession(ctx context.Context, userID int64, userAgent string) (string, error) {
	token, err := newToken(32)
	if err != nil {
		return "", err
	}
	if len(userAgent) > 400 {
		userAgent = userAgent[:400]
	}
	_, err = s.DB.Pool.Exec(ctx,
		`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
		hashToken(token), userID, time.Now().Add(s.sessionTTL()), userAgent)
	if err != nil {
		return "", err
	}
	return token, nil
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.Cfg.SecureCookies,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(s.sessionTTL().Seconds()),
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   s.Cfg.SecureCookies,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

var errAccountDisabled = httpx.Errorf(http.StatusForbidden, "account_disabled",
	"This account has been deactivated.")

// lookupSession resolves an opaque session token to its user. Expired sessions
// and deactivated accounts are rejected; last_seen_at is refreshed at most once
// a minute so an idle tab does not write on every request.
func (s *Server) lookupSession(ctx context.Context, token string) (*db.User, error) {
	var u db.User
	var expiresAt time.Time
	row := s.DB.Pool.QueryRow(ctx,
		`SELECT `+userColumns+`, s.expires_at
		 FROM sessions s JOIN users u ON u.id = s.user_id
		 WHERE s.token_hash = $1`, hashToken(token))
	err := row.Scan(&u.ID, &u.Email, &u.DisplayName, &u.AvatarColor, &u.StatusText,
		&u.IsAdmin, &u.IsActive, &u.MustChangePW, &u.CreatedAt, &u.LastSeenAt, &u.AvatarSHA, &expiresAt)
	if err != nil {
		if isNoRows(err) {
			return nil, httpx.ErrUnauthorized
		}
		return nil, err
	}
	u.SetAvatarURL()
	if !expiresAt.After(time.Now()) {
		_, _ = s.DB.Pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, hashToken(token))
		return nil, httpx.ErrUnauthorized
	}
	if !u.IsActive {
		return nil, errAccountDisabled
	}

	if time.Since(u.LastSeenAt) > lastSeenRefresh {
		_, _ = s.DB.Pool.Exec(ctx,
			`UPDATE users SET last_seen_at = now()
			 WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, u.ID)
	}
	return &u, nil
}

// handleLogin verifies email+password, mints a session, and sets the cookie.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	in.Email = strings.TrimSpace(in.Email)
	if in.Email == "" || in.Password == "" {
		return httpx.BadRequest("Email and password are required.")
	}

	invalid := httpx.Errorf(http.StatusUnauthorized, "invalid_credentials",
		"That email and password do not match.")

	var u db.User
	var hash string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT `+userColumns+`, u.password_hash FROM users u
			 WHERE lower(u.email) = lower($1) AND NOT u.is_bot`, in.Email).
		Scan(&u.ID, &u.Email, &u.DisplayName, &u.AvatarColor, &u.StatusText,
			&u.IsAdmin, &u.IsActive, &u.MustChangePW, &u.CreatedAt, &u.LastSeenAt, &u.AvatarSHA, &hash)
	u.SetAvatarURL()
	if err != nil {
		if !isNoRows(err) {
			return err
		}
		// Spend the same work as a real comparison so timing cannot be used to
		// discover which addresses have accounts.
		_ = password.Verify(password.DummyHash, in.Password)
		return invalid
	}
	if !password.Verify(hash, in.Password) {
		return invalid
	}
	if !u.IsActive {
		return errAccountDisabled
	}

	// Opportunistic cleanup: an active user's dead sessions never pile up.
	_, _ = s.DB.Pool.Exec(r.Context(),
		`DELETE FROM sessions WHERE user_id = $1 AND expires_at < now()`, u.ID)

	token, err := s.createSession(r.Context(), u.ID, r.UserAgent())
	if err != nil {
		return err
	}
	s.setSessionCookie(w, token)

	_, _ = s.DB.Pool.Exec(r.Context(), `UPDATE users SET last_seen_at = now() WHERE id = $1`, u.ID)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"user":           u,
		"must_change_pw": u.MustChangePW,
	})
	return nil
}

// handleLogout deletes the current session row and clears the cookie.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) error {
	if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" {
		if _, err := s.DB.Pool.Exec(r.Context(),
			`DELETE FROM sessions WHERE token_hash = $1`, hashToken(c.Value)); err != nil {
			return err
		}
	}
	s.clearSessionCookie(w)
	httpx.NoContent(w)
	return nil
}

// handleMe returns the signed-in user, must_change_pw and push_public_key.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) error {
	u := currentUser(r)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"user":            u,
		"must_change_pw":  u.MustChangePW,
		"push_public_key": s.Pusher.PublicKey(),
	})
	return nil
}

// handleChangePassword verifies the current password and sets a new one,
// clearing must_change_pw and invalidating every other session.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if err := validatePassword(in.NewPassword); err != nil {
		return err
	}
	u := currentUser(r)

	var hash string
	if err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT password_hash FROM users WHERE id = $1`, u.ID).Scan(&hash); err != nil {
		return err
	}
	if !password.Verify(hash, in.CurrentPassword) {
		return httpx.Errorf(http.StatusForbidden, "invalid_credentials", "Your current password is incorrect.")
	}

	newHash, err := hashPassword(in.NewPassword)
	if err != nil {
		return err
	}
	if _, err := s.DB.Pool.Exec(r.Context(),
		`UPDATE users SET password_hash = $2, must_change_pw = FALSE WHERE id = $1`, u.ID, newHash); err != nil {
		return err
	}

	// Keep this session alive, drop every other one.
	current := []byte{}
	if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" {
		current = hashToken(c.Value)
	}
	if _, err := s.DB.Pool.Exec(r.Context(),
		`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, u.ID, current); err != nil {
		return err
	}

	httpx.NoContent(w)
	return nil
}

// handleForgotPassword mints a reset token and mails it. It always returns 204,
// and mails asynchronously, so neither the status nor the latency reveals
// whether the address has an account.
func (s *Server) handleForgotPassword(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email string `json:"email"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	in.Email = strings.TrimSpace(in.Email)
	if in.Email == "" {
		httpx.NoContent(w)
		return nil
	}

	var userID int64
	var email, name string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT id, email, display_name FROM users WHERE lower(email) = lower($1) AND is_active`, in.Email).
		Scan(&userID, &email, &name)
	if err != nil {
		if !isNoRows(err) {
			log.Printf("api: forgot password lookup: %v", err)
		}
		httpx.NoContent(w)
		return nil
	}

	token, err := newToken(32)
	if err != nil {
		return err
	}
	if _, err := s.DB.Pool.Exec(r.Context(),
		`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
		hashToken(token), userID, time.Now().Add(resetTokenTTL)); err != nil {
		return err
	}

	resetURL := s.Cfg.BaseURL + "/reset.html?token=" + token
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.Mailer.SendPasswordReset(ctx, email, name, resetURL); err != nil {
			log.Printf("api: send password reset to %s: %v", email, err)
		}
	}()

	httpx.NoContent(w)
	return nil
}

// handleResetPassword consumes a reset token and sets the new password.
func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Token       string `json:"token"`
		NewPassword string `json:"new_password"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Token == "" {
		return httpx.BadRequest("This reset link is invalid or has expired.")
	}
	if err := validatePassword(in.NewPassword); err != nil {
		return err
	}

	newHash, err := hashPassword(in.NewPassword)
	if err != nil {
		return err
	}

	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())

	// Claiming the row inside the transaction makes a token single-use even if
	// two requests arrive at once.
	var userID int64
	err = tx.QueryRow(r.Context(),
		`UPDATE password_resets SET used_at = now()
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		 RETURNING user_id`, hashToken(in.Token)).Scan(&userID)
	if err != nil {
		if isNoRows(err) {
			return httpx.BadRequest("This reset link is invalid or has expired.")
		}
		return err
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE users SET password_hash = $2, must_change_pw = FALSE WHERE id = $1`, userID, newHash); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM sessions WHERE user_id = $1`, userID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}

	s.clearSessionCookie(w)
	httpx.NoContent(w)
	return nil
}
