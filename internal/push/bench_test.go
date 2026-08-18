package push

import (
	"crypto/ecdh"
	"crypto/rand"
	"testing"
	"time"
)

// What one notification actually costs in CPU: the RFC 8291 encryption and the
// RFC 8292 JWT signature. Everything else about a push is network.
func BenchmarkEncrypt(b *testing.B) {
	ua, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		b.Fatal(err)
	}
	auth := make([]byte, 16)
	rand.Read(auth)
	plaintext, err := marshalNotification(Notification{
		Title: "#general", Body: "Ana: the build is green", Tag: "channel-1",
		URL: "/?c=1", Badge: 7,
	})
	if err != nil {
		b.Fatal(err)
	}
	salt := make([]byte, saltLen)
	rand.Read(salt)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		as, err := ecdh.P256().GenerateKey(rand.Reader)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := encrypt(plaintext, ua.PublicKey().Bytes(), auth, as, salt); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkVAPIDAuthorization(b *testing.B) {
	pub, priv, err := GenerateKeys()
	if err != nil {
		b.Fatal(err)
	}
	p, err := New(pub, priv, "mailto:bench@example.com")
	if err != nil {
		b.Fatal(err)
	}
	now := time.Now()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := p.authorization("https://fcm.googleapis.com/fcm/send/abc", now); err != nil {
			b.Fatal(err)
		}
	}
}
