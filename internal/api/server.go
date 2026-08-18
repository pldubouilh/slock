// Package api holds the HTTP surface of slock: routing, auth middleware, and
// every JSON handler.
package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/mail"
	"slock/internal/media"
	"slock/internal/push"
	"slock/internal/realtime"
)

// Config is the runtime configuration, assembled from the environment in main.
type Config struct {
	Addr           string
	BaseURL        string // e.g. https://slock.example.com, used in emails
	DataDir        string
	MaxUploadBytes int64
	SessionTTL     time.Duration
	SecureCookies  bool
	DevWebDir      string // when set, static assets are read from disk instead of the embedded FS
}

// Server carries every dependency the handlers need.
type Server struct {
	Cfg    Config
	DB     *db.DB
	Hub    *realtime.Hub
	Media  *media.Store
	Mailer *mail.Mailer
	Pusher *push.Pusher
}

func New(cfg Config, database *db.DB, hub *realtime.Hub, m *media.Store, mailer *mail.Mailer, pusher *push.Pusher) *Server {
	return &Server{Cfg: cfg, DB: database, Hub: hub, Media: m, Mailer: mailer, Pusher: pusher}
}

// handler is the internal handler shape: return an error and the middleware
// renders it. Return an *httpx.Error for anything client-facing.
type handler func(w http.ResponseWriter, r *http.Request) error

// Routes builds the mux. Every handler method referenced here lives in one of
// the sibling files in this package.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// -- auth ------------------------------------------------------------
	mux.HandleFunc("POST /api/auth/login", s.open(s.handleLogin))
	mux.HandleFunc("POST /api/auth/logout", s.auth(s.handleLogout))
	mux.HandleFunc("GET /api/auth/me", s.auth(s.handleMe))
	mux.HandleFunc("POST /api/auth/password", s.auth(s.handleChangePassword))
	mux.HandleFunc("POST /api/auth/forgot", s.open(s.handleForgotPassword))
	mux.HandleFunc("POST /api/auth/reset", s.open(s.handleResetPassword))

	// -- workspace identity ----------------------------------------------
	// Unauthenticated: the sign-in page brands itself before anyone is in.
	mux.HandleFunc("GET /api/version", s.open(s.handleVersion))
	// Ahead of the static handler: the manifest is rendered with the
	// workspace name so an installed PWA carries it.
	mux.HandleFunc("GET /manifest.webmanifest", s.open(s.handleManifest))
	mux.HandleFunc("GET /api/workspace", s.open(s.handleGetWorkspace))
	mux.HandleFunc("GET /api/workspace/icon", s.open(s.handleGetWorkspaceIcon))
	mux.HandleFunc("PATCH /api/admin/workspace", s.admin(s.handleUpdateWorkspace))
	mux.HandleFunc("POST /api/admin/workspace/icon", s.admin(s.handleUploadWorkspaceIcon))
	mux.HandleFunc("DELETE /api/admin/workspace/icon", s.admin(s.handleDeleteWorkspaceIcon))

	// -- users -----------------------------------------------------------
	mux.HandleFunc("GET /api/users", s.auth(s.handleListUsers))
	mux.HandleFunc("PATCH /api/users/me", s.auth(s.handleUpdateMe))
	mux.HandleFunc("POST /api/users/me/avatar", s.auth(s.handleUploadAvatar))
	mux.HandleFunc("DELETE /api/users/me/avatar", s.auth(s.handleDeleteAvatar))
	mux.HandleFunc("GET /api/users/{id}/avatar", s.auth(s.handleGetAvatar))

	// -- channels & DMs --------------------------------------------------
	mux.HandleFunc("GET /api/channels", s.auth(s.handleListChannels))
	mux.HandleFunc("POST /api/channels", s.auth(s.handleCreateChannel))
	mux.HandleFunc("GET /api/channels/{id}", s.auth(s.handleGetChannel))
	mux.HandleFunc("PATCH /api/channels/{id}", s.auth(s.handleUpdateChannel))
	mux.HandleFunc("POST /api/channels/{id}/join", s.auth(s.handleJoinChannel))
	mux.HandleFunc("POST /api/channels/{id}/leave", s.auth(s.handleLeaveChannel))
	mux.HandleFunc("POST /api/channels/{id}/members", s.auth(s.handleAddMember))
	mux.HandleFunc("DELETE /api/channels/{id}/members/{userID}", s.auth(s.handleRemoveMember))
	mux.HandleFunc("POST /api/channels/{id}/read", s.auth(s.handleMarkRead))
	mux.HandleFunc("POST /api/channels/{id}/mute", s.auth(s.handleSetMute))
	mux.HandleFunc("POST /api/channels/{id}/typing", s.auth(s.handleTyping))
	mux.HandleFunc("POST /api/dms", s.auth(s.handleOpenDM))

	// -- messages --------------------------------------------------------
	mux.HandleFunc("GET /api/channels/{id}/messages", s.auth(s.handleListMessages))
	mux.HandleFunc("GET /api/channels/{id}/attachments", s.auth(s.handleListChannelAttachments))
	mux.HandleFunc("POST /api/channels/{id}/messages", s.auth(s.handleCreateMessage))
	mux.HandleFunc("PATCH /api/messages/{id}", s.auth(s.handleUpdateMessage))
	mux.HandleFunc("DELETE /api/messages/{id}", s.auth(s.handleDeleteMessage))
	mux.HandleFunc("PUT /api/messages/{id}/reactions/{emoji}", s.auth(s.handleAddReaction))
	mux.HandleFunc("DELETE /api/messages/{id}/reactions/{emoji}", s.auth(s.handleRemoveReaction))

	// -- files -----------------------------------------------------------
	mux.HandleFunc("POST /api/uploads", s.auth(s.handleUpload))
	mux.HandleFunc("GET /api/files/{id}/{variant}/{filename}", s.auth(s.handleDownload))

	// -- search ----------------------------------------------------------
	mux.HandleFunc("GET /api/search", s.auth(s.handleSearch))

	// -- realtime --------------------------------------------------------
	mux.HandleFunc("GET /api/events", s.auth(s.handleEvents))
	mux.HandleFunc("POST /api/events/visible", s.auth(s.handleEventsVisible))

	// -- web push --------------------------------------------------------
	mux.HandleFunc("GET /api/push/key", s.auth(s.handlePushKey))
	mux.HandleFunc("POST /api/push/subscribe", s.auth(s.handlePushSubscribe))
	mux.HandleFunc("POST /api/push/unsubscribe", s.auth(s.handlePushUnsubscribe))

	// -- admin -----------------------------------------------------------
	mux.HandleFunc("GET /api/admin/users", s.admin(s.handleAdminListUsers))
	mux.HandleFunc("POST /api/admin/users", s.admin(s.handleAdminCreateUser))
	mux.HandleFunc("PATCH /api/admin/users/{id}", s.admin(s.handleAdminUpdateUser))
	mux.HandleFunc("POST /api/admin/users/{id}/reset-password", s.admin(s.handleAdminResetPassword))
	mux.HandleFunc("GET /api/admin/tokens", s.admin(s.handleAdminListTokens))
	mux.HandleFunc("POST /api/admin/tokens", s.admin(s.handleAdminCreateToken))
	mux.HandleFunc("PATCH /api/admin/tokens/{id}", s.admin(s.handleAdminUpdateToken))
	mux.HandleFunc("DELETE /api/admin/tokens/{id}", s.admin(s.handleAdminDeleteToken))

	// -- external send API -----------------------------------------------
	// Token in a header, message in the body or ?msg=. Plain text in, plain
	// text out; no session, no JSON.
	mux.HandleFunc("POST /api/send/{target}", s.open(s.handleSend))
	mux.HandleFunc("GET /api/send/{target}", s.open(s.handleSend))

	// -- static ----------------------------------------------------------
	mux.HandleFunc("GET /", s.handleStatic)

	return securityHeaders(mux)
}

// ---------------------------------------------------------------------------
// middleware
// ---------------------------------------------------------------------------

type ctxKey int

const userCtxKey ctxKey = 1

// SessionCookie is the cookie name holding the opaque session token.
const SessionCookie = "slock_session"

// open runs a handler with no authentication.
func (s *Server) open(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			httpx.Fail(w, r, err)
		}
	}
}

// auth requires a valid session and puts the user in the request context.
func (s *Server) auth(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, err := s.userFromRequest(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		ctx := context.WithValue(r.Context(), userCtxKey, user)
		if err := h(w, r.WithContext(ctx)); err != nil {
			httpx.Fail(w, r, err)
		}
	}
}

// admin requires a valid session belonging to an admin.
func (s *Server) admin(h handler) http.HandlerFunc {
	return s.auth(func(w http.ResponseWriter, r *http.Request) error {
		if !currentUser(r).IsAdmin {
			return httpx.ErrForbidden
		}
		return h(w, r)
	})
}

// userFromRequest resolves the session cookie. Implemented in auth.go.
func (s *Server) userFromRequest(r *http.Request) (*db.User, error) {
	c, err := r.Cookie(SessionCookie)
	if err != nil || c.Value == "" {
		return nil, httpx.ErrUnauthorized
	}
	user, err := s.lookupSession(r.Context(), c.Value)
	if err != nil {
		return nil, err
	}
	return user, nil
}

// currentUser returns the authenticated user. Only valid inside auth/admin handlers.
func currentUser(r *http.Request) *db.User {
	u, _ := r.Context().Value(userCtxKey).(*db.User)
	return u
}

// securityHeaders applies a strict, dependency-free CSP. Everything the client
// needs is same-origin, so no external sources are allowed.
func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
		"style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
		"frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// shared queries used across handler files
// ---------------------------------------------------------------------------

// channelMemberIDs lists every member of a channel.
func (s *Server) channelMemberIDs(ctx context.Context, channelID int64) ([]int64, error) {
	rows, err := s.DB.Pool.Query(ctx,
		`SELECT user_id FROM channel_members WHERE channel_id = $1`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// isMember reports whether a user belongs to a channel.
func (s *Server) isMember(ctx context.Context, channelID, userID int64) (bool, error) {
	var exists bool
	err := s.DB.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
		channelID, userID).Scan(&exists)
	return exists, err
}

// requireMembership returns ErrForbidden unless the user is in the channel.
// Public channels are readable by anyone signed in; private channels and DMs
// require membership.
func (s *Server) requireMembership(ctx context.Context, channelID, userID int64) error {
	var kind string
	var private bool
	err := s.DB.Pool.QueryRow(ctx,
		`SELECT kind, is_private FROM channels WHERE id = $1`, channelID).Scan(&kind, &private)
	if err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}
	if kind == db.KindChannel && !private {
		return nil
	}
	member, err := s.isMember(ctx, channelID, userID)
	if err != nil {
		return err
	}
	if !member {
		return httpx.ErrForbidden
	}
	return nil
}

// publishToChannel fans an event out to every member of a channel. Pass
// exclude > 0 to skip the originating user.
func (s *Server) publishToChannel(ctx context.Context, channelID int64, ev realtime.Event, exclude int64) {
	ids, err := s.channelMemberIDs(ctx, channelID)
	if err != nil {
		return
	}
	if exclude > 0 {
		filtered := ids[:0]
		for _, id := range ids {
			if id != exclude {
				filtered = append(filtered, id)
			}
		}
		ids = filtered
	}
	s.Hub.PublishUsers(ids, ev)
}

// isNoRows reports whether err is pgx's "no rows" sentinel.
func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
