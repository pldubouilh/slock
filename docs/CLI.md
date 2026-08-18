# slock-cli

A terminal client for slock: chat left, channel rail right, Ctrl+K to jump anywhere. Standard library Go plus `golang.org/x/term` — no TUI framework, hand-rolled ANSI, in the same spirit as the web client.

## Install & sign in

```sh
go build ./cmd/slock-cli
./slock-cli login https://slock.example.com   # prompts email + password
./slock-cli                                   # opens the chat
```

The session (and the last open channel) persists in `~/.config/slock-cli/config`, mode 0600. When the session expires, any action exits with a hint to run `login` again.

### Multi-workspace profiles

Use named profiles to connect to multiple workspaces from the same machine. A profile is a valid name (letters, digits, dash, underscore only) that maps to a separate config file.

```sh
./slock-cli login https://workspace1.slock.com work1     # creates ~/.config/work1
./slock-cli login https://workspace2.slock.com work2     # creates ~/.config/work2
./slock-cli work1                                        # opens workspace1
./slock-cli work2                                        # opens workspace2
./slock-cli                                              # opens the default profile (~/.config/slock-cli/config)
```

Each profile maintains its own session, last-visited channel, theme, and bell settings. Profile names must contain only letters, digits, dash, and underscore; invalid names are rejected with a usage error. Respects `$XDG_CONFIG_HOME` if set, otherwise uses `~/.config`.

## Keys

| Keys | Action |
|---|---|
| type + `Enter` | send to the current channel |
| `Ctrl+K` | switcher popup: fuzzy-find channels, DMs and people (unread first) |
| `↑` (empty input) | edit your last message — `Enter` saves, `Esc` cancels |
| `PgUp` / `PgDn` | scroll history (older pages load as you go up) / back down |
| `End` (empty input) | jump to the live tail |
| `←` `→` `Home` `End` `Ctrl+U` `Ctrl+W` | line editing in the input |
| `Esc` | close popup / cancel edit / clear input |
| `Ctrl+C` or `Ctrl+Q` | quit |

The mouse works where you'd expect: wheel scrolls the chat (older history loads as you reach the top), clicking a sidebar row opens that channel, and in the Ctrl+K popup the wheel moves the selection and a click picks (clicking outside closes it). Mouse tracking captures the terminal's own selection — hold `Shift` while dragging to select/copy text the normal way, or use `/mouse` to toggle capture off temporarily.

Attachments render as download links; open them in a browser. Reactions show as a dim `👍 2` line under the message. Reading to the tail marks the channel read.

## Commands

Typed in the input; parameter hints appear while you type the command. Output appears as local dim lines, visible only to you.

### /slock commands (admin and channel management)

| Command | Does |
|---|---|
| `/slock new-user <email> <display name>` | create an account (admin); prints the temp password |
| `/slock new-channel <name> [private]` | create and switch to a channel |
| `/slock invite <display name>` | add a user to the current channel |
| `/slock mute` / `/slock unmute` | toggle push for the current channel |
| `/slock leave` | leave the current channel |
| `/slock help` | list all commands |

Admin-only commands surface the server's refusal as a local error line for everyone else.

### Top-level commands

| Command | Does |
|---|---|
| `/theme [dark\|light\|solarized\|gruvbox\|nord]` | set color theme; with no argument, show available themes and current one; persists |
| `/bell` | toggle terminal bell on incoming messages from others; persists |
| `/upload <path>` | upload a file to the current channel; `~` expands to `$HOME`; failures show as local error lines |
| `/mouse` | toggle mouse capture on/off; useful when copy/pasting is blocked by tracking; defaults to on, not persisted |

Note: `/slock theme` and `/slock bell` still work as quiet aliases for backward compatibility.

## Themes

The built-in color themes are:

- **dark**: the default, optimized for dark terminal backgrounds
- **light**: dark inks for light terminal backgrounds
- **solarized**: Solarized Dark palette
- **gruvbox**: Gruvbox palette
- **nord**: Nord palette

Set the theme with `/theme <name>`. Use `/theme` with no argument to see available themes and the current one.

You can also customize individual colors in `~/.config/slock-cli/config`:

```
COLOR_ACCENT=<0-255>        # accent color (e.g., for input prompt and selected channel)
COLOR_DANGER=<0-255>        # danger/alert color for future use
COLOR_AVATARS=<12 comma-separated 0-255 values>  # override the 12 avatar colors
```

All values use ANSI-256 color codes; malformed entries are silently ignored.
