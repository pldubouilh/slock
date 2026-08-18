package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// sessionCookie mirrors the server's api.SessionCookie literal. Hardcoded so
// the CLI does not import server internals it has no business linking.
const sessionCookie = "slock_session"

// errUnauthorized is the "session expired" sentinel: any 401 unwinds the UI
// and tells the user to log in again.
var errUnauthorized = errors.New("session expired — run `slock-cli login <url>` again")

// ---------------------------------------------------------------------------
// wire types — the client-side mirror of the server's JSON (docs/API.md)
// ---------------------------------------------------------------------------

type User struct {
	ID          int64  `json:"id"`
	DisplayName string `json:"display_name"`
	AvatarColor int    `json:"avatar_color"`
	StatusText  string `json:"status_text"`
	IsAdmin     bool   `json:"is_admin"`
	IsActive    bool   `json:"is_active"`
}

type Attachment struct {
	ID       int64  `json:"id"`
	Filename string `json:"filename"`
}

type Reaction struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
}

type Message struct {
	ID          int64        `json:"id"`
	ChannelID   int64        `json:"channel_id"`
	UserID      int64        `json:"user_id"`
	Body        string       `json:"body"`
	CreatedAt   time.Time    `json:"created_at"`
	EditedAt    *time.Time   `json:"edited_at"`
	DeletedAt   *time.Time   `json:"deleted_at"`
	Attachments []Attachment `json:"attachments"`
	Reactions   []Reaction   `json:"reactions"`

	// Local marks a client-side system line (command output, errors). It is
	// rendered dim in the chat pane and never exists on the server.
	Local bool `json:"-"`
}

type Channel struct {
	ID            int64      `json:"id"`
	Kind          string     `json:"kind"`
	Name          string     `json:"name"`
	Topic         string     `json:"topic"`
	IsPrivate     bool       `json:"is_private"`
	LastMessageAt *time.Time `json:"last_message_at"`
	IsMember      bool       `json:"is_member"`
	Muted         bool       `json:"muted"`
	UnreadCount   int        `json:"unread_count"`
	MemberCount   int        `json:"member_count"`
	PeerUserID    *int64     `json:"peer_user_id"`
	Members       []int64    `json:"members"`
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

type Client struct {
	Base    string // https://slock.example.com, no trailing slash
	Session string // the opaque session token
	http    *http.Client
}

func NewClient(base, session string) *Client {
	return &Client{
		Base:    strings.TrimRight(base, "/"),
		Session: session,
		http:    &http.Client{Timeout: 20 * time.Second},
	}
}

// apiError is the server's {error, message} body, surfaced as message text.
type apiError struct {
	Code    string `json:"error"`
	Message string `json:"message"`
}

// do runs one JSON round-trip. in == nil sends no body; out == nil discards
// the response body. A 401 always comes back as errUnauthorized.
func (c *Client) do(method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = strings.NewReader(string(b))
	}
	req, err := http.NewRequest(method, c.Base+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: c.Session})

	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusUnauthorized {
		return errUnauthorized
	}
	if res.StatusCode >= 400 {
		var e apiError
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		if json.Unmarshal(data, &e) == nil && e.Message != "" {
			return errors.New(e.Message)
		}
		return fmt.Errorf("request failed (%d)", res.StatusCode)
	}
	if out == nil || res.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// -------- endpoints, in the order a session uses them

func (c *Client) Login(email, password string) (User, string, error) {
	// Login is the one call made without a session; the cookie in the response
	// is the token everything else sends back.
	b, _ := json.Marshal(map[string]string{"email": email, "password": password})
	req, err := http.NewRequest("POST", c.Base+"/api/auth/login", strings.NewReader(string(b)))
	if err != nil {
		return User{}, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return User{}, "", err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		var e apiError
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		if json.Unmarshal(data, &e) == nil && e.Message != "" {
			return User{}, "", errors.New(e.Message)
		}
		return User{}, "", fmt.Errorf("login failed (%d)", res.StatusCode)
	}
	var payload struct {
		User User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return User{}, "", err
	}
	for _, ck := range res.Cookies() {
		if ck.Name == sessionCookie {
			return payload.User, ck.Value, nil
		}
	}
	return User{}, "", errors.New("server did not set a session cookie")
}

func (c *Client) Me() (User, error) {
	var payload struct {
		User User `json:"user"`
	}
	err := c.do("GET", "/api/auth/me", nil, &payload)
	return payload.User, err
}

func (c *Client) Version() string {
	var payload struct {
		Version string `json:"version"`
	}
	if c.do("GET", "/api/version", nil, &payload) != nil {
		return "?"
	}
	return payload.Version
}

func (c *Client) Workspace() string {
	var payload struct {
		Workspace struct {
			Name string `json:"name"`
		} `json:"workspace"`
	}
	if c.do("GET", "/api/workspace", nil, &payload) != nil {
		return ""
	}
	return payload.Workspace.Name
}

func (c *Client) Users() ([]User, error) {
	var payload struct {
		Users []User `json:"users"`
	}
	err := c.do("GET", "/api/users", nil, &payload)
	return payload.Users, err
}

func (c *Client) Channels() ([]Channel, []Channel, error) {
	var payload struct {
		Channels []Channel `json:"channels"`
		DMs      []Channel `json:"dms"`
	}
	err := c.do("GET", "/api/channels", nil, &payload)
	return payload.Channels, payload.DMs, err
}

func (c *Client) Messages(channelID int64, before, after int64, limit int) ([]Message, bool, error) {
	q := url.Values{"limit": {strconv.Itoa(limit)}}
	if before > 0 {
		q.Set("before", strconv.FormatInt(before, 10))
	}
	if after > 0 {
		q.Set("after", strconv.FormatInt(after, 10))
	}
	var payload struct {
		Messages []Message `json:"messages"`
		HasMore  bool      `json:"has_more"`
	}
	err := c.do("GET", "/api/channels/"+strconv.FormatInt(channelID, 10)+"/messages?"+q.Encode(), nil, &payload)
	return payload.Messages, payload.HasMore, err
}

func (c *Client) Send(channelID int64, body string) (Message, error) {
	var payload struct {
		Message Message `json:"message"`
	}
	err := c.do("POST", "/api/channels/"+strconv.FormatInt(channelID, 10)+"/messages",
		map[string]string{"body": body}, &payload)
	return payload.Message, err
}

// SendWithAttachments posts a message with attachments (body may be empty).
func (c *Client) SendWithAttachments(channelID int64, body string, attachmentIDs []int64) (Message, error) {
	var payload struct {
		Message Message `json:"message"`
	}
	data := map[string]any{"body": body, "attachment_ids": attachmentIDs}
	err := c.do("POST", "/api/channels/"+strconv.FormatInt(channelID, 10)+"/messages",
		data, &payload)
	return payload.Message, err
}

func (c *Client) Edit(messageID int64, body string) (Message, error) {
	var payload struct {
		Message Message `json:"message"`
	}
	err := c.do("PATCH", "/api/messages/"+strconv.FormatInt(messageID, 10),
		map[string]string{"body": body}, &payload)
	return payload.Message, err
}

func (c *Client) MarkRead(channelID, lastMessageID int64) error {
	return c.do("POST", "/api/channels/"+strconv.FormatInt(channelID, 10)+"/read",
		map[string]int64{"last_message_id": lastMessageID}, nil)
}

func (c *Client) OpenDM(userID int64) (Channel, error) {
	var payload struct {
		Channel Channel `json:"channel"`
	}
	err := c.do("POST", "/api/dms", map[string]int64{"user_id": userID}, &payload)
	return payload.Channel, err
}

func (c *Client) CreateChannel(name string, private bool) (Channel, error) {
	var payload struct {
		Channel Channel `json:"channel"`
	}
	err := c.do("POST", "/api/channels",
		map[string]any{"name": name, "is_private": private}, &payload)
	return payload.Channel, err
}

func (c *Client) AddMember(channelID, userID int64) error {
	return c.do("POST", "/api/channels/"+strconv.FormatInt(channelID, 10)+"/members",
		map[string]int64{"user_id": userID}, nil)
}

func (c *Client) SetMute(channelID int64, muted bool) error {
	return c.do("POST", "/api/channels/"+strconv.FormatInt(channelID, 10)+"/mute",
		map[string]bool{"muted": muted}, nil)
}

func (c *Client) Leave(channelID int64) error {
	return c.do("POST", "/api/channels/"+strconv.FormatInt(channelID, 10)+"/leave", nil, nil)
}

func (c *Client) AdminCreateUser(email, name string) (User, string, error) {
	var payload struct {
		User         User   `json:"user"`
		TempPassword string `json:"temp_password"`
	}
	err := c.do("POST", "/api/admin/users",
		map[string]any{"email": email, "display_name": name}, &payload)
	return payload.User, payload.TempPassword, err
}

// Upload posts a file to /api/uploads and returns the attachment ID.
// The field name is "file" and the filename is the base name provided.
func (c *Client) Upload(file io.Reader, filename string) (int64, error) {
	// Create the multipart body
	var body strings.Builder
	w := multipart.NewWriter(&body)

	// Add the file field
	fw, err := w.CreateFormFile("file", filename)
	if err != nil {
		return 0, err
	}
	if _, err := io.Copy(fw, file); err != nil {
		return 0, err
	}
	if err := w.Close(); err != nil {
		return 0, err
	}

	// Create the request
	req, err := http.NewRequest("POST", c.Base+"/api/uploads", strings.NewReader(body.String()))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: c.Session})

	// Send the request
	res, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusUnauthorized {
		return 0, errUnauthorized
	}
	if res.StatusCode >= 400 {
		var e apiError
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		if json.Unmarshal(data, &e) == nil && e.Message != "" {
			return 0, errors.New(e.Message)
		}
		return 0, fmt.Errorf("upload failed (%d)", res.StatusCode)
	}

	var payload struct {
		Attachment Attachment `json:"attachment"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return 0, err
	}
	return payload.Attachment.ID, nil
}

// FileURL is the absolute download link for an attachment, rendered as text
// in the chat pane — a terminal shows links, not pixels.
func (c *Client) FileURL(a Attachment) string {
	return c.Base + "/api/files/" + strconv.FormatInt(a.ID, 10) + "/original/" + url.PathEscape(a.Filename)
}

// ---------------------------------------------------------------------------
// SSE — /api/events
// ---------------------------------------------------------------------------

// sseEvent is one realtime frame: the event name plus its raw JSON payload,
// decoded by the handler that knows the shape.
type sseEvent struct {
	Type string
	Data json.RawMessage
}

// runSSE consumes the event stream forever, sending frames to out and a
// connection-state marker ("__down"/"__up" pseudo-events) around reconnects,
// with the same 1s→30s backoff the web client uses. It stops when ctx ends.
// A 401 sends "__unauthorized" so the UI can exit with the login hint.
func runSSE(ctx context.Context, c *Client, out chan<- sseEvent) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := streamOnce(ctx, c, out)
		if err == errUnauthorized {
			out <- sseEvent{Type: "__unauthorized"}
			return
		}
		if ctx.Err() != nil {
			return
		}
		out <- sseEvent{Type: "__down"}
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func streamOnce(ctx context.Context, c *Client, out chan<- sseEvent) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.Base+"/api/events?visible=1", nil)
	if err != nil {
		return err
	}
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: c.Session})

	// A dedicated client without the request timeout: this connection is
	// supposed to live forever.
	stream := &http.Client{}
	res, err := stream.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return errUnauthorized
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("events stream: %d", res.StatusCode)
	}

	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	var name string
	var data strings.Builder
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			name = line[len("event: "):]
		case strings.HasPrefix(line, "data: "):
			data.WriteString(line[len("data: "):])
		case line == "":
			if name != "" && data.Len() > 0 {
				out <- sseEvent{Type: name, Data: json.RawMessage(data.String())}
			}
			name = ""
			data.Reset()
		}
		// ": ping" heartbeats fall through all cases and are dropped.
	}
	return sc.Err()
}
