package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode"

	"golang.org/x/term"
)

// ---------------------------------------------------------------------------
// terminal setup — raw mode, alternate screen, and a guaranteed restore
// ---------------------------------------------------------------------------

type screen struct {
	fd   int
	prev *term.State
	out  *bufio.Writer
}

func openScreen() (*screen, error) {
	fd := int(os.Stdin.Fd())
	prev, err := term.MakeRaw(fd)
	if err != nil {
		return nil, err
	}
	s := &screen{fd: fd, prev: prev, out: bufio.NewWriterSize(os.Stdout, 1<<16)}
	// Alternate screen buffer, hidden cursor while composing frames, and SGR
	// mouse reporting (press/release + wheel; terminals without it just never
	// send the sequences).
	s.out.WriteString("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h")
	s.out.Flush()
	return s, nil
}

// close restores the terminal. Safe to call twice; also called from the
// panic handler so a crash never leaves the shell in raw mode or still
// swallowing mouse clicks.
func (s *screen) close() {
	if s.prev == nil {
		return
	}
	// Unconditionally disable mouse tracking, show cursor, exit alternate screen
	os.Stdout.WriteString("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l\x1b[0m")
	term.Restore(s.fd, s.prev)
	s.prev = nil
}

func (s *screen) size() (w, h int) {
	w, h, err := term.GetSize(s.fd)
	if err != nil || w <= 0 || h <= 0 {
		return 80, 24
	}
	return w, h
}

// ---------------------------------------------------------------------------
// colors — 256-color when the terminal claims it, bold/basic otherwise
// ---------------------------------------------------------------------------

var has256 = strings.Contains(os.Getenv("TERM"), "256color") || os.Getenv("COLORTERM") != ""

// palette is every color choice in one place, with various named colorsets.
// The terminal's own background is never repainted — the theme only picks foregrounds.
type palette struct {
	avatar256 [12]int // ANSI-256 approximations of the web's 12 avatar colors
	avatar8   [12]int // basic-8 fallback; bold/dim carry what color cannot
	accent256 int
	accent8   int
	danger256 int
	danger8   int
	online    string // the presence dot, a full SGR fragment
}

var paletteDark = palette{
	avatar256: [12]int{167, 130, 136, 64, 29, 30, 68, 62, 98, 133, 168, 66},
	avatar8:   [12]int{31, 33, 33, 32, 32, 36, 34, 34, 35, 35, 31, 37},
	accent256: 111, accent8: 36,
	danger256: 167, danger8: 31,
	online: "\x1b[32m",
}

var paletteLight = palette{
	avatar256: [12]int{88, 94, 100, 22, 23, 30, 25, 61, 55, 90, 125, 60},
	avatar8:   [12]int{31, 33, 33, 32, 32, 36, 34, 34, 35, 35, 31, 30},
	accent256: 62, accent8: 34,
	danger256: 124, danger8: 31,
	online: "\x1b[32m",
}

var paletteSolarized = palette{
	avatar256: [12]int{166, 136, 125, 33, 37, 37, 33, 64, 64, 125, 125, 136},
	avatar8:   [12]int{31, 33, 33, 32, 32, 36, 34, 34, 35, 35, 31, 37},
	accent256: 33, accent8: 36,
	danger256: 166, danger8: 31,
	online: "\x1b[32m",
}

var paletteGruvbox = palette{
	avatar256: [12]int{172, 142, 214, 142, 175, 108, 109, 208, 175, 139, 172, 208},
	avatar8:   [12]int{31, 33, 33, 32, 32, 36, 34, 34, 35, 35, 31, 37},
	accent256: 142, accent8: 36,
	danger256: 172, danger8: 31,
	online: "\x1b[32m",
}

var paletteNord = palette{
	avatar256: [12]int{216, 143, 180, 73, 71, 77, 73, 76, 144, 150, 191, 129},
	avatar8:   [12]int{31, 33, 33, 32, 32, 36, 34, 34, 35, 35, 31, 37},
	accent256: 143, accent8: 36,
	danger256: 191, danger8: 31,
	online: "\x1b[32m",
}

var pal = &paletteDark
var themeOverrides = map[string]int{} // COLOR_ACCENT, COLOR_DANGER overrides
var avatarOverride *[12]int           // COLOR_AVATARS override, whole set or nothing

// applyTheme selects a named palette and applies any color overrides.
func applyTheme(name string) {
	switch name {
	case "light":
		pal = &paletteLight
	case "solarized":
		pal = &paletteSolarized
	case "gruvbox":
		pal = &paletteGruvbox
	case "nord":
		pal = &paletteNord
	default:
		pal = &paletteDark
	}
	// Apply color overrides if set (0-255 ANSI-256 values).
	if c, ok := themeOverrides["accent"]; ok && c >= 0 && c <= 255 {
		pal.accent256 = c
	}
	if c, ok := themeOverrides["danger"]; ok && c >= 0 && c <= 255 {
		pal.danger256 = c
	}
	if avatarOverride != nil {
		pal.avatar256 = *avatarOverride
	}
}

const (
	sgrReset     = "\x1b[0m"
	sgrBold      = "\x1b[1m"
	sgrDim       = "\x1b[2m"
	sgrUnderline = "\x1b[4m"
	sgrReverse   = "\x1b[7m"
)

func fgAvatar(color int) string {
	i := color % 12
	if i < 0 {
		i = 0
	}
	if has256 {
		return fmt.Sprintf("\x1b[38;5;%dm", pal.avatar256[i])
	}
	return fmt.Sprintf("\x1b[%dm", pal.avatar8[i])
}

func fgAccent() string {
	if has256 {
		return fmt.Sprintf("\x1b[38;5;%dm", pal.accent256)
	}
	return fmt.Sprintf("\x1b[%dm", pal.accent8)
}

func fgDanger() string {
	if has256 {
		return fmt.Sprintf("\x1b[38;5;%dm", pal.danger256)
	}
	return fmt.Sprintf("\x1b[%dm", pal.danger8)
}

// ---------------------------------------------------------------------------
// display width — enough wcwidth to keep columns straight for chat text.
// CJK and emoji count 2; everything else 1. Not a full Unicode answer, but
// wrong only for exotic input, and only cosmetically.
// ---------------------------------------------------------------------------

func runeWidth(r rune) int {
	switch {
	case r >= 0x1100 && r <= 0x115F, // Hangul jamo
		r >= 0x2E80 && r <= 0xA4CF, // CJK
		r >= 0xAC00 && r <= 0xD7A3, // Hangul syllables
		r >= 0xF900 && r <= 0xFAFF, // CJK compat
		r >= 0xFF00 && r <= 0xFF60, // fullwidth forms
		r >= 0x1F000:               // emoji and friends
		return 2
	case r < 0x20:
		return 0
	}
	return 1
}

func strWidth(s string) int {
	w := 0
	for _, r := range s {
		w += runeWidth(r)
	}
	return w
}

// truncate cuts s to at most w columns, appending … when it cut.
func truncate(s string, w int) string {
	if strWidth(s) <= w {
		return s
	}
	var b strings.Builder
	used := 0
	for _, r := range s {
		rw := runeWidth(r)
		if used+rw > w-1 {
			break
		}
		b.WriteRune(r)
		used += rw
	}
	return b.String() + "…"
}

// pad right-pads s (measured in columns) to exactly w.
func pad(s string, w int) string {
	d := w - strWidth(s)
	if d <= 0 {
		return s
	}
	return s + strings.Repeat(" ", d)
}

// wrap word-wraps plain text to at most w columns per line. Words longer than
// a line are hard-broken so a URL cannot push into the sidebar.
func wrap(s string, w int) []string {
	if w < 4 {
		w = 4
	}
	var out []string
	for _, para := range strings.Split(s, "\n") {
		if para == "" {
			out = append(out, "")
			continue
		}
		var line strings.Builder
		lineW := 0
		for _, word := range strings.Split(para, " ") {
			ww := strWidth(word)
			switch {
			case lineW == 0 && ww <= w:
				line.WriteString(word)
				lineW = ww
			case lineW+1+ww <= w:
				line.WriteByte(' ')
				line.WriteString(word)
				lineW += 1 + ww
			default:
				if lineW > 0 {
					out = append(out, line.String())
					line.Reset()
					lineW = 0
				}
				// Hard-break an over-long word across as many lines as needed.
				for strWidth(word) > w {
					var head strings.Builder
					used := 0
					for _, r := range word {
						rw := runeWidth(r)
						if used+rw > w {
							break
						}
						head.WriteRune(r)
						used += rw
					}
					out = append(out, head.String())
					word = word[len(head.String()):]
				}
				line.WriteString(word)
				lineW = strWidth(word)
			}
		}
		out = append(out, line.String())
	}
	return out
}

// ---------------------------------------------------------------------------
// keyboard — raw bytes to keys, including escape sequences
// ---------------------------------------------------------------------------

type keyKind int

const (
	keyRune keyKind = iota
	keyEnter
	keyEsc
	keyBackspace
	keyDelete
	keyUp
	keyDown
	keyLeft
	keyRight
	keyHome
	keyEnd
	keyPgUp
	keyPgDn
	keyCtrlC
	keyCtrlQ
	keyCtrlK
	keyCtrlU
	keyCtrlW
	keyMouse
)

// Wheel notches arrive as SGR buttons 64 (up) and 65 (down).
const (
	mouseLeft      = 0
	mouseWheelUp   = 64
	mouseWheelDown = 65
)

type key struct {
	kind keyKind
	r    rune

	// keyMouse only: SGR button code, 1-based cell, press vs release.
	mouseBtn   int
	mouseX     int
	mouseY     int
	mousePress bool
}

// readKeys turns stdin into key events. It parses whole chunks, so a lone ESC
// at the end of a read is the Esc key while ESC followed by '[' in the same
// chunk is a sequence — the practical disambiguation every raw-mode app uses.
func readKeys(out chan<- key) {
	buf := make([]byte, 4096)
	var pending []byte // partial UTF-8 rune straddling reads
	for {
		n, err := os.Stdin.Read(buf)
		if err != nil {
			return
		}
		data := append(pending, buf[:n]...)
		pending = nil
		for i := 0; i < len(data); {
			b := data[i]
			switch {
			case b == 0x1b:
				k, adv := parseEscape(data[i:])
				out <- k
				i += adv
			case b == '\r' || b == '\n':
				out <- key{kind: keyEnter}
				i++
			case b == 0x7f || b == 0x08:
				out <- key{kind: keyBackspace}
				i++
			case b == 0x03:
				out <- key{kind: keyCtrlC}
				i++
			case b == 0x11:
				out <- key{kind: keyCtrlQ}
				i++
			case b == 0x0b:
				out <- key{kind: keyCtrlK}
				i++
			case b == 0x15:
				out <- key{kind: keyCtrlU}
				i++
			case b == 0x17:
				out <- key{kind: keyCtrlW}
				i++
			case b < 0x20:
				i++ // other control chars: ignore
			default:
				r, size := decodeRune(data[i:])
				if r == 0 {
					// Partial rune at the end of the chunk: keep for next read.
					pending = append(pending, data[i:]...)
					i = len(data)
					break
				}
				out <- key{kind: keyRune, r: r}
				i += size
			}
		}
	}
}

// decodeRune decodes one UTF-8 rune, returning 0 when the bytes are a valid
// but incomplete prefix (the caller buffers them).
func decodeRune(b []byte) (rune, int) {
	if b[0] < 0x80 {
		return rune(b[0]), 1
	}
	need := 2
	switch {
	case b[0]&0xF0 == 0xE0:
		need = 3
	case b[0]&0xF8 == 0xF0:
		need = 4
	}
	if len(b) < need {
		return 0, 0
	}
	r := []rune(string(b[:need]))
	if len(r) == 0 || !unicode.IsGraphic(r[0]) {
		return ' ', need
	}
	return r[0], need
}

// parseEscape handles the CSI sequences slock-cli cares about; anything else
// is swallowed so stray sequences never type garbage into the input.
func parseEscape(b []byte) (key, int) {
	if len(b) == 1 {
		return key{kind: keyEsc}, 1
	}
	if b[1] == 'O' && len(b) >= 3 { // application cursor keys
		switch b[2] {
		case 'A':
			return key{kind: keyUp}, 3
		case 'B':
			return key{kind: keyDown}, 3
		case 'C':
			return key{kind: keyRight}, 3
		case 'D':
			return key{kind: keyLeft}, 3
		case 'H':
			return key{kind: keyHome}, 3
		case 'F':
			return key{kind: keyEnd}, 3
		}
		return key{kind: keyEsc}, 3
	}
	if b[1] != '[' {
		return key{kind: keyEsc}, 2
	}
	// SGR mouse: ESC [ < btn ; x ; y (M = press, m = release).
	if len(b) >= 3 && b[2] == '<' {
		i := 3
		var nums [3]int
		n := 0
		for i < len(b) && n < 3 {
			v := 0
			ok := false
			for i < len(b) && b[i] >= '0' && b[i] <= '9' {
				v = v*10 + int(b[i]-'0')
				i++
				ok = true
			}
			if !ok {
				break
			}
			nums[n] = v
			n++
			if i < len(b) && b[i] == ';' {
				i++
			}
		}
		if i < len(b) && (b[i] == 'M' || b[i] == 'm') && n == 3 {
			return key{
				kind:       keyMouse,
				mouseBtn:   nums[0],
				mouseX:     nums[1],
				mouseY:     nums[2],
				mousePress: b[i] == 'M',
			}, i + 1
		}
		// Malformed or truncated: swallow what we saw, type nothing.
		return key{kind: keyEsc}, i
	}
	// CSI: consume parameter bytes until the final letter/tilde.
	i := 2
	for i < len(b) && (b[i] >= '0' && b[i] <= '9' || b[i] == ';') {
		i++
	}
	if i >= len(b) {
		return key{kind: keyEsc}, len(b)
	}
	fin := b[i]
	params := string(b[2:i])
	adv := i + 1
	switch fin {
	case 'A':
		return key{kind: keyUp}, adv
	case 'B':
		return key{kind: keyDown}, adv
	case 'C':
		return key{kind: keyRight}, adv
	case 'D':
		return key{kind: keyLeft}, adv
	case 'H':
		return key{kind: keyHome}, adv
	case 'F':
		return key{kind: keyEnd}, adv
	case '~':
		switch params {
		case "1", "7":
			return key{kind: keyHome}, adv
		case "3":
			return key{kind: keyDelete}, adv
		case "4", "8":
			return key{kind: keyEnd}, adv
		case "5":
			return key{kind: keyPgUp}, adv
		case "6":
			return key{kind: keyPgDn}, adv
		}
	}
	return key{kind: keyEsc}, adv
}

// ---------------------------------------------------------------------------
// line editor — the input bar and the switcher query share it
// ---------------------------------------------------------------------------

type editor struct {
	runes []rune
	cur   int
}

func (e *editor) String() string { return string(e.runes) }

func (e *editor) set(s string) {
	e.runes = []rune(s)
	e.cur = len(e.runes)
}

func (e *editor) insert(r rune) {
	e.runes = append(e.runes[:e.cur], append([]rune{r}, e.runes[e.cur:]...)...)
	e.cur++
}

func (e *editor) backspace() {
	if e.cur > 0 {
		e.runes = append(e.runes[:e.cur-1], e.runes[e.cur:]...)
		e.cur--
	}
}

func (e *editor) del() {
	if e.cur < len(e.runes) {
		e.runes = append(e.runes[:e.cur], e.runes[e.cur+1:]...)
	}
}

// killToStart is Ctrl-U: drop everything left of the cursor.
func (e *editor) killToStart() {
	e.runes = append([]rune{}, e.runes[e.cur:]...)
	e.cur = 0
}

// killWord is Ctrl-W: drop the word (and trailing spaces) left of the cursor.
func (e *editor) killWord() {
	i := e.cur
	for i > 0 && e.runes[i-1] == ' ' {
		i--
	}
	for i > 0 && e.runes[i-1] != ' ' {
		i--
	}
	e.runes = append(e.runes[:i], e.runes[e.cur:]...)
	e.cur = i
}

func (e *editor) left() {
	if e.cur > 0 {
		e.cur--
	}
}
func (e *editor) right() {
	if e.cur < len(e.runes) {
		e.cur++
	}
}
func (e *editor) home() { e.cur = 0 }
func (e *editor) end()  { e.cur = len(e.runes) }

// ---------------------------------------------------------------------------
// frame drawing
// ---------------------------------------------------------------------------

const sidebarW = 26

// draw composes and writes one full frame. Full redraws keep the code simple;
// at terminal sizes the bytes are trivial.
func (a *App) draw() {
	w, h := a.scr.size()
	a.w, a.h = w, h
	out := a.scr.out

	chatW := w - sidebarW - 2
	showSidebar := w >= 56
	if !showSidebar {
		chatW = w
	}
	a.chatW = chatW // remembered for mouse hit-testing

	// Hide the cursor while composing (drawInput/drawSwitcher re-show it at
	// its real position), home, and let every row overwrite fully.
	out.WriteString("\x1b[?25l\x1b[H")

	// Chat area starts at row 1 (no top bar).
	chatTop, chatBottom := 1, h-2
	chatH := chatBottom - chatTop + 1
	lines := a.chatLines(chatW - 1)
	// scroll counts lines up from the live tail, so prepended history never
	// shifts the view.
	end := len(lines) - a.scroll
	if end > len(lines) {
		end = len(lines)
	}
	if end < 0 {
		end = 0
	}
	start := end - chatH
	if start < 0 {
		start = 0
	}
	visible := lines[start:end]

	side := a.sidebarLines(chatH)
	for i := 0; i < chatH; i++ {
		row := chatTop + i
		fmt.Fprintf(out, "\x1b[%d;1H\x1b[K", row)
		if i < len(visible) {
			out.WriteString(visible[i])
			out.WriteString(sgrReset)
		}
		if showSidebar {
			fmt.Fprintf(out, "\x1b[%d;%dH%s│%s", row, chatW+1, sgrDim, sgrReset)
			if i < len(side) {
				fmt.Fprintf(out, "\x1b[%d;%dH%s", row, chatW+2, side[i])
				out.WriteString(sgrReset)
			}
		}
	}

	a.drawStatus(out, w, h)
	a.drawInput(out, w, h)

	if a.switcher != nil {
		a.drawSwitcher(out, w, h)
	}

	out.Flush()
}

func (a *App) drawStatus(out *bufio.Writer, w, h int) {
	input := a.input.String()
	msg := ""
	// Show command hint when typing a command (any command prefix)
	if strings.HasPrefix(input, "/slock") || strings.HasPrefix(input, "/theme") ||
		strings.HasPrefix(input, "/bell") || strings.HasPrefix(input, "/upload") ||
		strings.HasPrefix(input, "/mouse") {
		msg = commandHint(input)
		fmt.Fprintf(out, "\x1b[%d;1H\x1b[K%s%s%s", h-1, sgrDim, truncate(msg, w-2), sgrReset)
	} else {
		// Clear the status line when not typing a command
		fmt.Fprintf(out, "\x1b[%d;1H\x1b[K", h-1)
	}
}

func (a *App) drawInput(out *bufio.Writer, w, h int) {
	prompt := "      " + fgAccent() + ">" + sgrReset + " "
	if a.editing != 0 {
		prompt = "  edit " + fgAccent() + ">" + sgrReset + " "
	}
	text := a.input.String()
	// Keep the cursor in view when the line outgrows the row.
	promptW := 8 // "      >" = 6 spaces + 1 char + " " = 8 display width
	avail := w - promptW - 1
	runes := []rune(text)
	start := 0
	if a.input.cur > avail {
		start = a.input.cur - avail
	}
	view := string(runes[start:])
	view = truncate(view, avail)
	fmt.Fprintf(out, "\x1b[%d;1H\x1b[K%s%s", h, prompt, view)

	if a.switcher == nil {
		col := promptW + strWidth(string(runes[start:a.input.cur])) + 1
		fmt.Fprintf(out, "\x1b[?25h\x1b[%d;%dH", h, col)
	}
}

// chatLines renders the current channel into styled, wrapped terminal lines.
func (a *App) chatLines(width int) []string {
	st := a.chanState(a.current)
	var out []string
	var prev *Message
	var prevDay time.Time
	for i := range st.msgs {
		m := &st.msgs[i]

		// Insert day divider before each message if it's on a different calendar day
		// (or before the very first non-local message).
		// Format: 15 "─" + space + date + space + 15 "─", dim, centered if possible.
		if !m.Local {
			curDay := m.CreatedAt.Local()
			// Compare dates only (not times)
			if prevDay.IsZero() || (prevDay.Year() != curDay.Year() || prevDay.Month() != curDay.Month() || prevDay.Day() != curDay.Day()) {
				dateStr := curDay.Format("Mon Jan 2")
				divider := strings.Repeat("─", 15) + " " + dateStr + " " + strings.Repeat("─", 15)
				dividerW := strWidth(divider)
				if dividerW <= width {
					// Center it if it fits
					padding := width - dividerW
					left := padding / 2
					line := strings.Repeat(" ", left) + divider
					out = append(out, sgrDim+line+sgrReset)
				} else {
					// Left-align if too wide
					line := truncate(divider, width)
					out = append(out, sgrDim+line+sgrReset)
				}
				prevDay = curDay
			}
		}

		if m.Local {
			for _, l := range wrap("· "+m.Body, width) {
				out = append(out, sgrDim+fgAccent()+l+sgrReset)
			}
			prev = nil
			continue
		}

		ts := m.CreatedAt.Local().Format("15:04")
		grouped := prev != nil && prev.UserID == m.UserID &&
			m.CreatedAt.Sub(prev.CreatedAt) < 5*time.Minute
		indent := "      " // width of "15:04 "

		body := m.Body
		if m.DeletedAt != nil {
			body = "(deleted)"
		}
		u := a.users[m.UserID]
		name := "?"
		color := 0
		if u != nil {
			name, color = u.DisplayName, u.AvatarColor
		}

		prefixW := 0
		if grouped {
			prefixW = strWidth(indent)
		} else {
			prefixW = strWidth(ts) + 1 + strWidth(name) + 2
		}
		bodyLines := wrap(body, max(8, width-prefixW))

		for j, l := range bodyLines {
			styled := l
			if m.DeletedAt != nil {
				styled = sgrDim + l + sgrReset
			}
			if j == len(bodyLines)-1 && m.EditedAt != nil && m.DeletedAt == nil {
				styled += sgrDim + " (edited)" + sgrReset
			}
			switch {
			case j == 0 && !grouped:
				out = append(out, sgrDim+ts+sgrReset+" "+fgAvatar(color)+sgrBold+name+sgrReset+": "+styled)
			case j == 0:
				out = append(out, sgrDim+ts+sgrReset+" "+styled)
			default:
				out = append(out, strings.Repeat(" ", prefixW)+styled)
			}
		}
		if m.DeletedAt == nil {
			for _, att := range m.Attachments {
				out = append(out, indent+sgrDim+sgrUnderline+truncate(a.api.FileURL(att), width-6)+sgrReset)
			}
			if len(m.Reactions) > 0 {
				var parts []string
				for _, r := range m.Reactions {
					parts = append(parts, fmt.Sprintf("%s %d", r.Emoji, r.Count))
				}
				out = append(out, indent+sgrDim+truncate(strings.Join(parts, "   "), width-6)+sgrReset)
			}
		}
		prev = m
	}
	return out
}

// sidebarLines renders the channel/DM rail, truncated to the visible height.
// Starts with the workspace header (2 rows), then channels/DMs.
// Alongside the text it records which channel sits on which visual row
// (a.sideRows, 0 for headers/gaps) so a click can be resolved later.
func (a *App) sidebarLines(h int) []string {
	w := sidebarW - 3 // Reduced because sidebarRow adds space + marker + space
	var out []string
	a.sideRows = a.sideRows[:0]

	// Sidebar header: workspace name (bold, accent) + blank line
	out = append(out, " "+sgrBold+fgAccent()+truncate(a.workspaceName, w-1)+sgrReset)
	a.sideRows = append(a.sideRows, 0)
	out = append(out, "")
	a.sideRows = append(a.sideRows, 0)

	head := func(t string) {
		out = append(out, " "+sgrDim+sgrBold+truncate(t, w)+sgrReset)
		a.sideRows = append(a.sideRows, 0)
	}

	head("CHANNELS")
	for _, ch := range a.sortedChannels() {
		out = append(out, a.sidebarRow(ch, w))
		a.sideRows = append(a.sideRows, ch.ID)
	}
	out = append(out, "")
	a.sideRows = append(a.sideRows, 0)
	head("DIRECT MESSAGES")
	for _, ch := range a.sortedDMs() {
		out = append(out, a.sidebarRow(ch, w))
		a.sideRows = append(a.sideRows, ch.ID)
	}
	if len(out) > h {
		out = out[:h]
		a.sideRows = a.sideRows[:h]
	}
	return out
}

func (a *App) sidebarRow(ch *Channel, w int) string {
	// Format: │ › channelname (selected) or │   channelname (unselected)
	// We render: space (padding) + marker + space + glyph + space + name + badge

	// Marker: selected channel indicator
	marker := " "
	if ch.ID == a.current {
		marker = fgAccent() + "›" + sgrReset
	}

	// Glyph: lock emoji for private channels, space for DMs, nothing for public channels
	glyph := ""
	glyphW := 0
	if ch.IsPrivate {
		glyph = "🔒"
		glyphW = 2
	} else if ch.Kind == KindDM {
		glyph = " "
		glyphW = 1
	}

	badge := ""
	if ch.UnreadCount > 0 {
		badge = fmt.Sprintf(" %d", ch.UnreadCount)
		if ch.UnreadCount > 99 {
			badge = " 99+"
		}
	}
	// Width calculation: space (1) + marker (1) + space (1) + glyph (glyphW) + space (1) + name + badge = total w
	// So nameW = w - 1 - 1 - 1 - glyphW - 1 - strWidth(badge) = w - 4 - glyphW - strWidth(badge)
	nameW := w - 4 - glyphW - strWidth(badge)
	if nameW < 4 {
		nameW = 4
	}
	name := truncate(a.channelName(ch), nameW)
	body := pad(name, nameW) + sgrBold + badge

	style := ""
	switch {
	case ch.Muted:
		style = sgrDim
	case ch.UnreadCount > 0:
		style = sgrBold
	}
	return " " + marker + " " + style + glyph + " " + body + sgrReset
}

// drawSwitcher paints the Ctrl+K popup over the chat area.
func (a *App) drawSwitcher(out *bufio.Writer, w, h int) {
	s := a.switcher
	bw := min(64, w-6)
	bh := min(4+len(s.results), h-4)
	if bh < 5 {
		bh = 5
	}
	top := (h - bh) / 2
	left := (w - bw) / 2
	// Remembered for mouse hit-testing: rows start at top+3.
	s.top, s.left, s.boxW, s.boxH = top, left, bw, bh

	line := func(row int, s string) {
		fmt.Fprintf(out, "\x1b[%d;%dH%s", row, left, s)
	}
	inner := bw - 2

	line(top, "┌"+strings.Repeat("─", inner)+"┐")
	q := truncate(s.query.String(), inner-3)
	line(top+1, "│ "+q+strings.Repeat(" ", max(0, inner-2-strWidth(q)))+" │")
	line(top+2, "├"+strings.Repeat("─", inner)+"┤")
	rows := bh - 4
	for i := 0; i < rows; i++ {
		content := ""
		if i < len(s.results) {
			content = s.entryLine(i, inner-2)
			if i == s.active {
				content = sgrReverse + content + sgrReset
			}
		} else {
			content = pad("", inner-2)
		}
		line(top+3+i, "│ "+content+" │")
	}
	line(top+bh-1, "└"+strings.Repeat("─", inner)+"┘")

	// Hardware cursor inside the query field.
	fmt.Fprintf(out, "\x1b[?25h\x1b[%d;%dH", top+1, left+2+strWidth(string(s.query.runes[:s.query.cur])))
}
