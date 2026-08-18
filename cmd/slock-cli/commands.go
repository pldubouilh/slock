package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Ctrl+K switcher — the palette, terminal edition
// ---------------------------------------------------------------------------

type entryKind int

const (
	entryChannel entryKind = iota
	entryDM
	entryUser
)

type entry struct {
	kind    entryKind
	id      int64 // channel id, or user id for entryUser
	title   string
	sub     string
	score   int
	unread  bool
	unreadN int
	recency time.Time
	private bool
}

type switcher struct {
	query   editor
	results []entry
	active  int

	// Popup geometry of the last draw, for mouse hit-testing.
	top, left, boxW, boxH int
}

func (a *App) openSwitcher() {
	a.switcher = &switcher{}
	a.switcher.rebuild(a)
}

// fuzzyScore is the web palette's subsequence matcher, ported rune for rune:
// consecutive hits and start-of-string score higher, shorter haystacks win
// ties. -1 means no match.
func fuzzyScore(needle, hay string) int {
	needle = strings.ToLower(needle)
	hay = strings.ToLower(hay)
	if needle == "" {
		return 0
	}
	score, hi := 0, 0
	for _, r := range needle {
		rel := strings.IndexRune(hay[hi:], r)
		if rel < 0 {
			return -1
		}
		idx := hi + rel
		if rel == 0 {
			score += 3
		} else {
			score++
		}
		if idx == 0 {
			score += 2
		}
		hi = idx + len(string(r))
	}
	return score + max(0, 10-len(hay)/4)
}

// rebuild recomputes the result list, mirroring the web's ranking: with no
// query, unread first (muted excluded) then recency; while typing, match
// quality leads and unread only breaks ties.
func (s *switcher) rebuild(a *App) {
	needle := strings.TrimSpace(s.query.String())
	var out []entry

	for _, ch := range a.sortedChannels() {
		sc := fuzzyScore(needle, ch.Name)
		if sc < 0 {
			continue
		}
		if ch.IsMember {
			sc++
		}
		e := entry{
			kind: entryChannel, id: ch.ID, title: ch.Name, score: sc,
			unread:  !ch.Muted && ch.UnreadCount > 0,
			unreadN: ch.UnreadCount,
			private: ch.IsPrivate,
		}
		if ch.LastMessageAt != nil {
			e.recency = *ch.LastMessageAt
		}
		e.sub = ch.Topic
		if e.sub == "" {
			e.sub = fmt.Sprintf("%d members", ch.MemberCount)
		}
		if e.unread {
			e.sub = fmt.Sprintf("%d unread · %s", ch.UnreadCount, e.sub)
		}
		out = append(out, e)
	}

	// People: an existing DM carries its unread/recency; anyone else opens a
	// fresh conversation on pick.
	dmByPeer := map[int64]*Channel{}
	for _, ch := range a.sortedDMs() {
		if ch.PeerUserID != nil {
			dmByPeer[*ch.PeerUserID] = ch
		}
	}
	for _, u := range a.users {
		if u.ID == a.me.ID {
			continue
		}
		sc := fuzzyScore(needle, u.DisplayName)
		if sc < 0 {
			continue
		}
		e := entry{kind: entryUser, id: u.ID, title: u.DisplayName, score: sc}
		if dm := dmByPeer[u.ID]; dm != nil {
			e.kind = entryDM
			e.id = dm.ID
			e.score++
			e.unread = !dm.Muted && dm.UnreadCount > 0
			e.unreadN = dm.UnreadCount
			if dm.LastMessageAt != nil {
				e.recency = *dm.LastMessageAt
			}
		}
		e.sub = u.StatusText
		if e.sub == "" && a.online[u.ID] {
			e.sub = "online"
		}
		if e.unread {
			e.sub = strings.TrimSuffix(fmt.Sprintf("%d unread · %s", e.unreadN, e.sub), " · ")
		}
		out = append(out, e)
	}

	sort.SliceStable(out, func(i, j int) bool {
		x, y := out[i], out[j]
		if needle == "" {
			if x.unread != y.unread {
				return x.unread
			}
			if x.score != y.score {
				return x.score > y.score
			}
		} else {
			if x.score != y.score {
				return x.score > y.score
			}
			if x.unread != y.unread {
				return x.unread
			}
		}
		return x.recency.After(y.recency)
	})

	limit := 12
	if needle != "" {
		limit = 8
	}
	if len(out) > limit {
		out = out[:limit]
	}
	s.results = out
	if s.active >= len(out) {
		s.active = 0
	}
}

// entryLine renders one popup row — glyph, name, dim subtitle — padded to
// exactly w columns. Widths are measured on the plain parts only, so the SGR
// escapes never skew the box.
func (s *switcher) entryLine(i, w int) string {
	e := s.results[i]
	glyph := "# "
	switch {
	case e.kind == entryChannel && e.private:
		glyph = "🔒"
	case e.kind != entryChannel:
		glyph = "@ "
	}
	head := glyph + truncate(e.title, max(4, w/2))
	rest := w - strWidth(head) - 2
	if rest > 4 && e.sub != "" {
		sub := truncate(e.sub, rest)
		fill := max(0, w-strWidth(head)-2-strWidth(sub))
		return head + "  " + sgrDim + sub + strings.Repeat(" ", fill) + "\x1b[22m"
	}
	return pad(head, w)
}

func (a *App) switcherKey(k key) {
	s := a.switcher
	switch k.kind {
	case keyEsc, keyCtrlK, keyCtrlC:
		a.switcher = nil
	case keyUp:
		if s.active > 0 {
			s.active--
		}
	case keyDown:
		if s.active < len(s.results)-1 {
			s.active++
		}
	case keyEnter:
		if s.active < len(s.results) {
			e := s.results[s.active]
			a.switcher = nil
			a.pickEntry(e)
		}
	case keyBackspace:
		s.query.backspace()
		s.rebuild(a)
	case keyCtrlU:
		s.query.killToStart()
		s.rebuild(a)
	case keyCtrlW:
		s.query.killWord()
		s.rebuild(a)
	case keyLeft:
		s.query.left()
	case keyRight:
		s.query.right()
	case keyMouse:
		if !a.mouseEnabled {
			return
		}
		switch {
		case k.mouseBtn == mouseWheelUp:
			if s.active > 0 {
				s.active--
			}
		case k.mouseBtn == mouseWheelDown:
			if s.active < len(s.results)-1 {
				s.active++
			}
		case k.mouseBtn == mouseLeft && k.mousePress:
			inside := k.mouseX >= s.left && k.mouseX < s.left+s.boxW &&
				k.mouseY >= s.top && k.mouseY < s.top+s.boxH
			if !inside {
				a.switcher = nil // backdrop click closes, like the web
				return
			}
			// Result rows start at top+3 (border, query, divider above them).
			i := k.mouseY - (s.top + 3)
			if i >= 0 && i < len(s.results) {
				e := s.results[i]
				a.switcher = nil
				a.pickEntry(e)
			}
		}
	case keyRune:
		s.query.insert(k.r)
		s.rebuild(a)
	}
}

func (a *App) pickEntry(e entry) {
	switch e.kind {
	case entryChannel, entryDM:
		a.openChannel(e.id)
	case entryUser:
		ch, err := a.api.OpenDM(e.id)
		if err != nil {
			a.fail(err)
			return
		}
		c := ch
		a.channels[c.ID] = &c
		a.openChannel(c.ID)
	}
}

// ---------------------------------------------------------------------------
// /slock commands
// ---------------------------------------------------------------------------

type command struct {
	name string
	hint string // parameter ghost-help shown in the status line
	run  func(a *App, args []string)
}

// Filled in init: cmdHelp lists the table, which would otherwise be an
// initialization cycle.
var commands []command

func init() {
	commands = []command{
		{"new-user", "<email> <display name>", cmdNewUser},
		{"new-channel", "<name> [private]", cmdNewChannel},
		{"invite", "<display name>", cmdInvite},
		{"mute", "", cmdMute},
		{"unmute", "", cmdUnmute},
		{"leave", "", cmdLeave},
		{"theme", "[dark|light|solarized|gruvbox|nord]", cmdTheme},
		{"bell", "", cmdBell},
		{"help", "", cmdHelp},
	}
}

// commandHint is the status-line ghost help while a command is typed.
// It shows help for /slock commands, /theme, /bell, /upload, and /mouse.
func commandHint(input string) string {
	if strings.HasPrefix(input, "/slock") {
		rest := strings.TrimPrefix(input, "/slock")
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			var names []string
			for _, c := range commands {
				names = append(names, c.name)
			}
			return "/slock " + strings.Join(names, " · ")
		}
		var matches []command
		for _, c := range commands {
			if strings.HasPrefix(c.name, fields[0]) {
				matches = append(matches, c)
			}
		}
		switch len(matches) {
		case 0:
			return "unknown command: " + fields[0]
		case 1:
			return strings.TrimSpace("/slock " + matches[0].name + " " + matches[0].hint)
		default:
			var names []string
			for _, c := range matches {
				names = append(names, c.name)
			}
			return "/slock " + strings.Join(names, " · ")
		}
	}
	if strings.HasPrefix(input, "/theme") {
		return "/theme [dark|light|solarized|gruvbox|nord]"
	}
	if strings.HasPrefix(input, "/bell") {
		return "/bell"
	}
	if strings.HasPrefix(input, "/upload") {
		return "/upload <path>"
	}
	if strings.HasPrefix(input, "/mouse") {
		return "/mouse"
	}
	return ""
}

// runCommand dispatches all commands (both /slock <cmd> and top-level /<cmd>).
// It recognizes: /slock, /theme, /bell, /upload, /mouse, and anything else
// is sent as a normal message.
func (a *App) runCommand(line string) {
	// Check for top-level commands first
	if strings.HasPrefix(line, "/theme") {
		text := strings.TrimSpace(strings.TrimPrefix(line, "/theme"))
		cmdTheme(a, strings.Fields(text))
		return
	}
	if strings.HasPrefix(line, "/bell") && (len(line) == 5 || (len(line) > 5 && line[5] == ' ')) {
		cmdBell(a, nil)
		return
	}
	if strings.HasPrefix(line, "/upload") && (len(line) == 7 || (len(line) > 7 && line[7] == ' ')) {
		text := strings.TrimSpace(strings.TrimPrefix(line, "/upload"))
		cmdUpload(a, strings.Fields(text))
		return
	}
	if strings.HasPrefix(line, "/mouse") && (len(line) == 6 || (len(line) > 6 && line[6] == ' ')) {
		cmdMouse(a, nil)
		return
	}
	if strings.HasPrefix(line, "/slock") && (len(line) == 6 || (len(line) > 6 && line[6] == ' ')) {
		fields := strings.Fields(strings.TrimPrefix(line, "/slock"))
		if len(fields) == 0 {
			cmdHelp(a, nil)
			return
		}
		for _, c := range commands {
			if c.name == fields[0] {
				c.run(a, fields[1:])
				return
			}
		}
		a.sys("unknown command: " + fields[0] + " — try /slock help")
		return
	}
	// Not a command; treat as a normal message
	// (this shouldn't be called from here, but for completeness)
}

func cmdNewUser(a *App, args []string) {
	if len(args) < 2 {
		a.sys("usage: /slock new-user <email> <display name>")
		return
	}
	email, name := args[0], strings.Join(args[1:], " ")
	user, temp, err := a.api.AdminCreateUser(email, name)
	if err != nil {
		a.sys("error: " + err.Error())
		return
	}
	u := user
	a.users[u.ID] = &u
	a.sys(fmt.Sprintf("created %s <%s> — temporary password: %s", user.DisplayName, email, temp))
}

func cmdNewChannel(a *App, args []string) {
	if len(args) < 1 {
		a.sys("usage: /slock new-channel <name> [private]")
		return
	}
	private := len(args) > 1 && args[1] == "private"
	ch, err := a.api.CreateChannel(args[0], private)
	if err != nil {
		a.sys("error: " + err.Error())
		return
	}
	c := ch
	a.channels[c.ID] = &c
	a.openChannel(c.ID)
	a.sys("created " + a.channelName(&c))
}

func cmdInvite(a *App, args []string) {
	if len(args) < 1 {
		a.sys("usage: /slock invite <display name>")
		return
	}
	needle := strings.ToLower(strings.Join(args, " "))
	if strings.Contains(needle, "@") {
		a.sys("invite by display name — emails are not listed outside admin views")
		return
	}
	var found *User
	for _, u := range a.users {
		if strings.ToLower(u.DisplayName) == needle {
			if found != nil {
				a.sys("more than one user is called " + args[0] + " — cannot pick")
				return
			}
			found = u
		}
	}
	if found == nil {
		a.sys("no user named " + strings.Join(args, " "))
		return
	}
	if err := a.api.AddMember(a.current, found.ID); err != nil {
		a.sys("error: " + err.Error())
		return
	}
	a.sys("invited " + found.DisplayName)
}

func cmdMute(a *App, args []string)   { a.setMute(true) }
func cmdUnmute(a *App, args []string) { a.setMute(false) }

func (a *App) setMute(muted bool) {
	ch := a.channels[a.current]
	if ch == nil {
		return
	}
	if err := a.api.SetMute(ch.ID, muted); err != nil {
		a.sys("error: " + err.Error())
		return
	}
	ch.Muted = muted
	if muted {
		a.sys("muted — no more push for this channel")
	} else {
		a.sys("unmuted")
	}
}

func cmdLeave(a *App, args []string) {
	ch := a.channels[a.current]
	if ch == nil || ch.Kind != KindChannel {
		a.sys("not in a channel")
		return
	}
	if err := a.api.Leave(ch.ID); err != nil {
		a.sys("error: " + err.Error())
		return
	}
	ch.IsMember = false
	if ch.IsPrivate {
		a.dropChannel(ch.ID) // gone for good, like the web client
	}
}

// cmdTheme sets the color theme (dark, light, solarized, gruvbox, nord).
// With no argument, prints available themes and the current one.
func cmdTheme(a *App, args []string) {
	if len(args) == 0 {
		// Print available themes and current one
		themes := []string{"dark", "light", "solarized", "gruvbox", "nord"}
		current := a.cfg.Theme
		if current == "" {
			current = "dark"
		}
		a.sys("available themes: " + strings.Join(themes, ", "))
		a.sys("current theme: " + current)
		return
	}

	theme := args[0]
	validThemes := map[string]bool{
		"dark":      true,
		"light":     true,
		"solarized": true,
		"gruvbox":   true,
		"nord":      true,
	}
	if !validThemes[theme] {
		a.sys("unknown theme: " + theme + " — try /slock theme")
		return
	}

	if theme == "dark" {
		a.cfg.Theme = ""
	} else {
		a.cfg.Theme = theme
	}
	applyTheme(a.cfg.Theme)
	if err := saveConfig(a.cfg); err != nil {
		a.sys("error: " + err.Error())
		return
	}
	display := a.cfg.Theme
	if display == "" {
		display = "dark"
	}
	a.sys("theme: " + display)
}

func cmdBell(a *App, args []string) {
	a.cfg.Bell = !a.cfg.Bell
	if err := saveConfig(a.cfg); err != nil {
		a.sys("error: " + err.Error())
		return
	}
	if a.cfg.Bell {
		a.sys("bell: on — terminal bell on incoming messages")
	} else {
		a.sys("bell: off")
	}
}

func cmdHelp(a *App, args []string) {
	a.sys("commands:")
	a.sys("  /slock new-user <email> <display name>")
	a.sys("  /slock new-channel <name> [private]")
	a.sys("  /slock invite <display name>")
	a.sys("  /slock mute")
	a.sys("  /slock unmute")
	a.sys("  /slock leave")
	a.sys("  /slock help")
	a.sys("top-level commands:")
	a.sys("  /theme [dark|light|solarized|gruvbox|nord]")
	a.sys("  /bell")
	a.sys("  /upload <path>")
	a.sys("  /mouse")
}

// cmdUpload sends a file to the current channel as an attachment.
// It expands ~ to $HOME, opens the file, uploads it via /api/uploads,
// and posts a message with the attachment.
func cmdUpload(a *App, args []string) {
	if len(args) < 1 {
		a.sys("usage: /upload <path>")
		return
	}
	path := args[0]
	// Expand ~ to $HOME
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			a.sys("error: " + err.Error())
			return
		}
		path = filepath.Join(home, path[1:])
	}
	// Open and upload the file
	f, err := os.Open(path)
	if err != nil {
		a.sys("error: " + err.Error())
		return
	}
	defer f.Close()
	basename := filepath.Base(path)
	attID, err := a.api.Upload(f, basename)
	if err != nil {
		a.sys("error: " + err.Error())
		return
	}
	// Post a message with the attachment (empty body)
	msg, err := a.api.SendWithAttachments(a.current, "", []int64{attID})
	if err != nil {
		a.sys("error: " + err.Error())
		return
	}
	a.appendMessage(msg)
	a.scroll = 0
	a.markRead()
}

// cmdMouse toggles mouse capture on/off.
func cmdMouse(a *App, _ []string) {
	a.mouseEnabled = !a.mouseEnabled
	if a.mouseEnabled {
		os.Stdout.WriteString("\x1b[?1000h\x1b[?1006h")
		a.sys("mouse: on")
	} else {
		os.Stdout.WriteString("\x1b[?1000l\x1b[?1006l")
		a.sys("mouse: off — select/copy freely, /mouse to re-enable")
	}
}
