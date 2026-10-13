package api

import (
	"context"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"slock/internal/db"
	"slock/internal/realtime"
)

// mentionCandidate is a user an @-mention can resolve to.
type mentionCandidate struct {
	ID              int64
	DisplayName     string
	AllowedChannels string
	IsMember        bool
}

// Code is literal text: an @name inside it is not a mention, as the client
// renders it.
var (
	codeFenceRE = regexp.MustCompile("(?s)```.*?```")
	codeSpanRE  = regexp.MustCompile("`[^`\n]*`")
)

// mentionedUsers returns the candidates body @-mentions, by display name. It
// mirrors the web client's matchMention: the '@' starts the text or follows
// whitespace or an opening bracket/quote, the longest matching name wins
// (case-insensitive), and the name must end at a word boundary.
func mentionedUsers(body string, users []mentionCandidate) []mentionCandidate {
	if !strings.Contains(body, "@") {
		return nil
	}
	body = codeFenceRE.ReplaceAllString(body, " ")
	body = codeSpanRE.ReplaceAllString(body, " ")
	seen := map[int64]bool{}
	var out []mentionCandidate
	for i := 0; i < len(body); i++ {
		if body[i] != '@' {
			continue
		}
		if i > 0 {
			prev, _ := utf8.DecodeLastRuneInString(body[:i])
			if !unicode.IsSpace(prev) && !strings.ContainsRune(`([{'">`, prev) {
				continue
			}
		}
		rest := body[i+1:]
		best := -1
		for k, u := range users {
			n := u.DisplayName
			if n == "" || len(rest) < len(n) || !strings.EqualFold(rest[:len(n)], n) {
				continue
			}
			if len(rest) > len(n) {
				if c := rest[len(n)]; c == '_' || c == '@' || c < utf8.RuneSelf && (unicode.IsLetter(rune(c)) || unicode.IsDigit(rune(c))) {
					continue // "@bobby" is not "@bob"
				}
			}
			if best < 0 || len(n) > len(users[best].DisplayName) {
				best = k
			}
		}
		if best >= 0 && !seen[users[best].ID] {
			seen[users[best].ID] = true
			out = append(out, users[best])
		}
	}
	return out
}

// inviteMentioned adds to a named channel every active person the body
// @-mentions who is not in it yet, inside the message's transaction so they
// are members by the time the message is published. Limited users outside
// their allowlist are skipped, like handleAddMember. Their read marker sits
// just before the message, so the mention itself is what shows as unread,
// not the channel's whole history.
func (s *Server) inviteMentioned(ctx context.Context, tx pgx.Tx, ch *channelBasics, msgID int64, body string) ([]mentionCandidate, error) {
	if ch.Kind != db.KindChannel || !strings.Contains(body, "@") {
		return nil, nil
	}
	rows, err := tx.Query(ctx,
		`SELECT u.id, u.display_name, u.allowed_channels,
		        EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = $1 AND cm.user_id = u.id)
		   FROM users u WHERE u.is_active AND NOT u.is_bot`, ch.ID)
	if err != nil {
		return nil, err
	}
	var users []mentionCandidate
	for rows.Next() {
		var u mentionCandidate
		if err := rows.Scan(&u.ID, &u.DisplayName, &u.AllowedChannels, &u.IsMember); err != nil {
			rows.Close()
			return nil, err
		}
		users = append(users, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var added []mentionCandidate
	for _, u := range mentionedUsers(body, users) {
		if u.IsMember || !(&db.User{AllowedChannels: u.AllowedChannels}).ChannelAllowed(ch.Name) {
			continue
		}
		tag, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id, last_read_message_id) VALUES ($1, $2, $3)
			 ON CONFLICT DO NOTHING`, ch.ID, u.ID, msgID-1)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() > 0 {
			added = append(added, u)
		}
	}
	return added, nil
}

// announceInvited tells each person a mention just added that they have a new
// channel, and everyone else the new member list. Called after commit and
// before the message itself is published, so the newcomers get it live.
func (s *Server) announceInvited(ctx context.Context, channelID int64, added []mentionCandidate) {
	if len(added) == 0 {
		return
	}
	for _, u := range added {
		if ch, err := s.loadChannel(ctx, channelID, u.ID); err == nil {
			// The count already includes the mention, but the live message.new
			// that follows bumps it on the client too: leave that one to it.
			if ch.UnreadCount > 0 {
				ch.UnreadCount--
			}
			s.Hub.PublishUser(u.ID, realtime.Event{Type: "channel.new", Data: map[string]any{"channel": ch}})
		}
	}
	s.publishMembers(ctx, channelID)
}
