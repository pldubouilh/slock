// Package mail sends transactional email through the SendGrid v3 API.
// No SDK: it is one JSON POST.
package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// endpoint is a var so tests can point it at a local server.
var endpoint = "https://api.sendgrid.com/v3/mail/send"

// Mailer talks to SendGrid. A Mailer with no API key is disabled and logs
// instead of sending, so development never needs credentials.
type Mailer struct {
	apiKey   string
	from     string
	fromName string
}

// New builds a Mailer. An empty apiKey yields a disabled (logging) Mailer.
func New(apiKey, from, fromName string) *Mailer {
	return &Mailer{apiKey: apiKey, from: from, fromName: fromName}
}

// Enabled reports whether real delivery is configured.
func (m *Mailer) Enabled() bool { return m != nil && m.apiKey != "" && m.from != "" }

// sendgridRequest is the subset of the v3 mail/send schema we use.
type sendgridRequest struct {
	Personalizations []personalization `json:"personalizations"`
	From             address           `json:"from"`
	Subject          string            `json:"subject"`
	Content          []content         `json:"content"`
}

type personalization struct {
	To []address `json:"to"`
}

type address struct {
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

type content struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

var client = &http.Client{Timeout: 10 * time.Second}

// Send delivers one message. When disabled it logs the message and returns nil.
func (m *Mailer) Send(ctx context.Context, toEmail, toName, subject, text, html string) error {
	if m == nil {
		return errors.New("mail: no mailer")
	}
	if toEmail == "" {
		return errors.New("mail: no recipient")
	}
	if !m.Enabled() {
		log.Printf("mail: not configured, logging instead of sending\n  to: %s <%s>\n  subject: %s\n  %s",
			toName, toEmail, subject, indent(text))
		return nil
	}

	body, err := json.Marshal(sendgridRequest{
		Personalizations: []personalization{{To: []address{{Email: toEmail, Name: toName}}}},
		From:             address{Email: m.from, Name: m.fromName},
		Subject:          subject,
		Content: []content{
			{Type: "text/plain", Value: text},
			{Type: "text/html", Value: html},
		},
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("mail: post: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("mail: sendgrid rejected the message (%s): %s", resp.Status, snippet(respBody))
	}
	return nil
}

// SendPasswordReset mails a reset link.
func (m *Mailer) SendPasswordReset(ctx context.Context, toEmail, toName, resetURL string) error {
	text, html, err := render(resetTemplate, map[string]string{
		"Name": toName,
		"URL":  resetURL,
	})
	if err != nil {
		return err
	}
	return m.Send(ctx, toEmail, toName, "Reset your slock password", text, html)
}

// SendWelcome mails an invite with the admin-generated temporary password.
func (m *Mailer) SendWelcome(ctx context.Context, toEmail, toName, tempPassword, loginURL string) error {
	text, html, err := render(welcomeTemplate, map[string]string{
		"Name":     toName,
		"Email":    toEmail,
		"Password": tempPassword,
		"URL":      loginURL,
	})
	if err != nil {
		return err
	}
	return m.Send(ctx, toEmail, toName, "Your slock account", text, html)
}

// indent shifts a body one level in for the disabled-mailer log, so the
// temporary password or reset link is readable in the server output.
func indent(s string) string {
	return strings.ReplaceAll(strings.TrimSpace(s), "\n", "\n  ")
}

func snippet(b []byte) string {
	s := strings.Join(strings.Fields(string(b)), " ")
	if len(s) > 300 {
		s = s[:300] + "..."
	}
	if s == "" {
		return "(empty body)"
	}
	return s
}
