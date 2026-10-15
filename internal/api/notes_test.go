package api

import "testing"

func TestNormalizeNoteName(t *testing.T) {
	for in, want := range map[string]string{
		"  Meeting   notes ": "Meeting notes",
		"Line\nbreak":        "Line break",
		"Été 2026 — plans":   "Été 2026 — plans",
	} {
		if got, err := normalizeNoteName(in); err != nil || got != want {
			t.Errorf("normalizeNoteName(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", string(make([]rune, 81))} {
		if _, err := normalizeNoteName(in); err == nil {
			t.Errorf("normalizeNoteName(%q) accepted", in)
		}
	}
}
