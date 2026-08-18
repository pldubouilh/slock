package password

import (
	"strings"
	"testing"
)

func TestHashVerifyRoundTrip(t *testing.T) {
	for _, pw := range []string{"correct horse battery staple", "sh0rt!", "  spaces  ",
		"unicode: héllo wörld 🔐", strings.Repeat("x", 256)} {
		encoded, err := Hash(pw)
		if err != nil {
			t.Fatalf("Hash(%q): %v", pw, err)
		}
		if !Verify(encoded, pw) {
			t.Errorf("Verify failed for %q", pw)
		}
		if Verify(encoded, pw+"x") {
			t.Errorf("Verify accepted a wrong password for %q", pw)
		}
	}
}

func TestHashIsSaltedPerCall(t *testing.T) {
	a, _ := Hash("same password")
	b, _ := Hash("same password")
	if a == b {
		t.Fatal("two hashes of the same password are identical: salt is not random")
	}
	if !Verify(a, "same password") || !Verify(b, "same password") {
		t.Fatal("both hashes must still verify")
	}
}

func TestEncodedFormat(t *testing.T) {
	encoded, err := Hash("whatever")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 {
		t.Fatalf("expected 4 fields, got %d: %q", len(parts), encoded)
	}
	if parts[0] != algorithm {
		t.Errorf("algorithm = %q, want %q", parts[0], algorithm)
	}
	salt, key, iter, err := parse(encoded)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if iter != Iterations {
		t.Errorf("iterations = %d, want %d", iter, Iterations)
	}
	if len(salt) != saltLen {
		t.Errorf("salt is %d bytes, want %d", len(salt), saltLen)
	}
	if len(key) != keyLen {
		t.Errorf("key is %d bytes, want %d", len(key), keyLen)
	}
}

func TestVerifyRejectsMalformed(t *testing.T) {
	// A corrupt or foreign value must never authenticate anyone, including the
	// bcrypt hashes an older build wrote.
	for _, bad := range []string{
		"", "$", "not-a-hash", "pbkdf2-sha256$600000$onlythree",
		"pbkdf2-sha256$0$AAAA$AAAA", "pbkdf2-sha256$abc$AAAA$AAAA",
		"pbkdf2-sha256$600000$!!!!$AAAA", "pbkdf2-sha256$600000$AAAA$!!!!",
		"pbkdf2-sha256$600000$$", "scrypt$600000$AAAA$AAAA",
		"$2a$10$.gJsK9Ql/vMcD1nWxLBGnewyaI/fIcA/Y..qxn/rfgWmF7g4Q1d1u",
	} {
		if Verify(bad, "anything") {
			t.Errorf("Verify accepted malformed hash %q", bad)
		}
	}
}

// The dummy exists to make a login for an unknown address cost the same as a
// real one. If Iterations moves and the constant does not, that breaks.
func TestDummyHashMatchesParameters(t *testing.T) {
	salt, key, iter, err := parse(DummyHash)
	if err != nil {
		t.Fatalf("DummyHash does not parse: %v", err)
	}
	if iter != Iterations {
		t.Errorf("DummyHash has %d iterations but Iterations is %d; regenerate it", iter, Iterations)
	}
	if len(salt) != saltLen || len(key) != keyLen {
		t.Errorf("DummyHash has salt %d/key %d, want %d/%d", len(salt), len(key), saltLen, keyLen)
	}
	if Verify(DummyHash, "") || Verify(DummyHash, "password") {
		t.Error("DummyHash must not verify against a guessable password")
	}
}
