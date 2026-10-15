package api

import (
	"context"
	"html"
	"strconv"
	"strings"
	"time"
	"unicode"

	"slock/internal/db"
)

// noteHit is a note whose text holds every searched word. At and Len place the
// first match in the text (UTF-16 units, as the editor counts), so the client
// can open the note on it.
type noteHit struct {
	ChannelID int64     `json:"channel_id"`
	Name      string    `json:"name"`
	UpdatedAt time.Time `json:"updated_at"`
	Snippet   string    `json:"snippet"` // escaped, matches in <mark>
	At        int       `json:"at"`
	Len       int       `json:"len"`
}

const noteHitsMax = 5

// noteSearchWords are the words a note must contain, lowercased: the free
// text of the query, quotes dropped. Notes are matched by plain substring,
// not the messages' full-text index — few enough to scan, and their text can
// outgrow what a tsvector holds.
func noteSearchWords(text string) []string {
	var out []string
	for _, w := range strings.Fields(strings.ReplaceAll(text, `"`, " ")) {
		out = append(out, strings.ToLower(w))
		if len(out) == 8 {
			break
		}
	}
	return out
}

// likeEscape makes s match itself in an ILIKE pattern (backslash escapes).
func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// searchNotes finds the notes visible to me (theirs, or public ones for a user
// without an allowlist) whose text contains every word.
func (s *Server) searchNotes(ctx context.Context, me *db.User, words []string) ([]noteHit, error) {
	hits := []noteHit{}
	if len(words) == 0 {
		return hits, nil
	}
	args := []any{me.ID, unrestricted(me)}
	var conds []string
	for _, w := range words {
		args = append(args, "%"+likeEscape(w)+"%")
		conds = append(conds, "n.body ILIKE $"+strconv.Itoa(len(args)))
	}
	rows, err := s.DB.Pool.Query(ctx, `
		SELECT c.id, c.name, n.body, n.updated_at
		  FROM channels c
		  JOIN notes n ON n.channel_id = c.id
		 WHERE c.kind = 'note'
		   AND (EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1)
		        OR (NOT c.is_private AND $2))
		   AND `+strings.Join(conds, " AND ")+`
		 ORDER BY n.updated_at DESC
		 LIMIT `+strconv.Itoa(noteHitsMax), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var h noteHit
		var body string
		if err := rows.Scan(&h.ChannelID, &h.Name, &body, &h.UpdatedAt); err != nil {
			return nil, err
		}
		snip, at, n, ok := noteSnippet(body, words)
		if !ok {
			continue // ILIKE folds case a little differently; trust the snippet's view
		}
		h.Snippet, h.At, h.Len = snip, at, n
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// noteSnippet cuts the text around the earliest match of any word, collapses
// its whitespace and marks every match in it. at/n are that first match in
// UTF-16 units. ok is false unless every word occurs.
func noteSnippet(body string, words []string) (snippet string, at, n int, ok bool) {
	const before, after = 60, 140
	text := []rune(body)
	lower := make([]rune, len(text))
	for i, r := range text {
		lower[i] = unicode.ToLower(r)
	}
	pats := make([][]rune, 0, len(words))
	first, firstLen := -1, 0
	for _, w := range words {
		p := []rune(w)
		i := runeIndex(lower, p, 0)
		if i < 0 {
			return "", 0, 0, false
		}
		if first < 0 || i < first {
			first, firstLen = i, len(p)
		}
		pats = append(pats, p)
	}
	a := max(0, first-before)
	b := min(len(text), first+firstLen+after)
	hit := make([]bool, b-a)
	for _, p := range pats {
		for i := runeIndex(lower[:b], p, a); i >= 0; i = runeIndex(lower[:b], p, i+1) {
			for k := i; k < i+len(p) && k < b; k++ {
				hit[k-a] = true
			}
		}
	}
	var sb strings.Builder
	if a > 0 {
		sb.WriteString("…")
	}
	space := false
	for i := a; i < b; i++ {
		on := hit[i-a]
		if on && (i == a || !hit[i-a-1]) {
			sb.WriteString("<mark>")
		}
		if unicode.IsSpace(text[i]) {
			if !space && i > a {
				sb.WriteByte(' ')
			}
			space = true
		} else {
			sb.WriteString(html.EscapeString(string(text[i])))
			space = false
		}
		if on && (i == b-1 || !hit[i-a+1]) {
			sb.WriteString("</mark>")
		}
	}
	if b < len(text) {
		sb.WriteString("…")
	}
	return sb.String(), utf16Len(text[:first]), utf16Len(text[first : first+firstLen]), true
}

// runeIndex is the first index ≥ from where p occurs in s, or -1.
func runeIndex(s, p []rune, from int) int {
	if len(p) == 0 {
		return -1
	}
outer:
	for i := from; i+len(p) <= len(s); i++ {
		for k, r := range p {
			if s[i+k] != r {
				continue outer
			}
		}
		return i
	}
	return -1
}

func utf16Len(rs []rune) int {
	n := 0
	for _, r := range rs {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}
