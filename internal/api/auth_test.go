package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"testing"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/realtime"
)

func TestNewTokenIsRandomAndDecodes(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		tok, err := newToken(32)
		if err != nil {
			t.Fatalf("newToken: %v", err)
		}
		raw, err := base64.RawURLEncoding.DecodeString(tok)
		if err != nil {
			t.Fatalf("token %q is not base64url: %v", tok, err)
		}
		if len(raw) != 32 {
			t.Fatalf("token decodes to %d bytes, want 32", len(raw))
		}
		if strings.ContainsAny(tok, "+/=") {
			t.Fatalf("token %q is not URL-safe", tok)
		}
		if seen[tok] {
			t.Fatalf("token %q repeated", tok)
		}
		seen[tok] = true
	}
}

func TestHashTokenIsSHA256(t *testing.T) {
	const tok = "a-token"
	want := sha256.Sum256([]byte(tok))
	got := hashToken(tok)
	if !bytes.Equal(got, want[:]) {
		t.Fatalf("hashToken = %x, want %x", got, want)
	}
	if len(got) != 32 {
		t.Fatalf("hash is %d bytes, want 32", len(got))
	}
	if bytes.Equal(hashToken("other"), got) {
		t.Fatal("different tokens hashed to the same value")
	}
}

func TestValidatePassword(t *testing.T) {
	tests := []struct {
		name string
		pw   string
		ok   bool
	}{
		{"empty", "", false},
		{"seven", "1234567", false},
		{"eight", "12345678", true},
		{"long but legal", strings.Repeat("x", 72), true},
		// PBKDF2 has no length ceiling of its own; 256 bytes is just a sanity bound.
		{"at the limit", strings.Repeat("x", 256), true},
		{"over the limit", strings.Repeat("x", 257), false},
		{"multibyte counts as bytes", strings.Repeat("é", 129), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validatePassword(tc.pw)
			if tc.ok && err != nil {
				t.Fatalf("validatePassword(%q) = %v, want nil", tc.pw, err)
			}
			if !tc.ok {
				var apiErr *httpx.Error
				if !errors.As(err, &apiErr) || apiErr.Status != http.StatusBadRequest {
					t.Fatalf("validatePassword(%q) = %v, want a 400", tc.pw, err)
				}
			}
		})
	}
}

func TestLooksLikeEmail(t *testing.T) {
	tests := []struct {
		in string
		ok bool
	}{
		{"ana@example.com", true},
		{"a.b+c@sub.example.co.uk", true},
		{"", false},
		{"ana", false},
		{"ana@localhost", false},
		{"@example.com", false},
		{"ana@", false},
		{"ana @example.com", false},
		{"ana@example.com\nbcc@evil.com", false},
	}
	for _, tc := range tests {
		if got := looksLikeEmail(tc.in); got != tc.ok {
			t.Fatalf("looksLikeEmail(%q) = %v, want %v", tc.in, got, tc.ok)
		}
	}
}

func TestAvatarColorForIsStableAndInRange(t *testing.T) {
	for _, seed := range []string{"", "ana@x.com", "bob@x.com", "zoë@example.com"} {
		got := avatarColorFor(seed)
		if got < 0 || got >= avatarColorCount {
			t.Fatalf("avatarColorFor(%q) = %d, out of range", seed, got)
		}
		if again := avatarColorFor(seed); again != got {
			t.Fatalf("avatarColorFor(%q) is not stable: %d then %d", seed, got, again)
		}
	}
}

func TestPushText(t *testing.T) {
	author := &db.User{ID: 1, DisplayName: "Ana"}
	tests := []struct {
		name      string
		kind      string
		chName    string
		body      string
		wantTitle string
		wantBody  string
	}{
		{"channel message", db.KindChannel, "design", "hi there", "#design", "Ana: hi there"},
		{"channel attachment", db.KindChannel, "design", "   ", "#design", "Ana sent an attachment"},
		{"dm message", db.KindDM, "", "hi there", "Ana", "hi there"},
		{"dm attachment", db.KindDM, "", "", "Ana", "sent an attachment"},
		{"newlines collapse", db.KindDM, "", "one\ntwo\n\nthree", "Ana", "one two three"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			title, body := pushText(
				&db.Message{Body: tc.body},
				&db.Channel{ID: 7, Kind: tc.kind, Name: tc.chName},
				author)
			if title != tc.wantTitle || body != tc.wantBody {
				t.Fatalf("pushText = (%q, %q), want (%q, %q)", title, body, tc.wantTitle, tc.wantBody)
			}
		})
	}
}

func TestPushTextTruncates(t *testing.T) {
	_, body := pushText(
		&db.Message{Body: strings.Repeat("é", 400)},
		&db.Channel{ID: 7, Kind: db.KindDM},
		&db.User{DisplayName: "Ana"})
	if n := len([]rune(body)); n != pushBodyRunes+1 {
		t.Fatalf("body is %d runes, want %d plus an ellipsis", n, pushBodyRunes)
	}
	if !strings.HasSuffix(body, "…") {
		t.Fatalf("truncated body %q does not end with an ellipsis", body)
	}
}

func TestTruncateRunes(t *testing.T) {
	tests := []struct {
		in   string
		n    int
		want string
	}{
		{"short", 10, "short"},
		{"exactly-10", 10, "exactly-10"},
		{"truncate me", 8, "truncate…"},
		{"ééééé", 3, "ééé…"},
	}
	for _, tc := range tests {
		if got := truncateRunes(tc.in, tc.n); got != tc.want {
			t.Fatalf("truncateRunes(%q, %d) = %q, want %q", tc.in, tc.n, got, tc.want)
		}
	}
}

func TestWriteSSEFrameFormat(t *testing.T) {
	var buf bytes.Buffer
	ev := realtime.Event{Type: "hello", Data: map[string]any{"user_id": 3}}
	if err := writeSSE(&buf, ev); err != nil {
		t.Fatalf("writeSSE: %v", err)
	}
	got := buf.String()
	if got != "event: hello\ndata: {\"user_id\":3}\n\n" {
		t.Fatalf("frame = %q", got)
	}

	// A body with newlines must not break the frame into two events.
	buf.Reset()
	if err := writeSSE(&buf, realtime.Event{Type: "message.new", Data: map[string]any{"body": "one\ntwo"}}); err != nil {
		t.Fatalf("writeSSE: %v", err)
	}
	frame := strings.TrimSuffix(buf.String(), "\n\n")
	if strings.Count(frame, "\n") != 1 {
		t.Fatalf("frame %q contains a raw newline in its data", buf.String())
	}
}
