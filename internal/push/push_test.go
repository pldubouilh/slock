package push

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func b64d(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func b64e(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// RFC 8291 section 5, "Push Message Encryption Example".
const (
	rfcUAPublic   = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
	rfcUAPrivate  = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
	rfcAuthSecret = "BTBZMqHH6r4Tts7J_aSIgg"
	rfcASPublic   = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
	rfcASPrivate  = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
	rfcSalt       = "DGv6ra1nlYgDCS1FRnbzlw"
	rfcECDHSecret = "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"
	rfcIKM        = "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg"
	rfcCEK        = "oIhVW04MRdy2XN9CiKLxTg"
	rfcNonce      = "4h_95klXJ5E_qnoN"
	rfcPlaintext  = "When I grow up, I want to be a watermelon"
	rfcRecordSize = 4096
)

// TestRFC8291Derivation replays the worked example from RFC 8291 section 5 and
// checks every intermediate value the spec publishes.
func TestRFC8291Derivation(t *testing.T) {
	as, err := ecdh.P256().NewPrivateKey(b64d(t, rfcASPrivate))
	if err != nil {
		t.Fatal(err)
	}
	ua, err := ecdh.P256().NewPrivateKey(b64d(t, rfcUAPrivate))
	if err != nil {
		t.Fatal(err)
	}
	if got := b64e(as.PublicKey().Bytes()); got != rfcASPublic {
		t.Errorf("as public = %s", got)
	}
	if got := b64e(ua.PublicKey().Bytes()); got != rfcUAPublic {
		t.Errorf("ua public = %s", got)
	}

	shared, err := as.ECDH(ua.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	if got := b64e(shared); got != rfcECDHSecret {
		t.Errorf("ecdh_secret = %s, want %s", got, rfcECDHSecret)
	}

	ikm, err := deriveIKM(shared, b64d(t, rfcAuthSecret), b64d(t, rfcUAPublic), b64d(t, rfcASPublic))
	if err != nil {
		t.Fatal(err)
	}
	if got := b64e(ikm); got != rfcIKM {
		t.Errorf("IKM = %s, want %s", got, rfcIKM)
	}

	cek, nonce, err := deriveKeys(ikm, b64d(t, rfcSalt))
	if err != nil {
		t.Fatal(err)
	}
	if got := b64e(cek); got != rfcCEK {
		t.Errorf("CEK = %s, want %s", got, rfcCEK)
	}
	if got := b64e(nonce); got != rfcNonce {
		t.Errorf("NONCE = %s, want %s", got, rfcNonce)
	}
}

// TestRFC8291Record encrypts the RFC's plaintext with the RFC's key material
// and checks the record decrypts under the published CEK and nonce.
func TestRFC8291Record(t *testing.T) {
	as, err := ecdh.P256().NewPrivateKey(b64d(t, rfcASPrivate))
	if err != nil {
		t.Fatal(err)
	}
	body, err := encrypt([]byte(rfcPlaintext+"\x02"), b64d(t, rfcUAPublic), b64d(t, rfcAuthSecret), as, b64d(t, rfcSalt))
	if err != nil {
		t.Fatal(err)
	}
	salt, rs, keyID, ciphertext := parseRecord(t, body)
	if b64e(salt) != rfcSalt {
		t.Errorf("salt = %s", b64e(salt))
	}
	if rs != rfcRecordSize {
		t.Errorf("rs = %d", rs)
	}
	if b64e(keyID) != rfcASPublic {
		t.Errorf("keyid = %s", b64e(keyID))
	}

	block, err := aes.NewCipher(b64d(t, rfcCEK))
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	got, err := gcm.Open(nil, b64d(t, rfcNonce), ciphertext, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != rfcPlaintext+"\x02" {
		t.Errorf("plaintext = %q", got)
	}
}

// parseRecord splits an aes128gcm body into its header fields and ciphertext.
func parseRecord(t *testing.T, body []byte) (salt []byte, rs uint32, keyID, ciphertext []byte) {
	t.Helper()
	if len(body) < headerLen {
		t.Fatalf("body is %d bytes, shorter than the header", len(body))
	}
	salt = body[:saltLen]
	rs = binary.BigEndian.Uint32(body[saltLen : saltLen+4])
	idlen := int(body[saltLen+4])
	if idlen != keyIDLen {
		t.Fatalf("idlen = %d, want %d", idlen, keyIDLen)
	}
	keyID = body[saltLen+5 : saltLen+5+idlen]
	return salt, rs, keyID, body[headerLen:]
}

// TestEncryptRoundTrip decrypts a freshly generated record the way a browser
// would: derive the shared secret from the subscription private key.
func TestEncryptRoundTrip(t *testing.T) {
	ua, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	authSecret := make([]byte, 16)
	if _, err := rand.Read(authSecret); err != nil {
		t.Fatal(err)
	}
	as, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		t.Fatal(err)
	}

	want := Notification{Title: "Ana", Body: "hey there", Tag: "c12", URL: "/?c=12", Badge: 3}
	plaintext, err := marshalNotification(want)
	if err != nil {
		t.Fatal(err)
	}
	body, err := encrypt(plaintext, ua.PublicKey().Bytes(), authSecret, as, salt)
	if err != nil {
		t.Fatal(err)
	}
	_, _, keyID, ciphertext := parseRecord(t, body)

	asPub, err := ecdh.P256().NewPublicKey(keyID)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := ua.ECDH(asPub)
	if err != nil {
		t.Fatal(err)
	}
	ikm, err := deriveIKM(shared, authSecret, ua.PublicKey().Bytes(), keyID)
	if err != nil {
		t.Fatal(err)
	}
	cek, nonce, err := deriveKeys(ikm, salt)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	got, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || got[len(got)-1] != 0x02 {
		t.Fatalf("missing padding delimiter: %q", got)
	}
	var back Notification
	if err := json.Unmarshal(got[:len(got)-1], &back); err != nil {
		t.Fatal(err)
	}
	if back != want {
		t.Errorf("round trip = %+v, want %+v", back, want)
	}
}

func newPusher(t *testing.T) *Pusher {
	t.Helper()
	pub, priv, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	p, err := New(pub, priv, "mailto:admin@example.com")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestKeyRoundTrip(t *testing.T) {
	pub, priv, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	if len(b64d(t, pub)) != 65 || b64d(t, pub)[0] != 4 {
		t.Errorf("public key is not an uncompressed point: %s", pub)
	}
	if len(b64d(t, priv)) != 32 {
		t.Errorf("private key is not 32 bytes: %s", priv)
	}
	if strings.ContainsAny(pub+priv, "+/=") {
		t.Errorf("keys are not raw base64url: %s %s", pub, priv)
	}
	p, err := New(pub, priv, "mailto:a@b.c")
	if err != nil {
		t.Fatal(err)
	}
	if !p.Enabled() || p.PublicKey() != pub {
		t.Errorf("PublicKey = %q, want %q", p.PublicKey(), pub)
	}
}

func TestNewDisabled(t *testing.T) {
	p, err := New("", "", "mailto:a@b.c")
	if err != nil {
		t.Fatalf("an unconfigured deployment must still boot: %v", err)
	}
	if p == nil || p.Enabled() || p.PublicKey() != "" {
		t.Errorf("want a disabled pusher, got %+v", p)
	}
	if err := p.Send(context.Background(), Subscription{Endpoint: "https://x/y", P256DH: "a", Auth: "b"}, Notification{}); err == nil {
		t.Error("Send on a disabled pusher should fail")
	}
	var zero *Pusher
	if zero.Enabled() || zero.PublicKey() != "" {
		t.Error("nil pusher must be disabled")
	}
}

func TestNewRejectsMismatchedKeys(t *testing.T) {
	pub, _, _ := GenerateKeys()
	_, priv2, _ := GenerateKeys()
	if _, err := New(pub, priv2, "mailto:a@b.c"); err == nil {
		t.Error("mismatched keypair accepted")
	}
	if _, err := New(pub, "!!!not base64!!!", "mailto:a@b.c"); err == nil {
		t.Error("garbage private key accepted")
	}
	if _, err := New(pub, b64e([]byte("short")), "mailto:a@b.c"); err == nil {
		t.Error("short private key accepted")
	}
}

func TestDecodeKeyAcceptsEveryFlavour(t *testing.T) {
	raw := []byte{0xfb, 0xff, 0x3e, 0x00, 0x01}
	for _, s := range []string{
		base64.RawURLEncoding.EncodeToString(raw),
		base64.URLEncoding.EncodeToString(raw),
		base64.StdEncoding.EncodeToString(raw),
		base64.RawStdEncoding.EncodeToString(raw),
		"  " + base64.URLEncoding.EncodeToString(raw) + "  ",
	} {
		got, err := decodeKey(s)
		if err != nil {
			t.Errorf("decodeKey(%q): %v", s, err)
			continue
		}
		if string(got) != string(raw) {
			t.Errorf("decodeKey(%q) = %x", s, got)
		}
	}
	if _, err := decodeKey("not base64 at all !!"); err == nil {
		t.Error("garbage accepted")
	}
}

// TestVAPIDHeader checks the JWT structure and verifies the raw r||s signature
// with the advertised public key, which is exactly what a push service does.
func TestVAPIDHeader(t *testing.T) {
	p := newPusher(t)
	now := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	auth, err := p.authorization("https://fcm.googleapis.com/fcm/send/abc123?x=1", now)
	if err != nil {
		t.Fatal(err)
	}
	scheme, rest, ok := strings.Cut(auth, " ")
	if !ok || scheme != "vapid" {
		t.Fatalf("authorization = %q", auth)
	}
	tokenPart, keyPart, ok := strings.Cut(rest, ", ")
	if !ok || !strings.HasPrefix(tokenPart, "t=") || !strings.HasPrefix(keyPart, "k=") {
		t.Fatalf("authorization = %q", auth)
	}
	if got := strings.TrimPrefix(keyPart, "k="); got != p.PublicKey() {
		t.Errorf("k = %q, want %q", got, p.PublicKey())
	}

	parts := strings.Split(strings.TrimPrefix(tokenPart, "t="), ".")
	if len(parts) != 3 {
		t.Fatalf("jwt has %d parts", len(parts))
	}
	var hdr jwtHeader
	if err := json.Unmarshal(b64d(t, parts[0]), &hdr); err != nil {
		t.Fatal(err)
	}
	if hdr.Typ != "JWT" || hdr.Alg != "ES256" {
		t.Errorf("header = %+v", hdr)
	}
	var claims jwtClaims
	if err := json.Unmarshal(b64d(t, parts[1]), &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Aud != "https://fcm.googleapis.com" {
		t.Errorf("aud = %q, want the endpoint origin only", claims.Aud)
	}
	if claims.Sub != "mailto:admin@example.com" {
		t.Errorf("sub = %q", claims.Sub)
	}
	if want := now.Add(12 * time.Hour).Unix(); claims.Exp != want {
		t.Errorf("exp = %d, want %d", claims.Exp, want)
	}

	sig := b64d(t, parts[2])
	if len(sig) != 64 {
		t.Fatalf("signature is %d bytes, want a raw 64-byte r||s pair", len(sig))
	}
	pubKey, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), b64d(t, p.PublicKey()))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(pubKey, sum[:], r, s) {
		t.Error("signature does not verify against the VAPID public key")
	}
}

func TestAuthorizationRejectsBadEndpoint(t *testing.T) {
	p := newPusher(t)
	for _, endpoint := range []string{"", "/relative/path", "not a url"} {
		if _, err := p.authorization(endpoint, time.Now()); err == nil {
			t.Errorf("authorization(%q) accepted", endpoint)
		}
	}
}

// testSubscription builds a subscription whose keys a test server could
// actually decrypt.
func testSubscription(t *testing.T, endpoint string) Subscription {
	t.Helper()
	ua, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	return Subscription{
		Endpoint: endpoint,
		P256DH:   base64.URLEncoding.EncodeToString(ua.PublicKey().Bytes()), // padded, as Chrome sends
		Auth:     b64e(auth),
	}
}

func TestSendRequestShape(t *testing.T) {
	var got *http.Request
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		body, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	p := newPusher(t)
	sub := testSubscription(t, srv.URL+"/push/xyz")
	if err := p.Send(context.Background(), sub, Notification{Title: "Ana", Body: "hi", Badge: 2}); err != nil {
		t.Fatal(err)
	}
	if got.Method != http.MethodPost {
		t.Errorf("method = %s", got.Method)
	}
	for k, want := range map[string]string{
		"Content-Encoding": "aes128gcm",
		"Content-Type":     "application/octet-stream",
		"TTL":              "86400",
	} {
		if v := got.Header.Get(k); v != want {
			t.Errorf("%s = %q, want %q", k, v, want)
		}
	}
	if !strings.HasPrefix(got.Header.Get("Authorization"), "vapid t=") {
		t.Errorf("authorization = %q", got.Header.Get("Authorization"))
	}
	if got.ContentLength != int64(len(body)) {
		t.Errorf("Content-Length = %d, body = %d", got.ContentLength, len(body))
	}
	if len(body) <= headerLen {
		t.Fatalf("body is %d bytes", len(body))
	}
	if int(body[saltLen+4]) != keyIDLen {
		t.Errorf("idlen = %d", body[saltLen+4])
	}
	if rs := binary.BigEndian.Uint32(body[saltLen : saltLen+4]); rs != recordSize {
		t.Errorf("rs = %d", rs)
	}
}

func TestSendStatusHandling(t *testing.T) {
	cases := []struct {
		status  int
		wantErr string // "" = success, "gone" = ErrGone, otherwise a substring
	}{
		{http.StatusCreated, ""},
		{http.StatusOK, ""},
		{http.StatusNoContent, ""},
		{http.StatusNotFound, "gone"},
		{http.StatusGone, "gone"},
		{http.StatusTooManyRequests, "rate limited"},
		{http.StatusInternalServerError, "unavailable"},
		{http.StatusBadRequest, "rejected"},
	}
	p := newPusher(t)
	for _, tc := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			w.Write([]byte("  detail from   the service \n"))
		}))
		err := p.Send(context.Background(), testSubscription(t, srv.URL), Notification{Title: "x"})
		srv.Close()
		switch {
		case tc.wantErr == "":
			if err != nil {
				t.Errorf("%d: %v", tc.status, err)
			}
		case tc.wantErr == "gone":
			if !errors.Is(err, ErrGone) {
				t.Errorf("%d: err = %v, want ErrGone", tc.status, err)
			}
		default:
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("%d: err = %v, want it to mention %q", tc.status, err, tc.wantErr)
			}
			if err != nil && !strings.Contains(err.Error(), "detail from the service") {
				t.Errorf("%d: error should quote the response body: %v", tc.status, err)
			}
		}
	}
}

func TestSendRejectsIncompleteSubscription(t *testing.T) {
	p := newPusher(t)
	subs := []Subscription{
		{Endpoint: "https://x/y", P256DH: "abc"},
		{P256DH: "abc", Auth: "def"},
		{Endpoint: "https://x/y", P256DH: "!!!", Auth: b64e([]byte("0123456789abcdef"))},
	}
	for _, sub := range subs {
		if err := p.Send(context.Background(), sub, Notification{}); err == nil {
			t.Errorf("Send(%+v) accepted", sub)
		}
	}
}

func TestSendHonoursContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p := newPusher(t)
	if err := p.Send(ctx, testSubscription(t, srv.URL), Notification{}); err == nil {
		t.Error("cancelled context should fail")
	}
}

// A body longer than one aes128gcm record is truncated rather than dropped.
func TestMarshalNotificationTruncates(t *testing.T) {
	long := strings.Repeat("a", 6000) + "é"
	payload, err := marshalNotification(Notification{Title: "Ana", Body: long, URL: "/?c=1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) > payloadBudget+1 {
		t.Fatalf("payload is %d bytes, budget is %d", len(payload), payloadBudget)
	}
	var n Notification
	if err := json.Unmarshal(payload[:len(payload)-1], &n); err != nil {
		t.Fatal(err)
	}
	if n.Title != "Ana" || n.URL != "/?c=1" {
		t.Errorf("truncation lost a field: %+v", n)
	}
	if !strings.HasPrefix(n.Body, "aaaa") || !strings.HasSuffix(n.Body, "…") {
		t.Errorf("body = %.20q...%q", n.Body, n.Body[max(0, len(n.Body)-8):])
	}
	if !utf8.ValidString(n.Body) {
		t.Error("truncation cut a rune in half")
	}

	// A short notification is left exactly as it is.
	short := Notification{Title: "Ana", Body: "hi", Tag: "c1"}
	payload, err = marshalNotification(short)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload[:len(payload)-1], &n); err != nil {
		t.Fatal(err)
	}
	if n != short {
		t.Errorf("payload = %+v, want %+v", n, short)
	}
}
