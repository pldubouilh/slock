package api

import (
	"strings"
	"testing"
)

func TestNormalizeChannelName(t *testing.T) {
	ok := []struct{ in, want string }{
		{"design", "design"},
		{"  Design Team  ", "design-team"},
		{"#general", "general"},
		{"Product/Marketing", "productmarketing"},
		{"héllo", "hllo"},
		{"-lead-", "lead"},
		{"a_b-1", "a_b-1"},
		{"Two\tTabs", "two-tabs"},
	}
	for _, c := range ok {
		got, err := normalizeChannelName(c.in)
		if err != nil {
			t.Errorf("normalizeChannelName(%q) errored: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("normalizeChannelName(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	bad := []string{"", "   ", "***", "----", strings.Repeat("a", maxChannelNameLen+1)}
	for _, in := range bad {
		if got, err := normalizeChannelName(in); err == nil {
			t.Errorf("normalizeChannelName(%q) = %q, want error", in, got)
		}
	}
}

func TestDMKey(t *testing.T) {
	cases := []struct {
		a, b int64
		want string
	}{
		{3, 7, "3:7"},
		{7, 3, "3:7"},
		{5, 5, "5:5"},
		{1, 20, "1:20"},
	}
	for _, c := range cases {
		if got := dmKey(c.a, c.b); got != c.want {
			t.Errorf("dmKey(%d,%d) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}

func TestSanitizeFilename(t *testing.T) {
	cases := []struct{ in, want string }{
		{"shot.png", "shot.png"},
		{"../../etc/passwd", "passwd"},
		{`C:\Users\me\report.pdf`, "report.pdf"},
		{"", "file"},
		{"   ", "file"},
		{"..", "file"},
		{"with\x00null.txt", "withnull.txt"},
	}
	for _, c := range cases {
		if got := sanitizeFilename(c.in); got != c.want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	long := make([]byte, 300)
	for i := range long {
		long[i] = 'a'
	}
	if got := sanitizeFilename(string(long) + ".png"); len(got) > maxFilenameBytes {
		t.Errorf("sanitizeFilename did not cap length: %d", len(got))
	}
}

func TestContentDisposition(t *testing.T) {
	if got, want := contentDisposition("shot.png"), `attachment; filename="shot.png"`; got != want {
		t.Errorf("contentDisposition = %q, want %q", got, want)
	}
	got := contentDisposition("naïve.pdf")
	want := `attachment; filename="na_ve.pdf"; filename*=UTF-8''na%C3%AFve.pdf`
	if got != want {
		t.Errorf("contentDisposition = %q, want %q", got, want)
	}
	if got := contentDisposition(`ev"il.txt`); got != `attachment; filename="ev_il.txt"; filename*=UTF-8''ev%22il.txt` {
		t.Errorf("quote not neutralised: %q", got)
	}
}
