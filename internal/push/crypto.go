package push

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// aes128gcm record framing, RFC 8188 section 2.
const (
	saltLen    = 16
	keyIDLen   = 65 // an uncompressed P-256 point
	recordSize = 4096
	headerLen  = saltLen + 4 + 1 + keyIDLen
)

// vapidTTL is how long a signed JWT stays valid. RFC 8292 caps it at 24h.
const vapidTTL = 12 * time.Hour

// payloadBudget is how much JSON fits in a single record, once the header, the
// delimiter byte and the GCM tag are accounted for. Push services reject
// anything larger anyway.
const payloadBudget = recordSize - headerLen - 1 - 16

// marshalNotification serialises n and appends the aes128gcm delimiter that
// marks the last record (RFC 8188 section 2). A body too long for one record is
// truncated: a shortened preview beats a dropped notification.
func marshalNotification(n Notification) ([]byte, error) {
	payload, err := json.Marshal(n)
	if err != nil {
		return nil, err
	}
	for len(payload) > payloadBudget && n.Body != "" {
		n.Body = shorten(n.Body, len(payload)-payloadBudget+8)
		if payload, err = json.Marshal(n); err != nil {
			return nil, err
		}
	}
	if len(payload) > payloadBudget {
		return nil, errors.New("push: notification does not fit in one record")
	}
	return append(payload, 0x02), nil
}

// shorten drops at least n bytes from the end of s, stopping on a rune boundary
// and marking the cut with an ellipsis.
func shorten(s string, n int) string {
	if n >= len(s) {
		return ""
	}
	s = s[:len(s)-n]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return strings.TrimRight(s, " \n\t") + "…"
}

// encrypt builds one aes128gcm record for the subscriber, following RFC 8291.
// as and salt are parameters rather than locals so the RFC test vectors can be
// replayed; callers generate both freshly for every message.
func encrypt(plaintext, uaPublic, authSecret []byte, as *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	if len(salt) != saltLen {
		return nil, fmt.Errorf("push: salt is %d bytes, want %d", len(salt), saltLen)
	}
	uaKey, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("push: subscription p256dh: %w", err)
	}
	shared, err := as.ECDH(uaKey)
	if err != nil {
		return nil, fmt.Errorf("push: ecdh: %w", err)
	}
	asPublic := as.PublicKey().Bytes()

	ikm, err := deriveIKM(shared, authSecret, uaPublic, asPublic)
	if err != nil {
		return nil, err
	}
	cek, nonce, err := deriveKeys(ikm, salt)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	body := make([]byte, 0, headerLen+len(plaintext)+gcm.Overhead())
	body = append(body, salt...)
	body = binary.BigEndian.AppendUint32(body, recordSize)
	body = append(body, keyIDLen)
	body = append(body, asPublic...)
	return gcm.Seal(body, nonce, plaintext, nil), nil
}

// deriveIKM mixes the ECDH secret with the subscription's auth secret, binding
// both public keys into the info string (RFC 8291 section 3.3).
func deriveIKM(shared, authSecret, uaPublic, asPublic []byte) ([]byte, error) {
	info := make([]byte, 0, len("WebPush: info\x00")+2*keyIDLen)
	info = append(info, "WebPush: info\x00"...)
	info = append(info, uaPublic...)
	info = append(info, asPublic...)
	return hkdf.Key(sha256.New, shared, authSecret, string(info), 32)
}

// deriveKeys expands the input keying material into the aes128gcm content
// encryption key and nonce for one record (RFC 8188 section 2.2).
func deriveKeys(ikm, salt []byte) (cek, nonce []byte, err error) {
	if cek, err = hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16); err != nil {
		return nil, nil, err
	}
	if nonce, err = hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12); err != nil {
		return nil, nil, err
	}
	return cek, nonce, nil
}

// authorization builds the RFC 8292 "vapid" Authorization header value for the
// origin of endpoint.
func (p *Pusher) authorization(endpoint string, now time.Time) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("push: endpoint: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("push: endpoint %q is not an absolute URL", endpoint)
	}
	jwt, err := p.signJWT(u.Scheme+"://"+u.Host, now)
	if err != nil {
		return "", err
	}
	return "vapid t=" + jwt + ", k=" + p.publicKey, nil
}

type jwtHeader struct {
	Typ string `json:"typ"`
	Alg string `json:"alg"`
}

type jwtClaims struct {
	Aud string `json:"aud"`
	Exp int64  `json:"exp"`
	Sub string `json:"sub"`
}

// signJWT returns an ES256 JWT for aud, signed with the VAPID private key. The
// signature is the raw r||s pair, not the ASN.1 form SignASN1 produces.
func (p *Pusher) signJWT(aud string, now time.Time) (string, error) {
	header, err := json.Marshal(jwtHeader{Typ: "JWT", Alg: "ES256"})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(jwtClaims{Aud: aud, Exp: now.Add(vapidTTL).Unix(), Sub: p.subject})
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	signing := enc.EncodeToString(header) + "." + enc.EncodeToString(claims)

	sum := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(rand.Reader, p.signKey, sum[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signing + "." + enc.EncodeToString(sig), nil
}
