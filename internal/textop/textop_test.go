package textop

import (
	"encoding/json"
	"math/rand"
	"strings"
	"testing"
)

func parse(t *testing.T, s string) *Op {
	t.Helper()
	var o Op
	if err := json.Unmarshal([]byte(s), &o); err != nil {
		t.Fatalf("parse %s: %v", s, err)
	}
	return &o
}

func TestJSONRoundTripNormalises(t *testing.T) {
	o := parse(t, `[2, 3, -1, "a", "b", -2, 4]`)
	b, _ := json.Marshal(o)
	if got, want := string(b), `[5,"ab",-3,4]`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	if o.BaseLen() != 12 || o.TargetLen() != 11 {
		t.Fatalf("lengths %d→%d", o.BaseLen(), o.TargetLen())
	}
}

func TestApply(t *testing.T) {
	got, err := parse(t, `[6, -5, "there", 1]`).Apply("hello world!")
	if err != nil || got != "hello there!" {
		t.Fatalf("got %q, %v", got, err)
	}
	// Positions count UTF-16 units: the emoji is two.
	got, err = parse(t, `[3, "!"]`).Apply("a😀")
	if err != nil || got != "a😀!" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := parse(t, `[3]`).Apply("ab"); err == nil {
		t.Fatal("length mismatch accepted")
	}
}

func TestTransformSameSpotInsert(t *testing.T) {
	a := parse(t, `[2, "A", 2]`)
	b := parse(t, `[2, "B", 2]`)
	a2, b2, err := Transform(a, b)
	if err != nil {
		t.Fatal(err)
	}
	x, _ := a.Apply("abcd")
	x, _ = b2.Apply(x)
	y, _ := b.Apply("abcd")
	y, _ = a2.Apply(y)
	if x != y || x != "abABcd" {
		t.Fatalf("a·b2=%q b·a2=%q", x, y)
	}
}

// randomOp makes an arbitrary edit of doc.
func randomOp(r *rand.Rand, doc string) *Op {
	n := Len16(doc)
	o := &Op{}
	for i := 0; i < n; {
		k := 1 + r.Intn(n-i)
		switch r.Intn(3) {
		case 0:
			o.Retain(k)
		case 1:
			o.Delete(k)
		default:
			o.Insert(strings.Repeat(string(rune('a'+r.Intn(26))), 1+r.Intn(3)))
			continue
		}
		i += k
	}
	if r.Intn(2) == 0 {
		o.Insert("Z")
	}
	return o
}

func TestTransformConverges(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 2000; i++ {
		doc := strings.Repeat("x", r.Intn(12))
		a, b := randomOp(r, doc), randomOp(r, doc)
		a2, b2, err := Transform(a, b)
		if err != nil {
			t.Fatal(err)
		}
		x, err1 := a.Apply(doc)
		x, err2 := b2.Apply(x)
		y, err3 := b.Apply(doc)
		y, err4 := a2.Apply(y)
		if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
			t.Fatalf("apply failed: %v %v %v %v", err1, err2, err3, err4)
		}
		if x != y {
			ja, _ := json.Marshal(a)
			jb, _ := json.Marshal(b)
			t.Fatalf("diverged on %q with a=%s b=%s: %q vs %q", doc, ja, jb, x, y)
		}
	}
}
