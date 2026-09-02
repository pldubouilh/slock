package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/push"
)

const (
	maxEndpointLen  = 2000
	pushBodyRunes   = 120
	pushSendTimeout = 15 * time.Second

	// pushGrace is how long a push is held for a recipient who is connected
	// somewhere but not looking: they are probably at a desk and about to read
	// the message there, and a push cannot be retracted once sent. Recipients
	// with no connection at all get theirs immediately.
	pushGrace = 5 * time.Minute
)

// handlePushKey returns the VAPID public key ("" when push is not configured).
func (s *Server) handlePushKey(w http.ResponseWriter, r *http.Request) error {
	httpx.JSON(w, http.StatusOK, map[string]any{"public_key": s.Pusher.PublicKey()})
	return nil
}

// handlePushSubscribe upserts a browser push subscription for the caller. The
// endpoint is the identity: re-subscribing the same browser rebinds it rather
// than piling up rows.
func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256DH string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
		// Accepted and ignored so a client can post a serialised
		// PushSubscription verbatim; the decoder rejects unknown fields.
		ExpirationTime any `json:"expirationTime"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	in.Endpoint = strings.TrimSpace(in.Endpoint)
	if !validPushEndpoint(in.Endpoint) {
		return httpx.BadRequest("Invalid push endpoint.")
	}
	if in.Keys.P256DH == "" || in.Keys.Auth == "" {
		return httpx.BadRequest("Missing push subscription keys.")
	}

	if _, err := s.DB.Pool.Exec(r.Context(),
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (endpoint) DO UPDATE
		   SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
		       auth = EXCLUDED.auth, failed_at = NULL`,
		currentUser(r).ID, in.Endpoint, in.Keys.P256DH, in.Keys.Auth); err != nil {
		return err
	}

	httpx.NoContent(w)
	return nil
}

// handlePushUnsubscribe deletes a subscription by endpoint.
func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Endpoint string `json:"endpoint"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Endpoint == "" {
		return httpx.BadRequest("Missing push endpoint.")
	}
	if _, err := s.DB.Pool.Exec(r.Context(),
		`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`,
		in.Endpoint, currentUser(r).ID); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

func validPushEndpoint(endpoint string) bool {
	return strings.HasPrefix(endpoint, "https://") && len(endpoint) <= maxEndpointLen
}

// notifyNewMessage sends web push for a new message to every channel member who
// has no visible tab (per Hub.HasVisible), is not the author, and has not muted
// the channel. Merely being connected is not enough to suppress push: a
// backgrounded tab keeps its SSE stream open, and skipping "online" users meant
// one forgotten desktop tab silenced every device — but it is enough to buy a
// grace period (pushGrace) in which reading the message anywhere cancels the
// push. It runs on its own background context because the request that
// triggered it is already finished.
func (s *Server) notifyNewMessage(_ context.Context, msg *db.Message, ch *db.Channel, author *db.User) {
	if !s.Pusher.Enabled() || msg == nil || ch == nil || author == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), pushSendTimeout)
	defer cancel()

	rows, err := s.DB.Pool.Query(ctx,
		`SELECT user_id FROM channel_members
		 WHERE channel_id = $1 AND user_id <> $2 AND NOT muted`, ch.ID, msg.UserID)
	if err != nil {
		log.Printf("api: push recipients for channel %d: %v", ch.ID, err)
		return
	}
	var recipients []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			log.Printf("api: push recipients for channel %d: %v", ch.ID, err)
			return
		}
		if !s.Hub.HasVisible(id) {
			recipients = append(recipients, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Printf("api: push recipients for channel %d: %v", ch.ID, err)
		return
	}
	if len(recipients) == 0 {
		return
	}

	title, body := pushText(msg, ch, author)
	channelID := strconv.FormatInt(ch.ID, 10)
	for _, uid := range recipients {
		n := push.Notification{
			Title:     title,
			Body:      body,
			Tag:       "channel-" + channelID,
			URL:       "/?c=" + channelID,
			ChannelID: ch.ID,
		}
		// Connected somewhere (a hidden tab, a locked phone with the PWA
		// open): they are likely about to read this where they are, and a
		// sent push cannot be taken back. Hold it; deliverPending re-checks
		// before it fires. No connection at all: send now.
		if s.Hub.IsOnline(uid) {
			s.pending.hold(uid, ch.ID, msg.ID, n, pushGrace, s.deliverPending)
		} else {
			n.Badge = s.unreadTotal(ctx, uid)
			s.pushToUser(ctx, uid, n)
		}
	}
}

// deliverPending fires when a held push's grace expires: it drops the push if
// the recipient has read the channel past the message in the meantime (on any
// device), or is now actively looking at slock; otherwise it sends.
func (s *Server) deliverPending(userID, channelID, msgID int64, n push.Notification) {
	if s.Hub.HasVisible(userID) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), pushSendTimeout)
	defer cancel()
	var lastRead int64
	err := s.DB.Pool.QueryRow(ctx,
		`SELECT last_read_message_id FROM channel_members
		  WHERE channel_id = $1 AND user_id = $2`, channelID, userID).Scan(&lastRead)
	if err != nil {
		// Not a member any more: the push is moot. Any other failure: deliver
		// anyway — a duplicate-ish notification beats a silently dropped one.
		if isNoRows(err) {
			return
		}
		log.Printf("api: pending push read check for user %d: %v", userID, err)
	}
	if lastRead >= msgID {
		return
	}
	n.Badge = s.unreadTotal(ctx, userID)
	s.pushToUser(ctx, userID, n)
}

// pendingPushes holds one delayed push per (user, channel). A newer message in
// the same channel replaces the payload but keeps the original deadline, so a
// busy channel cannot defer its notification forever; the newest body winning
// mirrors what the Topic header does inside the push service's own queue.
type pendingPushes struct {
	mu sync.Mutex
	m  map[[2]int64]*pendingPush
}

type pendingPush struct {
	msgID int64
	n     push.Notification
	timer *time.Timer
}

func (p *pendingPushes) hold(userID, channelID, msgID int64, n push.Notification,
	grace time.Duration, deliver func(userID, channelID, msgID int64, n push.Notification)) {
	key := [2]int64{userID, channelID}
	p.mu.Lock()
	defer p.mu.Unlock()
	if pp, ok := p.m[key]; ok {
		pp.msgID = msgID
		pp.n = n
		return
	}
	if p.m == nil {
		p.m = make(map[[2]int64]*pendingPush)
	}
	pp := &pendingPush{msgID: msgID, n: n}
	pp.timer = time.AfterFunc(grace, func() {
		p.mu.Lock()
		delete(p.m, key)
		msgID, n := pp.msgID, pp.n
		p.mu.Unlock()
		deliver(userID, channelID, msgID, n)
	})
	p.m[key] = pp
}

// pushToUser delivers n to every browser the user has registered, dropping
// subscriptions the push service reports as gone.
func (s *Server) pushToUser(ctx context.Context, userID int64, n push.Notification) {
	rows, err := s.DB.Pool.Query(ctx,
		`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, userID)
	if err != nil {
		log.Printf("api: load push subscriptions for user %d: %v", userID, err)
		return
	}
	type sub struct {
		id int64
		s  push.Subscription
	}
	var subs []sub
	for rows.Next() {
		var v sub
		if err := rows.Scan(&v.id, &v.s.Endpoint, &v.s.P256DH, &v.s.Auth); err != nil {
			rows.Close()
			log.Printf("api: load push subscriptions for user %d: %v", userID, err)
			return
		}
		subs = append(subs, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Printf("api: load push subscriptions for user %d: %v", userID, err)
		return
	}

	for _, v := range subs {
		err := s.Pusher.Send(ctx, v.s, n)
		switch {
		case err == nil:
		case errors.Is(err, push.ErrGone):
			_, _ = s.DB.Pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, v.id)
		default:
			log.Printf("api: web push to user %d: %v", userID, err)
			_, _ = s.DB.Pool.Exec(ctx, `UPDATE push_subscriptions SET failed_at = now() WHERE id = $1`, v.id)
		}
	}
}

// unreadTotal counts a user's unread messages across every channel they are in;
// it is the number the PWA shows on the app badge.
func (s *Server) unreadTotal(ctx context.Context, userID int64) int {
	var n int
	// Bounded per channel, exactly like the channel list: this runs once per
	// offline recipient of every message, so an unbounded count here costs a
	// full scan of history per push and is by far the most expensive thing the
	// server can do. See unreadCap.
	err := s.DB.Pool.QueryRow(ctx,
		fmt.Sprintf(`SELECT COALESCE(sum(capped.n), 0)::int FROM channel_members cm
		 CROSS JOIN LATERAL (
		     SELECT count(*) AS n FROM (
		         SELECT 1 FROM messages m
		          WHERE m.channel_id = cm.channel_id
		            AND m.id > cm.last_read_message_id
		            AND m.user_id <> cm.user_id
		            AND m.deleted_at IS NULL
		          ORDER BY m.id DESC
		          LIMIT %d
		     ) x
		 ) capped
		 WHERE cm.user_id = $1`, unreadCap), userID).Scan(&n)
	if err != nil {
		log.Printf("api: unread total for user %d: %v", userID, err)
		return 0
	}
	return n
}

// pushText renders the notification title and body: channels are labelled with
// the channel name and prefix the author, DMs are labelled with the author.
func pushText(msg *db.Message, ch *db.Channel, author *db.User) (title, body string) {
	text := strings.Join(strings.Fields(msg.Body), " ")
	if ch.Kind == db.KindDM {
		title = author.DisplayName
		if text == "" {
			return title, "sent an attachment"
		}
		return title, truncateRunes(text, pushBodyRunes)
	}
	title = "#" + ch.Name
	if text == "" {
		return title, author.DisplayName + " sent an attachment"
	}
	return title, truncateRunes(author.DisplayName+": "+text, pushBodyRunes)
}

// truncateRunes shortens s to at most n runes, adding an ellipsis when it cuts.
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return strings.TrimRight(s[:i], " ") + "…"
		}
		count++
	}
	return s
}
