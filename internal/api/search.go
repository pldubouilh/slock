package api

import (
	"html"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"slock/internal/db"
	"slock/internal/httpx"
)

// searchQuery is a parsed `q`: the free-text part plus the from:/in: filters.
type searchQuery struct {
	Text    string
	From    string // display name, without the leading @
	Channel string // channel name, without the leading #
}

// parseSearchQuery pulls `from:` and `in:` filters out of the query wherever
// they appear; everything else is free text. A leading @ or # on the value is
// optional. The last occurrence of a filter wins.
func parseSearchQuery(q string) searchQuery {
	var out searchQuery
	var words []string
	for _, tok := range tokenizeQuery(q) {
		lower := strings.ToLower(tok)
		switch {
		case strings.HasPrefix(lower, "from:"):
			if v := cleanFilterValue(tok[len("from:"):]); v != "" {
				out.From = v
			}
		case strings.HasPrefix(lower, "in:"):
			if v := cleanFilterValue(tok[len("in:"):]); v != "" {
				out.Channel = v
			}
		default:
			words = append(words, tok)
		}
	}
	out.Text = strings.Join(words, " ")
	return out
}

// tokenizeQuery splits on whitespace but keeps a double-quoted run together so
// `from:"Ana Lee"` stays one token. Quotes are left on free-text tokens:
// websearch_to_tsquery reads them as a phrase.
func tokenizeQuery(q string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	for _, r := range q {
		switch {
		case r == '"':
			inQuote = !inQuote
			cur.WriteRune(r)
		case unicode.IsSpace(r) && !inQuote:
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return out
}

// cleanFilterValue strips the sigil and any wrapping quotes from a filter value.
func cleanFilterValue(v string) string {
	v = strings.Trim(v, `"'`)
	v = strings.TrimPrefix(v, "@")
	v = strings.TrimPrefix(v, "#")
	return strings.TrimSpace(v)
}

// prefixTSQuery renders the free text as a to_tsquery input where every word
// matches by prefix (`anthropi:*` finds "anthropic"). Splitting on any
// non-alphanumeric run (not just whitespace) breaks dotted/slashed strings —
// URLs, emails, identifiers — into their parts, so "research" or the whole
// "www.research.example.co.uk" both match. Nothing the tsquery parser cares about
// survives; phrases/or/negation are the websearch arm's job.
func prefixTSQuery(text string) string {
	const maxTerms = 8
	notWord := func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }
	var terms []string
	for _, w := range strings.FieldsFunc(text, notWord) {
		terms = append(terms, w+":*")
		if len(terms) == maxTerms {
			break
		}
	}
	return strings.Join(terms, " & ")
}

// headlineOptions keeps the snippet to a single short fragment.
const headlineOptions = "StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MaxWords=18,MinWords=5"

// safeSnippet makes a ts_headline result safe to hand to innerHTML: escape the
// whole string, then bring back only the <mark> tags we asked Postgres for.
// ts_headline does not escape the body, so this has to happen in Go.
func safeSnippet(headline string) string {
	escaped := html.EscapeString(headline)
	escaped = strings.ReplaceAll(escaped, "&lt;mark&gt;", "<mark>")
	escaped = strings.ReplaceAll(escaped, "&lt;/mark&gt;", "</mark>")
	return escaped
}

// truncateBody shortens a plain body used as a snippet when there is no text
// query to highlight.
func truncateBody(body string) string {
	const max = 200
	body = strings.Join(strings.Fields(body), " ")
	if len(body) <= max {
		return body
	}
	cut := body[:max]
	if i := strings.LastIndexByte(cut, ' '); i > max/2 {
		cut = cut[:i]
	}
	return cut + "…"
}

// handleSearch parses from:/in: filters plus free text and runs a full-text
// query scoped to channels the caller may read. See docs/API.md § Search.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	q := parseSearchQuery(r.URL.Query().Get("q"))
	limit := httpx.Clamp(httpx.QueryInt(r, "limit", 30), 1, 100)

	if q.Text == "" && q.From == "" && q.Channel == "" {
		httpx.JSON(w, http.StatusOK, map[string]any{"results": []db.SearchResult{}})
		return nil
	}

	// Placeholders are built programmatically; no user input is ever pasted
	// into the SQL text.
	args := []any{me.ID}
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}

	var where []string
	where = append(where, "m.deleted_at IS NULL")
	where = append(where, `(c.kind = 'channel' AND NOT c.is_private
	                        OR EXISTS (SELECT 1 FROM channel_members cm
	                                    WHERE cm.channel_id = m.channel_id AND cm.user_id = $1))`)

	snippet := "left(m.body, 400)"
	if q.Text != "" {
		p := arg(q.Text)
		// websearch keeps phrases/or/negation working; the OR'd prefix arm
		// makes partially-typed words match ("anthropi" finds "anthropic").
		// The prefix arm uses the simple config on both sides: the tsvector
		// stores unstemmed lexemes alongside the english ones (0004), and
		// stemming the query here would shorten the very prefix being typed.
		tsq := "websearch_to_tsquery('english', " + p + ")"
		if pre := prefixTSQuery(q.Text); pre != "" {
			tsq = "(" + tsq + " || to_tsquery('simple', " + arg(pre) + "))"
		}
		where = append(where, "m.search_tsv @@ "+tsq)
		snippet = "ts_headline('english', m.body, " + tsq + ", " + arg(headlineOptions) + ")"
	}
	if q.From != "" {
		where = append(where, "lower(u.display_name) = lower("+arg(q.From)+")")
	}
	if q.Channel != "" {
		where = append(where, "lower(c.name) = lower("+arg(q.Channel)+")")
	}

	sql := `SELECT ` + messageCols + `, c.name, c.kind, u.display_name, ` + snippet + `
	          FROM messages m
	          JOIN channels c ON c.id = m.channel_id
	          JOIN users u ON u.id = m.user_id
	         WHERE ` + strings.Join(where, " AND ") + `
	         ORDER BY m.id DESC LIMIT ` + arg(limit)

	rows, err := s.DB.Pool.Query(r.Context(), sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	results := []db.SearchResult{}
	msgs := []db.Message{}
	for rows.Next() {
		var (
			m   db.Message
			res db.SearchResult
			raw string
		)
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Body, &m.CreatedAt, &m.EditedAt,
			&m.DeletedAt, &res.ChannelName, &res.ChannelKind, &res.UserName, &raw); err != nil {
			return err
		}
		m.Attachments = []db.Attachment{}
		m.Reactions = []db.Reaction{}
		res.ChannelID = m.ChannelID
		res.UserID = m.UserID
		if q.Text != "" {
			res.Snippet = safeSnippet(raw)
		} else {
			res.Snippet = html.EscapeString(truncateBody(raw))
		}
		msgs = append(msgs, m)
		results = append(results, res)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	if err := s.hydrate(r.Context(), msgs, me.ID); err != nil {
		return err
	}
	for i := range results {
		results[i].Message = msgs[i]
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"results": results})
	return nil
}
