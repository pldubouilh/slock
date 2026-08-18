package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// withServer points the package at a local endpoint for the duration of a test.
func withServer(t *testing.T, h http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(h)
	old := endpoint
	endpoint = srv.URL
	t.Cleanup(func() {
		endpoint = old
		srv.Close()
	})
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(old) })
	return &buf
}

func TestDisabledLogsInsteadOfSending(t *testing.T) {
	withServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("a disabled mailer must not make requests")
	})
	buf := captureLog(t)
	m := New("", "", "")
	if m.Enabled() {
		t.Fatal("Enabled without an api key")
	}
	if err := m.SendWelcome(context.Background(), "ana@example.com", "Ana", "hunter2-temp", "https://chat.example.com/"); err != nil {
		t.Fatalf("a disabled mailer must not fail: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"ana@example.com", "Ana", "Your slock account", "hunter2-temp"} {
		if !strings.Contains(out, want) {
			t.Errorf("log is missing %q:\n%s", want, out)
		}
	}
}

// A key without a from address is not enough to send.
func TestEnabledNeedsBoth(t *testing.T) {
	if New("key", "", "slock").Enabled() {
		t.Error("enabled without a from address")
	}
	if New("", "bot@example.com", "slock").Enabled() {
		t.Error("enabled without an api key")
	}
	if !New("key", "bot@example.com", "slock").Enabled() {
		t.Error("not enabled with both")
	}
	var nilMailer *Mailer
	if nilMailer.Enabled() {
		t.Error("nil mailer is enabled")
	}
}

func TestSendPayload(t *testing.T) {
	var gotAuth, gotType string
	var body map[string]any
	withServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotType = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("body is not JSON: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
	})
	m := New("SG.secret", "bot@example.com", "slock")
	if err := m.Send(context.Background(), "ana@example.com", "Ana", "Subject line", "plain", "<p>rich</p>"); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer SG.secret" {
		t.Errorf("authorization = %q", gotAuth)
	}
	if gotType != "application/json" {
		t.Errorf("content-type = %q", gotType)
	}
	if got := body["subject"]; got != "Subject line" {
		t.Errorf("subject = %v", got)
	}
	from := body["from"].(map[string]any)
	if from["email"] != "bot@example.com" || from["name"] != "slock" {
		t.Errorf("from = %v", from)
	}
	to := body["personalizations"].([]any)[0].(map[string]any)["to"].([]any)[0].(map[string]any)
	if to["email"] != "ana@example.com" || to["name"] != "Ana" {
		t.Errorf("to = %v", to)
	}
	parts := body["content"].([]any)
	if len(parts) != 2 {
		t.Fatalf("content has %d parts", len(parts))
	}
	first := parts[0].(map[string]any)
	second := parts[1].(map[string]any)
	if first["type"] != "text/plain" || first["value"] != "plain" {
		t.Errorf("text part = %v", first)
	}
	if second["type"] != "text/html" || second["value"] != "<p>rich</p>" {
		t.Errorf("html part = %v", second)
	}
}

func TestSendReportsFailure(t *testing.T) {
	withServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"errors":[{"message":"api key not found"}]}`))
	})
	m := New("SG.bad", "bot@example.com", "slock")
	err := m.Send(context.Background(), "ana@example.com", "Ana", "s", "t", "h")
	if err == nil {
		t.Fatal("want an error")
	}
	if !strings.Contains(err.Error(), "api key not found") || !strings.Contains(err.Error(), "401") {
		t.Errorf("error should carry the status and body: %v", err)
	}
}

func TestSendNeedsRecipient(t *testing.T) {
	if err := New("", "", "").Send(context.Background(), "", "", "s", "t", "h"); err == nil {
		t.Error("empty recipient accepted")
	}
}

func TestTemplatesEscapeInterpolatedValues(t *testing.T) {
	var body map[string]any
	withServer(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &body)
		w.WriteHeader(http.StatusAccepted)
	})
	m := New("SG.secret", "bot@example.com", "slock")

	name := `Ana <script>alert(1)</script>`
	password := `a&b"c<d`
	if err := m.SendWelcome(context.Background(), "ana@example.com", name, password, "https://chat.example.com/login"); err != nil {
		t.Fatal(err)
	}
	parts := body["content"].([]any)
	text := parts[0].(map[string]any)["value"].(string)
	html := parts[1].(map[string]any)["value"].(string)

	if strings.Contains(html, "<script>") {
		t.Errorf("unescaped script tag in html:\n%s", html)
	}
	if !strings.Contains(html, "&lt;script&gt;") {
		t.Errorf("name not escaped:\n%s", html)
	}
	if !strings.Contains(html, "a&amp;b&#34;c&lt;d") {
		t.Errorf("password not escaped:\n%s", html)
	}
	if !strings.Contains(html, "https://chat.example.com/login") {
		t.Errorf("login url missing:\n%s", html)
	}
	// The text part is plain: values appear verbatim there.
	if !strings.Contains(text, password) || !strings.Contains(text, name) {
		t.Errorf("text part is missing the values:\n%s", text)
	}
	if strings.Contains(html, "<img") || strings.Contains(html, "http://") {
		t.Errorf("html should have no images or insecure links:\n%s", html)
	}
}

func TestPasswordResetBody(t *testing.T) {
	var body map[string]any
	withServer(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &body)
		w.WriteHeader(http.StatusAccepted)
	})
	m := New("SG.secret", "bot@example.com", "slock")
	url := "https://chat.example.com/reset?token=abc123"
	if err := m.SendPasswordReset(context.Background(), "ana@example.com", "Ana", url); err != nil {
		t.Fatal(err)
	}
	if got := body["subject"].(string); !strings.Contains(strings.ToLower(got), "reset") {
		t.Errorf("subject = %q", got)
	}
	parts := body["content"].([]any)
	for _, part := range parts {
		value := part.(map[string]any)["value"].(string)
		if !strings.Contains(value, url) {
			t.Errorf("%v is missing the reset link:\n%s", part.(map[string]any)["type"], value)
		}
		if !strings.Contains(value, "Ana") {
			t.Errorf("%v is missing the name", part.(map[string]any)["type"])
		}
	}
}

// A javascript: URL must not survive into an href.
func TestTemplatesRejectDangerousURL(t *testing.T) {
	_, html, err := render(resetTemplate, map[string]string{"Name": "Ana", "URL": "javascript:alert(1)"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(html, "href=\"javascript:") {
		t.Errorf("javascript url reached an href:\n%s", html)
	}
}

// Missing values render as an empty string rather than Go's <no value>.
func TestTemplatesTolerateMissingName(t *testing.T) {
	text, html, err := render(welcomeTemplate, map[string]string{"Email": "a@b.c", "Password": "x", "URL": "https://x/"})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{text, html} {
		if strings.Contains(s, "<no value>") {
			t.Errorf("missing value leaked:\n%s", s)
		}
		if !strings.HasPrefix(strings.TrimSpace(stripTags(s)), "Hi,") {
			t.Errorf("greeting reads badly without a name:\n%s", s)
		}
	}
}

func stripTags(s string) string {
	var b strings.Builder
	depth := 0
	for _, r := range s {
		switch {
		case r == '<':
			depth++
		case r == '>':
			depth--
		case depth == 0:
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}
