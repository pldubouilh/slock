// Package push implements Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID)
// against the standard library only.
package push

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ErrGone means the subscription is dead and should be deleted (404/410).
var ErrGone = errors.New("push: subscription gone")

// Subscription mirrors the browser PushSubscription JSON.
type Subscription struct {
	Endpoint string `json:"endpoint"`
	P256DH   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

// Notification is the payload delivered to the service worker.
type Notification struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Tag   string `json:"tag"`
	URL   string `json:"url"`
	Badge int    `json:"badge"`
}

// Pusher signs and encrypts Web Push requests. Zero value is disabled.
type Pusher struct {
	publicKey  string // base64url raw, uncompressed P-256 point
	privateKey string // base64url raw scalar
	subject    string // "mailto:..." or an https URL

	signKey *ecdsa.PrivateKey
	client  *http.Client
}

// ttlSeconds is how long a push service may hold an undelivered message.
const ttlSeconds = 86400

// New builds a Pusher from base64url-encoded VAPID keys. Empty keys yield a
// disabled Pusher (Enabled reports false) rather than an error.
func New(publicKeyB64, privateKeyB64, subject string) (*Pusher, error) {
	if publicKeyB64 == "" || privateKeyB64 == "" {
		return &Pusher{}, nil
	}
	pub, err := decodeKey(publicKeyB64)
	if err != nil {
		return nil, fmt.Errorf("push: vapid public key: %w", err)
	}
	priv, err := decodeKey(privateKeyB64)
	if err != nil {
		return nil, fmt.Errorf("push: vapid private key: %w", err)
	}
	if len(priv) != 32 {
		return nil, fmt.Errorf("push: vapid private key is %d bytes, want 32", len(priv))
	}
	signKey, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), priv)
	if err != nil {
		return nil, fmt.Errorf("push: vapid private key: %w", err)
	}
	agreeKey, err := ecdh.P256().NewPrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("push: vapid private key: %w", err)
	}
	if !bytes.Equal(agreeKey.PublicKey().Bytes(), pub) {
		return nil, errors.New("push: vapid keys are not a pair")
	}
	if subject == "" {
		return nil, errors.New("push: vapid subject is required")
	}
	return &Pusher{
		publicKey:  base64.RawURLEncoding.EncodeToString(pub),
		privateKey: base64.RawURLEncoding.EncodeToString(priv),
		subject:    subject,
		signKey:    signKey,
		client:     &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// GenerateKeys mints a fresh VAPID keypair, base64url-encoded.
func GenerateKeys() (publicKeyB64, privateKeyB64 string, err error) {
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	enc := base64.RawURLEncoding
	return enc.EncodeToString(key.PublicKey().Bytes()), enc.EncodeToString(key.Bytes()), nil
}

// Enabled reports whether keys were configured.
func (p *Pusher) Enabled() bool { return p != nil && p.publicKey != "" }

// PublicKey returns the applicationServerKey for PushManager.subscribe.
func (p *Pusher) PublicKey() string {
	if p == nil {
		return ""
	}
	return p.publicKey
}

// Send encrypts n for sub and POSTs it. Returns ErrGone for dead subscriptions.
func (p *Pusher) Send(ctx context.Context, sub Subscription, n Notification) error {
	if !p.Enabled() {
		return errors.New("push: not configured")
	}
	if sub.Endpoint == "" || sub.P256DH == "" || sub.Auth == "" {
		return errors.New("push: incomplete subscription")
	}
	uaPublic, err := decodeKey(sub.P256DH)
	if err != nil {
		return fmt.Errorf("push: subscription p256dh: %w", err)
	}
	authSecret, err := decodeKey(sub.Auth)
	if err != nil {
		return fmt.Errorf("push: subscription auth: %w", err)
	}
	plaintext, err := marshalNotification(n)
	if err != nil {
		return err
	}
	as, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	body, err := encrypt(plaintext, uaPublic, authSecret, as, salt)
	if err != nil {
		return err
	}
	auth, err := p.authorization(sub.Endpoint, time.Now())
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Length", strconv.Itoa(len(body)))
	req.Header.Set("TTL", strconv.Itoa(ttlSeconds))
	req.Header.Set("Authorization", auth)
	req.ContentLength = int64(len(body))

	client := p.client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("push: post: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))

	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return ErrGone
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusTooManyRequests:
		return fmt.Errorf("push: rate limited by %s (retry-after %q): %s",
			hostOf(sub.Endpoint), resp.Header.Get("Retry-After"), snippet(respBody))
	case resp.StatusCode >= 500:
		return fmt.Errorf("push: %s is unavailable (%s): %s", hostOf(sub.Endpoint), resp.Status, snippet(respBody))
	default:
		return fmt.Errorf("push: %s rejected the request (%s): %s", hostOf(sub.Endpoint), resp.Status, snippet(respBody))
	}
}

// decodeKey accepts base64url or standard base64, padded or not, as browsers
// and configuration files disagree about which they emit.
func decodeKey(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	b, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		return nil, errors.New("invalid base64")
	}
	return b, nil
}

func hostOf(endpoint string) string {
	if u, err := url.Parse(endpoint); err == nil && u.Host != "" {
		return u.Host
	}
	return "push service"
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 300 {
		s = s[:300] + "..."
	}
	if s == "" {
		return "(empty body)"
	}
	return s
}
