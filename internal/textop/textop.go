// Package textop is operational transformation for plain text: the edits
// several people make to one shared note at the same time, rebased over each
// other so everyone ends up with the same text and nobody's typing is lost.
//
// An Op walks the whole document from start to end as a list of components:
// keep the next n characters (retain), insert a string, or remove the next n
// characters (delete). On the wire it is the classic ot.js form, a JSON array
// where a positive number retains, a negative number deletes and a string
// inserts: [5, "hi", -3, 10].
//
// Lengths count UTF-16 code units, as JavaScript strings do: the browser
// computes edits against a textarea's value, and both sides must agree on
// what "position 7" means.
package textop

import (
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf16"
)

// component is one step of an Op; exactly one field is set.
type component struct {
	retain int
	insert string
	delete int
}

// Op is one edit of a whole document. The zero value is the empty edit of an
// empty document.
type Op struct {
	comps   []component
	baseLen int // length of the document it applies to
	target  int // length of the document it produces
}

// ErrMismatch is returned when an Op does not fit the document (or the other
// Op) it is applied to.
var ErrMismatch = errors.New("textop: operation does not match the document")

// Len16 is the length of s in UTF-16 code units.
func Len16(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// BaseLen is the length of the document o applies to.
func (o *Op) BaseLen() int { return o.baseLen }

// TargetLen is the length of the document o produces.
func (o *Op) TargetLen() int { return o.target }

// Retain keeps the next n characters.
func (o *Op) Retain(n int) *Op {
	if n <= 0 {
		return o
	}
	o.baseLen += n
	o.target += n
	if k := len(o.comps); k > 0 && o.comps[k-1].retain > 0 {
		o.comps[k-1].retain += n
		return o
	}
	o.comps = append(o.comps, component{retain: n})
	return o
}

// Insert adds s at the current position. An insert next to a delete is kept
// before it, so equal edits always have one canonical form.
func (o *Op) Insert(s string) *Op {
	if s == "" {
		return o
	}
	o.target += Len16(s)
	k := len(o.comps)
	switch {
	case k > 0 && o.comps[k-1].insert != "":
		o.comps[k-1].insert += s
	case k > 0 && o.comps[k-1].delete > 0:
		if k > 1 && o.comps[k-2].insert != "" {
			o.comps[k-2].insert += s
		} else {
			o.comps = append(o.comps, o.comps[k-1])
			o.comps[k-1] = component{insert: s}
		}
	default:
		o.comps = append(o.comps, component{insert: s})
	}
	return o
}

// Delete removes the next n characters.
func (o *Op) Delete(n int) *Op {
	if n <= 0 {
		return o
	}
	o.baseLen += n
	if k := len(o.comps); k > 0 && o.comps[k-1].delete > 0 {
		o.comps[k-1].delete += n
		return o
	}
	o.comps = append(o.comps, component{delete: n})
	return o
}

// IsNoop reports whether o changes nothing.
func (o *Op) IsNoop() bool {
	return len(o.comps) == 0 || (len(o.comps) == 1 && o.comps[0].retain > 0)
}

// MarshalJSON writes the ot.js array form.
func (o Op) MarshalJSON() ([]byte, error) {
	out := make([]any, 0, len(o.comps))
	for _, c := range o.comps {
		switch {
		case c.retain > 0:
			out = append(out, c.retain)
		case c.insert != "":
			out = append(out, c.insert)
		default:
			out = append(out, -c.delete)
		}
	}
	return json.Marshal(out)
}

// UnmarshalJSON reads the ot.js array form, normalising it as it goes.
func (o *Op) UnmarshalJSON(b []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*o = Op{}
	for _, r := range raw {
		var s string
		if err := json.Unmarshal(r, &s); err == nil {
			o.Insert(s)
			continue
		}
		var n int
		if err := json.Unmarshal(r, &n); err != nil {
			return fmt.Errorf("textop: component %s is neither a string nor an integer", r)
		}
		if n > 0 {
			o.Retain(n)
		} else if n < 0 {
			o.Delete(-n)
		} else {
			return errors.New("textop: zero-length component")
		}
	}
	return nil
}

// Apply runs o on doc.
func (o *Op) Apply(doc string) (string, error) {
	units := utf16.Encode([]rune(doc))
	if len(units) != o.baseLen {
		return "", ErrMismatch
	}
	out := make([]uint16, 0, o.target)
	i := 0
	for _, c := range o.comps {
		switch {
		case c.retain > 0:
			out = append(out, units[i:i+c.retain]...)
			i += c.retain
		case c.insert != "":
			out = append(out, utf16.Encode([]rune(c.insert))...)
		default:
			i += c.delete
		}
	}
	return string(utf16.Decode(out)), nil
}

// Transform rebases two concurrent edits of the same document over each
// other: given a and b both made against one text, it returns a2 and b2 such
// that applying a then b2 gives the same text as applying b then a2. Where
// both insert at the same position, a's text comes first — the server always
// passes the incoming edit as a, so of two edits racing for one spot, the one
// that arrived later lands first.
func Transform(a, b *Op) (a2, b2 *Op, err error) {
	if a.baseLen != b.baseLen {
		return nil, nil, ErrMismatch
	}
	a2, b2 = &Op{}, &Op{}
	ac, bc := a.comps, b.comps
	var x, y component // the component of a / b being consumed
	var okx, oky bool
	next := func(list *[]component) (component, bool) {
		if len(*list) == 0 {
			return component{}, false
		}
		c := (*list)[0]
		*list = (*list)[1:]
		return c, true
	}
	x, okx = next(&ac)
	y, oky = next(&bc)
	for okx || oky {
		// Inserts go through untouched, a's first.
		if okx && x.insert != "" {
			a2.Insert(x.insert)
			b2.Retain(Len16(x.insert))
			x, okx = next(&ac)
			continue
		}
		if oky && y.insert != "" {
			a2.Retain(Len16(y.insert))
			b2.Insert(y.insert)
			y, oky = next(&bc)
			continue
		}
		if !okx || !oky {
			return nil, nil, ErrMismatch
		}
		switch {
		case x.retain > 0 && y.retain > 0:
			n := min(x.retain, y.retain)
			a2.Retain(n)
			b2.Retain(n)
			x.retain -= n
			y.retain -= n
		case x.delete > 0 && y.delete > 0:
			// Both removed the same text: nothing left for either to do.
			n := min(x.delete, y.delete)
			x.delete -= n
			y.delete -= n
		case x.delete > 0 && y.retain > 0:
			n := min(x.delete, y.retain)
			a2.Delete(n)
			x.delete -= n
			y.retain -= n
		case x.retain > 0 && y.delete > 0:
			n := min(x.retain, y.delete)
			b2.Delete(n)
			x.retain -= n
			y.delete -= n
		default:
			return nil, nil, ErrMismatch
		}
		if x.retain == 0 && x.delete == 0 {
			x, okx = next(&ac)
		}
		if y.retain == 0 && y.delete == 0 {
			y, oky = next(&bc)
		}
	}
	return a2, b2, nil
}
