package api

import (
	"strings"
	"testing"
)

func TestParseSearchQuery(t *testing.T) {
	cases := []struct {
		in                    string
		text, from, inChannel string
	}{
		{"pixel perfect", "pixel perfect", "", ""},
		{"from:@ana in:#design pixel", "pixel", "ana", "design"},
		{"from:ana in:design", "", "ana", "design"},
		{"deploy FROM:Bob notes", "deploy notes", "Bob", ""},
		{"in:#general", "", "", "general"},
		{"  spaced   out  ", "spaced out", "", ""},
		{"from:", "", "", ""},
		{`from:"Ana Lee"`, "", "Ana Lee", ""},
		{`"pixel perfect" from:ana`, `"pixel perfect"`, "ana", ""},
		{"release in:#ops from:@ana", "release", "ana", "ops"},
		{"in:one in:two", "", "", "two"},
	}
	for _, c := range cases {
		got := parseSearchQuery(c.in)
		if got.Text != c.text || got.From != c.from || got.Channel != c.inChannel {
			t.Errorf("parseSearchQuery(%q) = %+v, want text=%q from=%q in=%q",
				c.in, got, c.text, c.from, c.inChannel)
		}
	}
}

func TestPrefixTSQuery(t *testing.T) {
	cases := []struct{ in, want string }{
		{"anthropi", "anthropi:*"},
		{"pixel perfect", "pixel:* & perfect:*"},
		{`"quoted phrase"`, "quoted:* & phrase:*"},
		{"a & b | c:* !d", "a:* & b:* & c:* & d:*"},
		{"'; drop--", "drop:*"},
		{"&&& |||", ""},
		{"", ""},
		{"héllo wörld", "héllo:* & wörld:*"},
		// URLs / emails split into their parts so a piece like "research" matches.
		{"https://www.research.example.co.uk", "https:* & www:* & research:* & example:* & co:* & uk:*"},
		{"ana@example.com", "ana:* & example:* & com:*"},
	}
	for _, c := range cases {
		if got := prefixTSQuery(c.in); got != c.want {
			t.Errorf("prefixTSQuery(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSafeSnippet(t *testing.T) {
	in := `<script>alert(1)</script> a <mark>pixel</mark> & "more"`
	got := safeSnippet(in)
	if strings.Contains(got, "<script>") {
		t.Fatalf("snippet leaked a tag: %q", got)
	}
	if !strings.Contains(got, "<mark>pixel</mark>") {
		t.Fatalf("snippet lost its highlight: %q", got)
	}
	if !strings.Contains(got, "&amp;") {
		t.Fatalf("snippet did not escape ampersand: %q", got)
	}
}

func TestTruncateBody(t *testing.T) {
	if got := truncateBody("  hello   world "); got != "hello world" {
		t.Errorf("truncateBody = %q", got)
	}
	long := strings.Repeat("word ", 100)
	got := truncateBody(long)
	if len(got) > 210 {
		t.Errorf("truncateBody too long: %d", len(got))
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncateBody missing ellipsis: %q", got)
	}
}
