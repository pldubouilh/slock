package api

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/realtime"
)

// tokenPrefix marks a slock API token on sight, so one pasted into a log or a
// chat message is recognisable (and greppable in a secret scanner).
const tokenPrefix = "slk_"

// maxSendBody bounds the message an external caller may post. Well under the
// 8000-rune message limit, which this then re-checks anyway.
const maxSendBody = 64 << 10

// APIToken is the wire form of a token. The secret itself is only ever
// returned once, at creation.
type APIToken struct {
	ID         int64      `json:"id"`
	Name       string     `json:"name"`
	Scope      string     `json:"scope"`
	IsActive   bool       `json:"is_active"`
	UserID     int64      `json:"user_id"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
}

const apiTokenColumns = `t.id, t.name, t.scope, t.is_active, t.user_id, t.created_at, t.last_used_at`

func scanAPIToken(row interface{ Scan(...any) error }) (APIToken, error) {
	var t APIToken
	err := row.Scan(&t.ID, &t.Name, &t.Scope, &t.IsActive, &t.UserID, &t.CreatedAt, &t.LastUsedAt)
	return t, err
}

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

// scopeEntry is one permitted destination.
type scopeEntry struct {
	IsDM bool   // "@bob" rather than "#eng"
	Name string // lowercased, without the sigil
}

// parseScope reads an admin-written scope string. "*" (or empty) means
// anywhere. Otherwise entries are separated by commas or whitespace, each
// "#channel" or "@user"; a bare word is treated as a channel, which is the
// forgiving reading of "eng, @bob".
func parseScope(spec string) (all bool, entries []scopeEntry) {
	spec = strings.TrimSpace(spec)
	if spec == "" || spec == "*" {
		return true, nil
	}
	for _, field := range strings.FieldsFunc(spec, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	}) {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		if field == "*" {
			return true, nil
		}
		switch field[0] {
		case '@':
			if name := strings.ToLower(field[1:]); name != "" {
				entries = append(entries, scopeEntry{IsDM: true, Name: name})
			}
		case '#':
			if name := strings.ToLower(field[1:]); name != "" {
				entries = append(entries, scopeEntry{Name: name})
			}
		default:
			entries = append(entries, scopeEntry{Name: strings.ToLower(field)})
		}
	}
	return false, entries
}

// scopeAllows reports whether a scope permits posting to a target.
func scopeAllows(spec string, isDM bool, name string) bool {
	all, entries := parseScope(spec)
	if all {
		return true
	}
	name = strings.ToLower(name)
	for _, e := range entries {
		if e.IsDM == isDM && e.Name == name {
			return true
		}
	}
	return false
}

// normalizeScope tidies what an admin typed into a canonical stored form, so
// the admin UI shows back something consistent.
func normalizeScope(spec string) string {
	all, entries := parseScope(spec)
	if all {
		return "*"
	}
	if len(entries) == 0 {
		return "*"
	}
	parts := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDM {
			parts = append(parts, "@"+e.Name)
		} else {
			parts = append(parts, "#"+e.Name)
		}
	}
	return strings.Join(parts, ", ")
}

// ---------------------------------------------------------------------------
// admin endpoints
// ---------------------------------------------------------------------------

// handleAdminListTokens lists every API token. Secrets are not stored, so none
// can be shown again after creation.
func (s *Server) handleAdminListTokens(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.DB.Pool.Query(r.Context(),
		`SELECT `+apiTokenColumns+` FROM api_tokens t ORDER BY t.created_at DESC, t.id DESC`)
	if err != nil {
		return err
	}
	defer rows.Close()

	tokens := []APIToken{}
	for rows.Next() {
		t, err := scanAPIToken(rows)
		if err != nil {
			return err
		}
		tokens = append(tokens, t)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"tokens": tokens})
	return nil
}

// handleAdminCreateToken mints a token and the bot account it posts as. The
// secret is returned exactly once.
func (s *Server) handleAdminCreateToken(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Name  string `json:"name"`
		Scope string `json:"scope"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > maxDisplayNameLen {
		return httpx.BadRequest("Name must be 1 to 60 characters.")
	}
	scope := normalizeScope(in.Scope)

	secret, err := newToken(32)
	if err != nil {
		return err
	}
	secret = tokenPrefix + secret

	ctx := r.Context()
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// The bot identity. It carries an unusable password hash and is_bot, so no
	// password can ever authenticate it.
	suffix, err := newToken(6)
	if err != nil {
		return err
	}
	var botID int64
	err = tx.QueryRow(ctx,
		`INSERT INTO users (email, display_name, password_hash, avatar_color, is_bot, is_active)
		 VALUES ($1, $2, '!', $3, TRUE, TRUE) RETURNING id`,
		"bot-"+strings.ToLower(suffix)+"@bots.invalid", name, avatarColorFor(name)).Scan(&botID)
	if err != nil {
		return err
	}

	var t APIToken
	row := tx.QueryRow(ctx,
		`INSERT INTO api_tokens (name, token_hash, user_id, created_by, scope)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, name, scope, is_active, user_id, created_at, last_used_at`,
		name, hashToken(secret), botID, currentUser(r).ID, scope)
	if t, err = scanAPIToken(row); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	// Everyone's client caches users by id; without this the bot's first
	// message renders as an unknown author until a reload.
	s.publishBotUser(context.WithoutCancel(ctx), botID)

	httpx.JSON(w, http.StatusCreated, map[string]any{"api_token": t, "token": secret})
	return nil
}

// handleAdminUpdateToken renames a token, re-scopes it, or disables it.
func (s *Server) handleAdminUpdateToken(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Name     *string `json:"name"`
		Scope    *string `json:"scope"`
		IsActive *bool   `json:"is_active"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Name == nil && in.Scope == nil && in.IsActive == nil {
		return httpx.BadRequest("Nothing to update.")
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if name == "" || utf8.RuneCountInString(name) > maxDisplayNameLen {
			return httpx.BadRequest("Name must be 1 to 60 characters.")
		}
		in.Name = &name
	}
	if in.Scope != nil {
		scope := normalizeScope(*in.Scope)
		in.Scope = &scope
	}

	ctx := r.Context()
	var t APIToken
	row := s.DB.Pool.QueryRow(ctx,
		`UPDATE api_tokens SET
		    name      = COALESCE($2::text, name),
		    scope     = COALESCE($3::text, scope),
		    is_active = COALESCE($4::boolean, is_active)
		  WHERE id = $1
		  RETURNING id, name, scope, is_active, user_id, created_at, last_used_at`,
		id, in.Name, in.Scope, in.IsActive)
	if t, err = scanAPIToken(row); err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}

	// Renaming the token renames the bot it posts as, so history stays coherent.
	if in.Name != nil {
		if _, err := s.DB.Pool.Exec(ctx,
			`UPDATE users SET display_name = $2 WHERE id = $1`, t.UserID, *in.Name); err != nil {
			return err
		}
		s.publishBotUser(context.WithoutCancel(ctx), t.UserID)
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"api_token": t})
	return nil
}

// handleAdminDeleteToken revokes a token. The bot account and its messages
// stay: deleting the user would erase history it wrote.
func (s *Server) handleAdminDeleteToken(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	tag, err := s.DB.Pool.Exec(r.Context(), `DELETE FROM api_tokens WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.ErrNotFound
	}
	httpx.NoContent(w)
	return nil
}

// publishBotUser tells connected clients about a bot account so its name and
// colour resolve immediately.
func (s *Server) publishBotUser(ctx context.Context, userID int64) {
	var u db.User
	row := s.DB.Pool.QueryRow(ctx, `SELECT `+publicUserColumns+` FROM users u WHERE u.id = $1`, userID)
	if err := scanPublicUserRow(row, &u); err != nil {
		return
	}
	s.Hub.PublishAll(realtime.Event{Type: "user.update", Data: map[string]any{"user": u}})
}

// ---------------------------------------------------------------------------
// the external send endpoint
// ---------------------------------------------------------------------------

// sendError writes a plain-text error. The send API answers in text, not JSON,
// so `curl` output is readable without a parser.
func sendError(w http.ResponseWriter, status int, format string, args ...any) error {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprintf(w, format+"\n", args...)
	return nil
}

// bearerToken pulls the secret from the request. A header keeps it out of
// access logs and browser history, which a query parameter would not.
func bearerToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if v, ok := strings.CutPrefix(h, "Bearer "); ok {
			return strings.TrimSpace(v)
		}
		if v, ok := strings.CutPrefix(h, "bearer "); ok {
			return strings.TrimSpace(v)
		}
		return strings.TrimSpace(h)
	}
	return strings.TrimSpace(r.Header.Get("X-Auth-Token"))
}

// handleSend posts a message on behalf of an API token:
//
//	curl -H "Authorization: Bearer slk_..." -d 'the build is green' \
//	     https://slock.example.com/api/send/releases
//
// The target is "#channel" or "@user" (the sigil is optional for channels).
// The body is the message; ?msg= works too for the one-liner case.
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) error {
	secret := bearerToken(r)
	if secret == "" {
		return sendError(w, http.StatusUnauthorized,
			"no token: pass -H 'Authorization: Bearer slk_...'")
	}

	ctx := r.Context()
	var (
		tokenID  int64
		botID    int64
		scope    string
		isActive bool
	)
	err := s.DB.Pool.QueryRow(ctx,
		`SELECT id, user_id, scope, is_active FROM api_tokens WHERE token_hash = $1`,
		hashToken(secret)).Scan(&tokenID, &botID, &scope, &isActive)
	if err != nil {
		if isNoRows(err) {
			return sendError(w, http.StatusUnauthorized, "invalid token")
		}
		return err
	}
	if !isActive {
		return sendError(w, http.StatusForbidden, "token is disabled")
	}

	target := strings.TrimSpace(r.PathValue("target"))
	if decoded, derr := url.PathUnescape(target); derr == nil {
		target = decoded
	}
	if target == "" {
		return sendError(w, http.StatusBadRequest,
			"no target: use /api/send/<channel> or /api/send/@<user>")
	}

	body, err := sendMessageText(r)
	if err != nil {
		return sendError(w, http.StatusBadRequest, "%s", err.Error())
	}
	if strings.TrimSpace(body) == "" {
		return sendError(w, http.StatusBadRequest,
			"empty message: put it in the request body, or use ?msg=...")
	}
	if utf8.RuneCountInString(body) > maxBodyRunes {
		return sendError(w, http.StatusBadRequest, "message is too long (max %d characters)", maxBodyRunes)
	}

	channel, errMsg, status := s.resolveSendTarget(ctx, target, botID, scope)
	if errMsg != "" {
		return sendError(w, status, "%s", errMsg)
	}

	msg, err := s.postAsBot(ctx, channel, botID, body)
	if err != nil {
		return err
	}

	if _, err := s.DB.Pool.Exec(ctx,
		`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, tokenID); err != nil {
		log.Printf("api: stamp token %d: %v", tokenID, err)
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, "ok %d\n", msg.ID)
	return nil
}

// sendMessageText reads the message: the request body if there is one,
// otherwise ?msg=. Both arrive already percent-decoded by net/http.
func sendMessageText(r *http.Request) (string, error) {
	if q := r.URL.Query().Get("msg"); q != "" {
		return q, nil
	}
	if r.Body == nil {
		return "", nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxSendBody+1))
	if err != nil {
		return "", fmt.Errorf("could not read the request body")
	}
	if len(raw) > maxSendBody {
		return "", fmt.Errorf("message is too large")
	}
	text := string(raw)

	// A form post (curl --data-urlencode 'msg=...') arrives as msg=<encoded>.
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		if vals, err := url.ParseQuery(text); err == nil {
			if v := vals.Get("msg"); v != "" {
				return v, nil
			}
		}
	}
	return text, nil
}

// resolveSendTarget turns "#eng" or "@bob" into a channel the bot may post to,
// creating the DM if needed. Returns a human error and status when it cannot.
func (s *Server) resolveSendTarget(ctx context.Context, target string, botID int64, scope string) (*channelBasics, string, int) {
	if strings.HasPrefix(target, "@") {
		name := strings.TrimPrefix(target, "@")
		if !scopeAllows(scope, true, name) {
			return nil, fmt.Sprintf("this token may not post to @%s (scope: %s)", name, scope), http.StatusForbidden
		}
		var peerID int64
		var active bool
		err := s.DB.Pool.QueryRow(ctx,
			`SELECT id, is_active FROM users WHERE lower(display_name) = lower($1) AND NOT is_bot
			  ORDER BY id LIMIT 1`, name).Scan(&peerID, &active)
		if err != nil {
			if isNoRows(err) {
				return nil, fmt.Sprintf("no such user: @%s", name), http.StatusNotFound
			}
			return nil, "could not look up that user", http.StatusInternalServerError
		}
		if !active {
			return nil, fmt.Sprintf("@%s is deactivated", name), http.StatusForbidden
		}
		ch, err := s.getOrCreateDM(ctx, botID, peerID)
		if err != nil {
			return nil, "could not open that conversation", http.StatusInternalServerError
		}
		return ch, "", 0
	}

	name := strings.TrimPrefix(target, "#")
	if !scopeAllows(scope, false, name) {
		return nil, fmt.Sprintf("this token may not post to #%s (scope: %s)", name, scope), http.StatusForbidden
	}
	var b channelBasics
	err := s.DB.Pool.QueryRow(ctx,
		`SELECT id, kind, name, is_private, created_by FROM channels
		  WHERE kind = 'channel' AND lower(name) = lower($1)`, name).
		Scan(&b.ID, &b.Kind, &b.Name, &b.IsPrivate, &b.CreatedBy)
	if err != nil {
		if isNoRows(err) {
			return nil, fmt.Sprintf("no such channel: #%s", name), http.StatusNotFound
		}
		return nil, "could not look up that channel", http.StatusInternalServerError
	}

	if b.IsPrivate {
		member, err := s.isMember(ctx, b.ID, botID)
		if err != nil {
			return nil, "could not check channel membership", http.StatusInternalServerError
		}
		if !member {
			return nil, fmt.Sprintf("#%s is private: add this token's user to it first", b.Name),
				http.StatusForbidden
		}
	}
	return &b, "", 0
}

// getOrCreateDM finds or creates the 1:1 channel between two users.
func (s *Server) getOrCreateDM(ctx context.Context, a, b int64) (*channelBasics, error) {
	key := dmKey(a, b)
	if _, err := s.DB.Pool.Exec(ctx,
		`INSERT INTO channels (kind, name, dm_key, created_by) VALUES ('dm', '', $1, $2)
		 ON CONFLICT (dm_key) WHERE dm_key IS NOT NULL DO NOTHING`, key, a); err != nil {
		return nil, err
	}
	var id int64
	if err := s.DB.Pool.QueryRow(ctx, `SELECT id FROM channels WHERE dm_key = $1`, key).Scan(&id); err != nil {
		return nil, err
	}
	members := []int64{a}
	if a != b {
		members = append(members, b)
	}
	for _, uid := range members {
		if _, err := s.DB.Pool.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			id, uid); err != nil {
			return nil, err
		}
	}
	return &channelBasics{ID: id, Kind: db.KindDM}, nil
}

// postAsBot inserts the message and fans it out exactly like a human send, so
// an API message is indistinguishable downstream: realtime, unread counts and
// push all behave the same.
func (s *Server) postAsBot(ctx context.Context, ch *channelBasics, botID int64, body string) (*db.Message, error) {
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		ch.ID, botID); err != nil {
		return nil, err
	}

	var m db.Message
	err = tx.QueryRow(ctx,
		`INSERT INTO messages (channel_id, user_id, body) VALUES ($1, $2, $3)
		 RETURNING id, channel_id, user_id, body, created_at, edited_at, deleted_at`,
		ch.ID, botID, body).
		Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Body, &m.CreatedAt, &m.EditedAt, &m.DeletedAt)
	if err != nil {
		return nil, err
	}
	m.Attachments = []db.Attachment{}
	m.Reactions = []db.Reaction{}

	if _, err := tx.Exec(ctx,
		`UPDATE channels SET last_message_at = now() WHERE id = $1`, ch.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	full, err := s.loadChannel(ctx, ch.ID, botID)
	if err != nil {
		return &m, nil // the message is in; fan-out is best effort
	}
	var author db.User
	row := s.DB.Pool.QueryRow(ctx, `SELECT `+publicUserColumns+` FROM users u WHERE u.id = $1`, botID)
	if err := scanPublicUserRow(row, &author); err != nil {
		return &m, nil
	}

	s.publishToChannel(ctx, ch.ID, realtime.Event{Type: "message.new", Data: map[string]any{
		"message": m,
		"channel": map[string]any{"id": full.ID, "kind": full.Kind, "name": full.Name},
		"user":    map[string]any{"id": author.ID, "display_name": author.DisplayName},
	}}, 0)

	go s.notifyNewMessage(context.Background(), &m, full, &author)
	return &m, nil
}
