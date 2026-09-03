package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
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

// notifyNewMessage queues web push for a new message to every channel member
// who has no visible tab (per Hub.HasVisible), is not the author, and has not
// muted the channel. Merely being connected is not enough to suppress push: a
// backgrounded tab keeps its SSE stream open, and skipping "online" users
// meant one forgotten desktop tab silenced every device — but it is enough to
// buy a grace period (pushGrace) in which reading the message anywhere
// cancels the push. Nothing is sent here: pushes become push_queue rows and
// the worker (drainPushQueue) delivers them, so grace holds survive a restart
// and failed sends can retry. One row per (user, channel) is the coalescing
// rule — a newer message replaces a pending row's payload but keeps its
// deadline, so a busy channel cannot defer its notification forever. It runs
// on its own background context because the request that triggered it is
// already finished.
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

	queued := false
	for _, uid := range recipients {
		// Connected somewhere (a hidden tab, a locked phone with the PWA
		// open): they are likely about to read this where they are, and a
		// sent push cannot be taken back — grant the grace period. No
		// connection at all: due immediately.
		delay := time.Duration(0)
		if s.Hub.IsOnline(uid) {
			delay = pushGrace
		}
		_, err := s.DB.Pool.Exec(ctx,
			`INSERT INTO push_queue (user_id, channel_id, message_id, deliver_after)
			 VALUES ($1, $2, $3, now() + make_interval(secs => $4))
			 ON CONFLICT (user_id, channel_id) DO UPDATE
			   SET message_id = EXCLUDED.message_id`,
			uid, ch.ID, msg.ID, delay.Seconds())
		if err != nil {
			log.Printf("api: queue push for user %d: %v", uid, err)
			continue
		}
		queued = true
	}
	if queued {
		s.kickPushWorker()
	}
}

// StartPushWorker launches the goroutine that drains push_queue: every tick
// (or sooner, when kicked after an enqueue) it claims due rows and delivers
// them. FOR UPDATE SKIP LOCKED in the claim makes concurrent workers — other
// server instances against the same database — safe: a row is delivered once.
func (s *Server) StartPushWorker(ctx context.Context) {
	if !s.Pusher.Enabled() {
		return
	}
	s.pushKick = make(chan struct{}, 1)
	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			case <-s.pushKick:
			}
			s.drainPushQueue(ctx)
		}
	}()
}

// kickPushWorker nudges the worker to run now instead of at the next tick, so
// a push to a fully offline user is not held for up to a tick. Non-blocking:
// a pending kick already covers this one.
func (s *Server) kickPushWorker() {
	if s.pushKick == nil {
		return
	}
	select {
	case s.pushKick <- struct{}{}:
	default:
	}
}

const (
	pushClaimBatch  = 50
	pushMaxAttempts = 5
)

// drainPushQueue claims and delivers due rows until the queue has no more.
func (s *Server) drainPushQueue(ctx context.Context) {
	for {
		n, err := s.deliverDuePushes(ctx)
		if err != nil {
			log.Printf("api: push queue: %v", err)
			return
		}
		if n < pushClaimBatch {
			return
		}
	}
}

// deliverDuePushes claims one batch of due rows (deleting them — failures are
// re-queued explicitly) and sends each after re-checking that it still makes
// sense: the recipient is not looking at slock, has not read the channel past
// the message on any device, is still a member, and the message still exists
// undeleted. The payload is rendered fresh from the database, so edits,
// renames and deletions between enqueue and delivery are honoured.
func (s *Server) deliverDuePushes(ctx context.Context) (int, error) {
	rows, err := s.DB.Pool.Query(ctx,
		`DELETE FROM push_queue
		  WHERE (user_id, channel_id) IN (
		        SELECT user_id, channel_id FROM push_queue
		         WHERE deliver_after <= now()
		         ORDER BY deliver_after
		         LIMIT $1
		           FOR UPDATE SKIP LOCKED)
		  RETURNING user_id, channel_id, message_id, attempts`, pushClaimBatch)
	if err != nil {
		return 0, err
	}
	type due struct {
		userID, channelID, msgID int64
		attempts                 int16
	}
	var claimed []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.userID, &d.channelID, &d.msgID, &d.attempts); err != nil {
			rows.Close()
			return 0, err
		}
		claimed = append(claimed, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	for _, d := range claimed {
		if s.Hub.HasVisible(d.userID) {
			continue
		}
		var lastRead int64
		err := s.DB.Pool.QueryRow(ctx,
			`SELECT last_read_message_id FROM channel_members
			  WHERE channel_id = $1 AND user_id = $2`, d.channelID, d.userID).Scan(&lastRead)
		if err != nil {
			if !isNoRows(err) { // no rows: no longer a member, push is moot
				log.Printf("api: push read check for user %d: %v", d.userID, err)
			}
			continue
		}
		if lastRead >= d.msgID {
			continue
		}

		var msg db.Message
		var ch db.Channel
		var author db.User
		err = s.DB.Pool.QueryRow(ctx,
			`SELECT m.id, m.channel_id, m.user_id, m.body, m.created_at,
			        c.kind, c.name, u.display_name
			   FROM messages m
			   JOIN channels c ON c.id = m.channel_id
			   JOIN users u ON u.id = m.user_id
			  WHERE m.id = $1 AND m.deleted_at IS NULL`, d.msgID).
			Scan(&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Body, &msg.CreatedAt,
				&ch.Kind, &ch.Name, &author.DisplayName)
		if err != nil {
			if !isNoRows(err) { // no rows: deleted before delivery, say nothing
				log.Printf("api: push load message %d: %v", d.msgID, err)
			}
			continue
		}
		ch.ID = d.channelID

		title, body := pushText(&msg, &ch, &author)
		channelID := strconv.FormatInt(d.channelID, 10)
		delivered := s.pushToUser(ctx, d.userID, push.Notification{
			Title:     title,
			Body:      body,
			Tag:       "channel-" + channelID,
			URL:       "/?c=" + channelID,
			ChannelID: d.channelID,
			Badge:     s.unreadTotal(ctx, d.userID),
		})
		if !delivered && d.attempts+1 < pushMaxAttempts {
			// Transient push-service failure: back off exponentially. DO
			// NOTHING on conflict — a newer message re-queued this channel
			// meanwhile, and that row supersedes this one.
			backoff := (time.Duration(30<<d.attempts) * time.Second).Seconds()
			_, err := s.DB.Pool.Exec(ctx,
				`INSERT INTO push_queue (user_id, channel_id, message_id, deliver_after, attempts)
				 VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)
				 ON CONFLICT (user_id, channel_id) DO NOTHING`,
				d.userID, d.channelID, d.msgID, backoff, d.attempts+1)
			if err != nil {
				log.Printf("api: requeue push for user %d: %v", d.userID, err)
			}
		}
	}
	return len(claimed), nil
}

// pushToUser delivers n to every browser the user has registered, dropping
// subscriptions the push service reports as gone. It reports false only when
// there was something to deliver and every attempt failed transiently — the
// one case a retry can help; no subscriptions, or only permanently dead ones,
// is "done".
func (s *Server) pushToUser(ctx context.Context, userID int64, n push.Notification) bool {
	rows, err := s.DB.Pool.Query(ctx,
		`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, userID)
	if err != nil {
		log.Printf("api: load push subscriptions for user %d: %v", userID, err)
		return false
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
			return false
		}
		subs = append(subs, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Printf("api: load push subscriptions for user %d: %v", userID, err)
		return false
	}

	failed := 0
	for _, v := range subs {
		err := s.Pusher.Send(ctx, v.s, n)
		switch {
		case err == nil:
		case errors.Is(err, push.ErrGone):
			_, _ = s.DB.Pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, v.id)
		default:
			log.Printf("api: web push to user %d: %v", userID, err)
			_, _ = s.DB.Pool.Exec(ctx, `UPDATE push_subscriptions SET failed_at = now() WHERE id = $1`, v.id)
			failed++
		}
	}
	return failed == 0 || failed < len(subs)
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
