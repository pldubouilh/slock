package db

import (
	"strconv"
	"time"
)

// User is a person. Wire form omits password_hash and email (email only for admin views).
type User struct {
	ID           int64     `json:"id"`
	Email        string    `json:"email,omitempty"`
	DisplayName  string    `json:"display_name"`
	AvatarColor  int16     `json:"avatar_color"`
	StatusText   string    `json:"status_text"`
	IsAdmin      bool      `json:"is_admin"`
	IsActive     bool      `json:"is_active"`
	MustChangePW bool      `json:"must_change_pw,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	LastSeenAt   time.Time `json:"last_seen_at"`

	// AvatarSHA identifies the uploaded picture in the media store. It stays
	// server-side; clients get AvatarURL, which carries the hash as a cache
	// buster so a new upload is picked up immediately.
	AvatarSHA string `json:"-"`
	AvatarURL string `json:"avatar_url"`
}

// SetAvatarURL derives the client-facing avatar URL from AvatarSHA. Every scan
// helper calls it, so the wire form is consistent wherever a user is loaded.
func (u *User) SetAvatarURL() {
	if u.AvatarSHA == "" {
		u.AvatarURL = ""
		return
	}
	version := u.AvatarSHA
	if len(version) > 12 {
		version = version[:12]
	}
	u.AvatarURL = "/api/users/" + strconv.FormatInt(u.ID, 10) + "/avatar?v=" + version
}

const (
	KindChannel = "channel"
	KindDM      = "dm"
)

// Channel is either a named channel or a 1:1 DM (Kind == KindDM).
type Channel struct {
	ID            int64      `json:"id"`
	Kind          string     `json:"kind"`
	Name          string     `json:"name"`
	Topic         string     `json:"topic"`
	IsPrivate     bool       `json:"is_private"`
	CreatedBy     *int64     `json:"created_by,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	LastMessageAt *time.Time `json:"last_message_at,omitempty"`

	// Per-request, per-viewer fields.
	IsMember    bool    `json:"is_member"`
	Muted       bool    `json:"muted"`
	UnreadCount int     `json:"unread_count"`
	MemberCount int     `json:"member_count"`
	PeerUserID  *int64  `json:"peer_user_id,omitempty"` // DMs only
	Members     []int64 `json:"members,omitempty"`
}

type Message struct {
	ID          int64        `json:"id"`
	ChannelID   int64        `json:"channel_id"`
	UserID      int64        `json:"user_id"`
	Body        string       `json:"body"`
	CreatedAt   time.Time    `json:"created_at"`
	EditedAt    *time.Time   `json:"edited_at,omitempty"`
	DeletedAt   *time.Time   `json:"deleted_at,omitempty"`
	Attachments []Attachment `json:"attachments"`
	Reactions   []Reaction   `json:"reactions"`
	ClientID    string       `json:"client_id,omitempty"` // echoed back for optimistic sends
}

type Attachment struct {
	ID         int64  `json:"id"`
	MessageID  *int64 `json:"message_id,omitempty"`
	UploaderID int64  `json:"uploader_id"`
	Filename   string `json:"filename"`
	Mime       string `json:"mime"`
	SizeBytes  int64  `json:"size_bytes"`
	SHA256     string `json:"-"`
	IsImage    bool   `json:"is_image"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	HasDisplay bool   `json:"has_display"`
	HasThumb   bool   `json:"has_thumb"`
}

// Reaction is aggregated per emoji for the wire.
type Reaction struct {
	Emoji   string  `json:"emoji"`
	Count   int     `json:"count"`
	UserIDs []int64 `json:"user_ids"`
	Mine    bool    `json:"mine"`
}

type PushSubscription struct {
	ID       int64  `json:"id"`
	UserID   int64  `json:"user_id"`
	Endpoint string `json:"endpoint"`
	P256DH   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

// SearchResult is one hit with enough context to render a row.
type SearchResult struct {
	Message     Message `json:"message"`
	ChannelID   int64   `json:"channel_id"`
	ChannelName string  `json:"channel_name"`
	ChannelKind string  `json:"channel_kind"`
	UserID      int64   `json:"user_id"`
	UserName    string  `json:"user_name"`
	Snippet     string  `json:"snippet"`
}
