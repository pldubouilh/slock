package api

import (
	"reflect"
	"testing"
)

func TestMentionedUsers(t *testing.T) {
	users := []mentionCandidate{
		{ID: 1, DisplayName: "Bob"},
		{ID: 2, DisplayName: "Bob Smith"},
		{ID: 3, DisplayName: "Élodie"},
		{ID: 4, DisplayName: "ann"},
	}
	ids := func(body string) []int64 {
		var out []int64
		for _, u := range mentionedUsers(body, users) {
			out = append(out, u.ID)
		}
		return out
	}
	cases := []struct {
		body string
		want []int64
	}{
		{"hi @bob", []int64{1}},
		{"@Bob Smith look", []int64{2}},        // longest name wins
		{"@bobby hi", nil},                     // must end at a boundary
		{"mail bob@bob.com", nil},              // '@' must start a word
		{"(@ann) and @élodie!", []int64{4, 3}}, // brackets, case-folded accents
		{"@bob @Bob", []int64{1}},              // once each
		{"`@bob` and ```\n@ann\n```", nil},     // code is literal
		{"no mention", nil},
	}
	for _, c := range cases {
		if got := ids(c.body); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: got %v, want %v", c.body, got, c.want)
		}
	}
}
