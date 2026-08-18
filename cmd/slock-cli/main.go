// Command slock-cli is a terminal client for slock: chat on the left, the
// channel rail on the right, Ctrl+K to jump anywhere. Standard library plus
// x/term only — the interface is hand-rolled ANSI, in the spirit of the web
// client's no-framework ethos.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
)

// KindChannel/KindDM mirror the server's channel kinds.
const (
	KindChannel = "channel"
	KindDM      = "dm"
)

// activeConfigPath is the config file path resolved at startup, used by
// configPath(), loadConfig(), and saveConfig() for multi-workspace support.
var activeConfigPath string

func main() {
	// Parse profile name from command-line arguments.
	// Format: slock-cli [<profile-name>] [login <base-url> [<profile-name>]]
	profile := ""
	args := os.Args[1:]

	// Default first; `login` may override it when given a profile name.
	activeConfigPath = resolveConfigPath("")

	if len(args) > 0 {
		if args[0] == "login" {
			// slock-cli login <base-url> [<profile-name>]
			if err := login(args[1:]); err != nil {
				fmt.Fprintln(os.Stderr, "login:", err)
				os.Exit(1)
			}
			return
		}
		// Check if first arg is a profile name (not a flag/option)
		if !strings.HasPrefix(args[0], "-") && !strings.HasPrefix(args[0], "/") {
			profile = args[0]
			if !isValidProfileName(profile) {
				fmt.Fprintf(os.Stderr, "invalid profile name: %s\n", profile)
				fmt.Fprintf(os.Stderr, "usage: slock-cli [<profile-name>] | slock-cli login <base-url> [<profile-name>]\n")
				os.Exit(1)
			}
		}
	}

	// Resolve the active config path.
	activeConfigPath = resolveConfigPath(profile)

	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// isValidProfileName checks if a profile name contains only letters, digits, dash, and underscore.
func isValidProfileName(name string) bool {
	match, _ := regexp.MatchString(`^[a-zA-Z0-9_-]+$`, name)
	return match
}

// resolveConfigPath determines the config file path based on the profile name.
// Empty profile uses the default ~/.config/slock-cli/config;
// named profiles use ~/.config/<profile-name>.
func resolveConfigPath(profile string) string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	if profile == "" {
		return filepath.Join(dir, "slock-cli", "config")
	}
	return filepath.Join(dir, profile)
}

// ---------------------------------------------------------------------------
// config — resolved at startup based on profile, mode 0600 (it holds the session token)
// ---------------------------------------------------------------------------

type config struct {
	BaseURL     string
	Session     string
	LastChannel int64
	Theme       string // "dark", "light", "solarized", "gruvbox", "nord"
	Bell        bool   // write "\a" on incoming messages from others
}

func configPath() string {
	return activeConfigPath
}

func loadConfig() (config, error) {
	var cfg config
	data, err := os.ReadFile(activeConfigPath)
	if err != nil {
		return cfg, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "BASE_URL":
			cfg.BaseURL = v
		case "SESSION":
			cfg.Session = v
		case "LAST_CHANNEL":
			cfg.LastChannel, _ = strconv.ParseInt(v, 10, 64)
		case "THEME":
			cfg.Theme = v
		case "BELL":
			cfg.Bell = v == "1" || v == "true"
		case "COLOR_ACCENT":
			if c, err := strconv.Atoi(v); err == nil && c >= 0 && c <= 255 {
				themeOverrides["accent"] = c
			}
		case "COLOR_DANGER":
			if c, err := strconv.Atoi(v); err == nil && c >= 0 && c <= 255 {
				themeOverrides["danger"] = c
			}
		case "COLOR_AVATARS":
			parts := strings.Split(v, ",")
			if len(parts) == 12 {
				var avatars [12]int
				ok := true
				for i, p := range parts {
					c, err := strconv.Atoi(strings.TrimSpace(p))
					if err != nil || c < 0 || c > 255 {
						ok = false
						break
					}
					avatars[i] = c
				}
				if ok {
					avatarOverride = &avatars // applied by applyTheme, whichever preset wins
				}
			}
		}
	}
	return cfg, nil
}

func saveConfig(cfg config) error {
	path := activeConfigPath
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	bell := "0"
	if cfg.Bell {
		bell = "1"
	}
	body := fmt.Sprintf("BASE_URL=%s\nSESSION=%s\nLAST_CHANNEL=%d\nTHEME=%s\nBELL=%s\n",
		cfg.BaseURL, cfg.Session, cfg.LastChannel, cfg.Theme, bell)
	return os.WriteFile(path, []byte(body), 0o600)
}

// login prompts for credentials and stores the session. The password is read
// with echo off; everything else is a plain line read.
// Format: slock-cli login <base-url> [<profile-name>]
func login(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: slock-cli login <base-url> [<profile-name>]")
	}
	base := strings.TrimRight(args[0], "/")
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "https://" + base
	}

	// Resolve profile name if provided.
	if len(args) > 1 {
		profile := args[1]
		if !isValidProfileName(profile) {
			return fmt.Errorf("invalid profile name: %s", profile)
		}
		activeConfigPath = resolveConfigPath(profile)
	}

	rd := bufio.NewReader(os.Stdin)
	fmt.Print("email: ")
	email, err := rd.ReadString('\n')
	if err != nil {
		return err
	}
	fmt.Print("password: ")
	pw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return err
	}

	c := NewClient(base, "")
	user, token, err := c.Login(strings.TrimSpace(email), string(pw))
	if err != nil {
		return err
	}
	if err := saveConfig(config{BaseURL: base, Session: token}); err != nil {
		return err
	}
	fmt.Printf("signed in as %s — run `slock-cli` to chat\n", user.DisplayName)
	return nil
}

// ---------------------------------------------------------------------------
// app state
// ---------------------------------------------------------------------------

// chanState is the per-channel message cache, mirroring the web client's.
type chanState struct {
	msgs    []Message
	seen    map[int64]bool // ids already appended, for SSE dedupe
	loaded  bool
	hasMore bool
}

type App struct {
	scr *screen
	api *Client
	cfg config

	me            User
	version       string
	workspaceName string
	users         map[int64]*User
	channels      map[int64]*Channel
	online        map[int64]bool
	chans         map[int64]*chanState
	current       int64

	// ui
	w, h         int
	chatW        int     // chat width of the last frame, for mouse hit-testing
	sideRows     []int64 // channel id per sidebar row of the last frame
	scroll       int     // lines above the live tail; 0 = pinned to bottom
	input        editor
	editing      int64 // message id being edited, 0 otherwise
	switcher     *switcher
	typing       map[int64]map[int64]time.Time
	connected    bool
	flash        string
	flashUntil   time.Time
	mouseEnabled bool // mouse capture toggle

	lastReadSent map[int64]int64
	quit         bool
	fatal        error
}

func (a *App) chanState(id int64) *chanState {
	st := a.chans[id]
	if st == nil {
		st = &chanState{seen: map[int64]bool{}}
		a.chans[id] = st
	}
	return st
}

func (a *App) channelName(ch *Channel) string {
	if ch == nil {
		return ""
	}
	if ch.Kind == KindDM {
		if ch.PeerUserID != nil {
			if u := a.users[*ch.PeerUserID]; u != nil {
				return u.DisplayName
			}
		}
		return "Direct message"
	}
	return ch.Name
}

// sortedChannels mirrors the web rail: public channels for everyone, private
// only when a member; members first, then alphabetical.
func (a *App) sortedChannels() []*Channel {
	var out []*Channel
	for _, ch := range a.channels {
		if ch.Kind != KindChannel {
			continue
		}
		if ch.IsPrivate && !ch.IsMember {
			continue
		}
		out = append(out, ch)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsMember != out[j].IsMember {
			return out[i].IsMember
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func (a *App) sortedDMs() []*Channel {
	var out []*Channel
	for _, ch := range a.channels {
		if ch.Kind == KindDM {
			out = append(out, ch)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		ti, tj := time.Time{}, time.Time{}
		if out[i].LastMessageAt != nil {
			ti = *out[i].LastMessageAt
		}
		if out[j].LastMessageAt != nil {
			tj = *out[j].LastMessageAt
		}
		if !ti.Equal(tj) {
			return ti.After(tj)
		}
		return out[i].ID > out[j].ID
	})
	return out
}

func (a *App) setFlash(msg string) {
	a.flash = msg
	a.flashUntil = time.Now().Add(4 * time.Second)
}

// sys appends a local system line to the current channel — command output and
// errors live in the chat pane but never on the server.
func (a *App) sys(text string) {
	st := a.chanState(a.current)
	st.msgs = append(st.msgs, Message{Body: text, CreatedAt: time.Now(), Local: true})
	a.scroll = 0
}

func (a *App) typingLine() string {
	m := a.typing[a.current]
	now := time.Now()
	var names []string
	for uid, exp := range m {
		if exp.After(now) {
			if u := a.users[uid]; u != nil {
				names = append(names, u.DisplayName)
			}
		}
	}
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0] + " is typing…"
	default:
		return "several people are typing…"
	}
}

// ---------------------------------------------------------------------------
// startup + event loop
// ---------------------------------------------------------------------------

func run() error {
	cfg, err := loadConfig()
	if err != nil || cfg.BaseURL == "" || cfg.Session == "" {
		return fmt.Errorf("not signed in — run: slock-cli login <base-url>")
	}
	applyTheme(cfg.Theme)

	a := &App{
		api:          NewClient(cfg.BaseURL, cfg.Session),
		cfg:          cfg,
		users:        map[int64]*User{},
		channels:     map[int64]*Channel{},
		online:       map[int64]bool{},
		chans:        map[int64]*chanState{},
		typing:       map[int64]map[int64]time.Time{},
		lastReadSent: map[int64]int64{},
		mouseEnabled: true, // enabled by default
	}

	if a.me, err = a.api.Me(); err != nil {
		return err
	}
	a.version = a.api.Version()
	a.workspaceName = a.api.Workspace()
	if a.workspaceName == "" {
		a.workspaceName = "slock"
	}
	users, err := a.api.Users()
	if err != nil {
		return err
	}
	for i := range users {
		u := users[i]
		a.users[u.ID] = &u
	}
	if err := a.refetchChannels(); err != nil {
		return err
	}

	// Pick the opening channel: last visited if still visible, else the first
	// member channel, else anything.
	target := cfg.LastChannel
	if a.channels[target] == nil {
		target = 0
	}
	if target == 0 {
		for _, ch := range a.sortedChannels() {
			if ch.IsMember {
				target = ch.ID
				break
			}
		}
	}
	if target == 0 {
		if cs := a.sortedChannels(); len(cs) > 0 {
			target = cs[0].ID
		} else if dms := a.sortedDMs(); len(dms) > 0 {
			target = dms[0].ID
		}
	}

	scr, err := openScreen()
	if err != nil {
		return err
	}
	a.scr = scr
	// A panic must restore the terminal before it prints its trace.
	defer func() {
		scr.close()
		if r := recover(); r != nil {
			panic(r)
		}
	}()

	if target != 0 {
		a.openChannel(target)
	}

	keys := make(chan key, 32)
	go readKeys(keys)

	sse := make(chan sseEvent, 64)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runSSE(ctx, a.api, sse)

	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)

	tick := time.NewTicker(time.Second)
	defer tick.Stop()

	a.draw()
	for !a.quit {
		select {
		case k := <-keys:
			a.handleKey(k)
		case ev := <-sse:
			a.handleSSE(ev)
		case <-winch:
		case now := <-tick.C:
			if a.flash != "" && now.After(a.flashUntil) {
				a.flash = ""
			}
		}
		if a.quit {
			break
		}
		a.draw()
	}

	scr.close()
	a.cfg.LastChannel = a.current
	_ = saveConfig(a.cfg)
	return a.fatal
}

// ---------------------------------------------------------------------------
// channels & messages
// ---------------------------------------------------------------------------

const historyPage = 100

func (a *App) refetchChannels() error {
	chans, dms, err := a.api.Channels()
	if err != nil {
		return err
	}
	seen := map[int64]bool{}
	for _, list := range [][]Channel{chans, dms} {
		for i := range list {
			ch := list[i]
			seen[ch.ID] = true
			a.channels[ch.ID] = &ch
		}
	}
	// Drop channels the server no longer reports (left private ones), except
	// the one being viewed.
	for id := range a.channels {
		if !seen[id] && id != a.current {
			delete(a.channels, id)
		}
	}
	return nil
}

func (a *App) openChannel(id int64) {
	ch := a.channels[id]
	if ch == nil {
		return
	}
	a.current = id
	a.scroll = 0
	a.editing = 0
	a.input.set("")

	st := a.chanState(id)
	if !st.loaded {
		msgs, more, err := a.api.Messages(id, 0, 0, historyPage)
		if err != nil {
			a.fail(err)
			return
		}
		st.msgs = msgs
		st.seen = map[int64]bool{}
		for _, m := range msgs {
			st.seen[m.ID] = true
		}
		st.loaded = true
		st.hasMore = more
	}
	a.markRead()
}

// loadOlder prepends one page of history; scroll counts from the bottom so
// the viewport stays put.
func (a *App) loadOlder() {
	st := a.chanState(a.current)
	if !st.loaded || !st.hasMore {
		return
	}
	var oldest int64
	for _, m := range st.msgs {
		if m.ID != 0 {
			oldest = m.ID
			break
		}
	}
	if oldest == 0 {
		return
	}
	msgs, more, err := a.api.Messages(a.current, oldest, 0, historyPage)
	if err != nil {
		a.fail(err)
		return
	}
	st.hasMore = more
	var fresh []Message
	for _, m := range msgs {
		if !st.seen[m.ID] {
			fresh = append(fresh, m)
			st.seen[m.ID] = true
		}
	}
	st.msgs = append(fresh, st.msgs...)
}

// markRead advances the server-side cursor when the live tail is on screen.
func (a *App) markRead() {
	if a.scroll != 0 {
		return
	}
	ch := a.channels[a.current]
	st := a.chanState(a.current)
	if ch == nil || !ch.IsMember || !st.loaded {
		return
	}
	var last int64
	for i := len(st.msgs) - 1; i >= 0; i-- {
		if st.msgs[i].ID != 0 && !st.msgs[i].Local {
			last = st.msgs[i].ID
			break
		}
	}
	if last == 0 || (a.lastReadSent[ch.ID] == last && ch.UnreadCount == 0) {
		return
	}
	a.lastReadSent[ch.ID] = last
	ch.UnreadCount = 0
	if err := a.api.MarkRead(ch.ID, last); err != nil {
		delete(a.lastReadSent, ch.ID)
		a.fail(err)
	}
}

// fail routes an API error: 401 quits with the login hint, anything else is a
// transient status flash.
func (a *App) fail(err error) {
	if err == nil {
		return
	}
	if err == errUnauthorized {
		a.fatal = err
		a.quit = true
		return
	}
	a.setFlash("error: " + err.Error())
}

// ---------------------------------------------------------------------------
// keyboard dispatch
// ---------------------------------------------------------------------------

func (a *App) handleKey(k key) {
	if a.switcher != nil {
		a.switcherKey(k)
		return
	}
	switch k.kind {
	case keyCtrlC, keyCtrlQ:
		a.quit = true
	case keyCtrlK:
		a.openSwitcher()
	case keyEnter:
		a.submit()
	case keyEsc:
		if a.editing != 0 {
			a.editing = 0
		}
		a.input.set("")
	case keyBackspace:
		a.input.backspace()
	case keyDelete:
		a.input.del()
	case keyCtrlU:
		a.input.killToStart()
	case keyCtrlW:
		a.input.killWord()
	case keyLeft:
		a.input.left()
	case keyRight:
		a.input.right()
	case keyHome:
		a.input.home()
	case keyEnd:
		if len(a.input.runes) > 0 {
			a.input.end()
		} else {
			a.scroll = 0
			a.markRead()
		}
	case keyUp:
		if len(a.input.runes) == 0 && a.editing == 0 {
			a.editLast()
		}
	case keyPgUp:
		a.scrollUp(max(4, a.h-6))
	case keyPgDn:
		a.scrollDown(max(4, a.h-6))
	case keyMouse:
		a.handleMouse(k)
	case keyRune:
		a.input.insert(k.r)
	}
}

// scrollUp moves n lines toward history, fetching an older page when the
// viewport nears the top of what is loaded. Wheel and PgUp share it.
func (a *App) scrollUp(n int) {
	page := max(4, a.h-4)
	chatW := a.w - sidebarW - 2
	if a.w < 56 {
		chatW = a.w - 1
	}
	total := len(a.chatLines(chatW))
	// Clamp scroll so the first line stays at the top and we show a full chatH of lines.
	// No top bar now; status + input on bottom = 2 rows. Chat height = h - 2.
	chatH := a.h - 2
	a.scroll = min(a.scroll+n, max(0, total-chatH))
	st := a.chanState(a.current)
	if st.hasMore && total-a.scroll < page*2 {
		a.loadOlder()
	}
}

// scrollDown moves n lines toward the live tail, re-anchoring (and marking
// read) when it gets there.
func (a *App) scrollDown(n int) {
	a.scroll -= n
	if a.scroll <= 0 {
		a.scroll = 0
		a.markRead()
	}
}

// handleMouse resolves clicks and wheel notches against the last-drawn frame:
// wheel scrolls the chat, a left press on the rail opens that channel.
// Only processes mouse events if mouseEnabled is true.
func (a *App) handleMouse(k key) {
	if !a.mouseEnabled {
		return
	}
	switch {
	case k.mouseBtn == mouseWheelUp:
		a.scrollUp(3)
	case k.mouseBtn == mouseWheelDown:
		a.scrollDown(3)
	case k.mouseBtn == mouseLeft && k.mousePress:
		// Sidebar starts one column right of the chat (separator between).
		if k.mouseX <= a.chatW+1 {
			return
		}
		// Chat area starts at row 1. Sidebar header is rows 1-2.
		// Sidebar content (a.sideRows) starts at row 3, but is offset by 2 in the array.
		row := k.mouseY - 1
		if row >= 0 && row < len(a.sideRows) && a.sideRows[row] != 0 {
			a.openChannel(a.sideRows[row])
		}
	}
}

func (a *App) submit() {
	text := strings.TrimSpace(a.input.String())
	if text == "" {
		return
	}
	// Check if it's a command (starts with / and matches known prefixes)
	if strings.HasPrefix(text, "/slock") || strings.HasPrefix(text, "/theme") ||
		strings.HasPrefix(text, "/bell") || strings.HasPrefix(text, "/upload") ||
		strings.HasPrefix(text, "/mouse") {
		a.input.set("")
		a.runCommand(text)
		return
	}
	if a.editing != 0 {
		id := a.editing
		a.editing = 0
		a.input.set("")
		if msg, err := a.api.Edit(id, text); err != nil {
			a.fail(err)
		} else {
			a.applyMessageUpdate(msg)
		}
		return
	}
	a.input.set("")
	msg, err := a.api.Send(a.current, text)
	if err != nil {
		a.fail(err)
		return
	}
	a.appendMessage(msg)
	a.scroll = 0
	a.markRead()
}

// editLast puts the caller's newest message into the input for a PATCH.
func (a *App) editLast() {
	st := a.chanState(a.current)
	for i := len(st.msgs) - 1; i >= 0; i-- {
		m := st.msgs[i]
		if m.UserID == a.me.ID && m.ID != 0 && m.DeletedAt == nil && !m.Local {
			a.editing = m.ID
			a.input.set(m.Body)
			return
		}
	}
}

// ---------------------------------------------------------------------------
// SSE frames → state
// ---------------------------------------------------------------------------

func (a *App) appendMessage(m Message) {
	st := a.chanState(m.ChannelID)
	if !st.loaded || st.seen[m.ID] {
		return
	}
	st.seen[m.ID] = true
	st.msgs = append(st.msgs, m)
}

func (a *App) applyMessageUpdate(m Message) {
	st := a.chanState(m.ChannelID)
	for i := range st.msgs {
		if st.msgs[i].ID == m.ID {
			m.Local = false
			st.msgs[i] = m
			return
		}
	}
}

func (a *App) handleSSE(ev sseEvent) {
	switch ev.Type {
	case "__down":
		a.connected = false
		return
	case "__unauthorized":
		a.fatal = errUnauthorized
		a.quit = true
		return
	}

	switch ev.Type {
	case "hello":
		var d struct {
			Online  []int64 `json:"online"`
			Version string  `json:"version"`
		}
		json.Unmarshal(ev.Data, &d)
		wasDown := !a.connected
		a.connected = true
		if d.Version != "" {
			a.version = d.Version
		}
		a.online = map[int64]bool{}
		for _, id := range d.Online {
			a.online[id] = true
		}
		if wasDown {
			a.gapFill()
		}

	case "message.new":
		var d struct {
			Message Message `json:"message"`
			User    *User   `json:"user"`
		}
		if json.Unmarshal(ev.Data, &d) != nil {
			return
		}
		// The frame carries the sender; a user we have never listed (a fresh
		// bot, say) gets at least a name instead of "?".
		if d.User != nil && a.users[d.User.ID] == nil {
			u := *d.User
			a.users[u.ID] = &u
		}
		ch := a.channels[d.Message.ChannelID]
		if ch == nil {
			_ = a.refetchChannels()
			ch = a.channels[d.Message.ChannelID]
		}
		a.appendMessage(d.Message)
		if ch != nil {
			now := d.Message.CreatedAt
			ch.LastMessageAt = &now
			if d.Message.UserID != a.me.ID {
				if a.cfg.Bell {
					os.Stdout.WriteString("\a")
				}
				if d.Message.ChannelID == a.current && a.scroll == 0 {
					a.markRead()
				} else {
					ch.UnreadCount++
				}
			}
		}
		// The sender stopped typing by definition.
		if t := a.typing[d.Message.ChannelID]; t != nil {
			delete(t, d.Message.UserID)
		}

	case "message.update":
		var d struct {
			Message Message `json:"message"`
		}
		if json.Unmarshal(ev.Data, &d) == nil {
			a.applyMessageUpdate(d.Message)
		}

	case "message.delete":
		var d struct {
			MessageID int64 `json:"message_id"`
			ChannelID int64 `json:"channel_id"`
		}
		if json.Unmarshal(ev.Data, &d) != nil {
			return
		}
		st := a.chanState(d.ChannelID)
		for i := range st.msgs {
			if st.msgs[i].ID == d.MessageID {
				now := time.Now()
				st.msgs[i].DeletedAt = &now
				st.msgs[i].Body = ""
			}
		}

	case "reaction":
		var d struct {
			MessageID int64      `json:"message_id"`
			ChannelID int64      `json:"channel_id"`
			Reactions []Reaction `json:"reactions"`
		}
		if json.Unmarshal(ev.Data, &d) != nil {
			return
		}
		st := a.chanState(d.ChannelID)
		for i := range st.msgs {
			if st.msgs[i].ID == d.MessageID {
				st.msgs[i].Reactions = d.Reactions
			}
		}

	case "channel.new", "channel.update":
		var d struct {
			Channel Channel `json:"channel"`
		}
		if json.Unmarshal(ev.Data, &d) == nil {
			c := d.Channel
			a.channels[c.ID] = &c
		}

	case "channel.members":
		var d struct {
			ChannelID   int64   `json:"channel_id"`
			Members     []int64 `json:"members"`
			MemberCount int     `json:"member_count"`
		}
		if json.Unmarshal(ev.Data, &d) != nil {
			return
		}
		ch := a.channels[d.ChannelID]
		if ch == nil {
			return
		}
		ch.Members = d.Members
		ch.MemberCount = d.MemberCount
		if ch.Kind == KindChannel {
			ch.IsMember = false
			for _, id := range d.Members {
				if id == a.me.ID {
					ch.IsMember = true
				}
			}
			// Removed from a private channel: it is gone for good.
			if ch.IsPrivate && !ch.IsMember {
				a.dropChannel(ch.ID)
			}
		}

	case "channel.read":
		var d struct {
			ChannelID int64 `json:"channel_id"`
		}
		if json.Unmarshal(ev.Data, &d) == nil {
			if ch := a.channels[d.ChannelID]; ch != nil {
				ch.UnreadCount = 0
			}
		}

	case "channel.mute":
		var d struct {
			ChannelID int64 `json:"channel_id"`
			Muted     bool  `json:"muted"`
		}
		if json.Unmarshal(ev.Data, &d) == nil {
			if ch := a.channels[d.ChannelID]; ch != nil {
				ch.Muted = d.Muted
			}
		}

	case "presence":
		var d struct {
			UserID int64 `json:"user_id"`
			Online bool  `json:"online"`
		}
		if json.Unmarshal(ev.Data, &d) == nil {
			a.online[d.UserID] = d.Online
		}

	case "typing":
		var d struct {
			ChannelID int64 `json:"channel_id"`
			UserID    int64 `json:"user_id"`
		}
		if json.Unmarshal(ev.Data, &d) == nil {
			if a.typing[d.ChannelID] == nil {
				a.typing[d.ChannelID] = map[int64]time.Time{}
			}
			a.typing[d.ChannelID][d.UserID] = time.Now().Add(4 * time.Second)
		}

	case "user.update":
		var d struct {
			User User `json:"user"`
		}
		if json.Unmarshal(ev.Data, &d) == nil {
			u := d.User
			a.users[u.ID] = &u
		}
	}
}

// gapFill resyncs after a reconnect: fresh channel list, plus the messages the
// current channel missed while the stream was down.
func (a *App) gapFill() {
	if err := a.refetchChannels(); err != nil {
		a.fail(err)
		return
	}
	st := a.chanState(a.current)
	if !st.loaded {
		return
	}
	var newest int64
	for i := len(st.msgs) - 1; i >= 0; i-- {
		if st.msgs[i].ID != 0 && !st.msgs[i].Local {
			newest = st.msgs[i].ID
			break
		}
	}
	if newest == 0 {
		return
	}
	msgs, _, err := a.api.Messages(a.current, 0, newest, historyPage)
	if err != nil {
		a.fail(err)
		return
	}
	for _, m := range msgs {
		a.appendMessage(m)
	}
	a.markRead()
}

// dropChannel forgets a channel entirely and moves the view somewhere sane.
func (a *App) dropChannel(id int64) {
	delete(a.channels, id)
	delete(a.chans, id)
	if a.current == id {
		a.current = 0
		for _, ch := range a.sortedChannels() {
			if ch.IsMember {
				a.openChannel(ch.ID)
				return
			}
		}
		if cs := a.sortedChannels(); len(cs) > 0 {
			a.openChannel(cs[0].ID)
		}
	}
}
