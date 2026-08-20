# slock client contract

`web/assets/` is split between two authors, so the seam between markup and
behaviour is written down here.

- **`index.html`, `login.html`, `reset.html`, `style.css`, `manifest.webmanifest`, `icons/`**
  own the structure and all visual design.
- **`app.js`, `sw.js`** own behaviour. `app.js` never writes CSS values; it
  toggles the classes and attributes listed below.

Plain HTML/CSS/JS. No framework, no build step, no bundler, no external fonts
or CDN requests — a strict same-origin CSP is enforced by the server. `app.js`
is loaded as `<script type="module" src="/app.js"></script>`.

## Rule of thumb

Every id below must exist in the markup with that exact id. Anything else —
extra wrappers, decorative elements, class names, the entire look — is the
markup author's call. JS clones `<template>` elements rather than writing HTML
strings, so the templates are where message/row structure lives.

## Page shell (`index.html`)

```
#app                        layout root
  #sidebar                  the channel/DM pane
    #workspace-name         the workspace name, admin-editable
    #workspace-icon         <img> for the admin-set icon, JS toggles [hidden]
    .workspace-logo         the built-in SVG mark, shown when there is no icon
    #search-trigger         icon button beside the workspace name — opens the
                        palette (magnifier + "⌘K" hint)
    #channel-list           <ul>, JS fills with #tpl-channel-item clones
    #dm-list                <ul>, JS fills with #tpl-dm-item clones
    #new-channel-btn        button
    #new-dm-btn             button
    #me-chip                current user button (opens #me-menu)
      #me-avatar  #me-name
    #me-menu                popup: #profile-btn #admin-btn #theme-btn
                            #notifications-btn #logout-btn (message density,
                            sidebar side and view zoom moved into the profile
                            modal)
    #side-resize            desktop drag handle on the sidebar's inner edge;
                            resizes --sidebar-w (double-click resets), width
                            persists in localStorage["slock:sidebar-width"]
  #main
    #channel-header
      #nav-toggle           mobile hamburger (hidden on desktop by CSS)
      #title-lock           small svg lock, JS shows it for private channels
                            (whose title is then the bare name, no sigil)
      #channel-title        e.g. "# design" or a person's name
      #channel-topic        sits inline to the right of the title; JS toggles
                            [hidden] when the channel has no topic
      #channel-actions      holds #members-btn, #join-btn, #mute-btn (bell icon,
                      `.bell-plain`/`.bell-slash` toggled by mute state),
                      #files-btn (channel attachments modal), #info-btn,
                      #close-dm-btn (DMs only: hides the conversation from
                      the rail on this device — localStorage
                      ["slock:closed-dms"], purely visual, server untouched;
                      a new message or reopening via the palette restores it)
    #message-scroll         the scroll container
      #message-loader       "loading older messages" spinner, JS toggles [hidden]
      #message-list         messages go here, oldest first
    #jump-latest            button, appears when scrolled up
    #typing-indicator       JS sets textContent only (in-flow, line reserved;
                            empty text means nobody is typing)
    #composer               <form>
      #composer-mode        edit-mode bar, JS toggles [hidden]; holds
                            .composer-mode-label and #composer-cancel (button)
      #attachment-tray      pending uploads, JS toggles [hidden]
      #composer-input       <textarea>
      #attach-btn           button
      #file-input           <input type=file multiple hidden>
      #send-btn             submit
#palette                    Ctrl/⌘+K overlay, JS toggles [hidden]
  #palette-input            <input>
  #palette-hint             the "from:@user in:#channel" hint line
  #palette-results          <ul>
  #palette-empty            empty state, JS toggles [hidden]
#lightbox                   image viewer, JS toggles [hidden]; ←/→, the
                            #lightbox-prev/#lightbox-next arrows and swiping
                            step through the surrounding gallery; clicking the
                            image toggles .lightbox--zoomed (swaps in the
                            full-resolution original, natural size, panned by
                            scrolling)
  #lightbox-img  #lightbox-caption  #lightbox-download  #lightbox-close
#modal-root                 JS mounts dialogs here (see below)
#toasts                     JS appends .toast elements
#connection-banner          "Reconnecting…", JS toggles [hidden]
```

The composer is a `<textarea>`: Enter sends, Shift+Enter newlines, and JS
auto-grows it by setting `style.height` (the only inline style JS writes).

## Templates (in `index.html`, inside `<template>`)

Each lists the classes JS looks for. Nest them however the design needs.

### Avatars

Every avatar spot — `.msg-avatar`, `.dm-avatar`, `.member-avatar`, `#me-avatar`
and `.avatar-preview` — has the same two children, because a user may or may
not have uploaded a picture:

```html
<span class="avatar-initials"></span>
<img class="avatar-img" alt="" hidden>
```

JS sets `dataset.color` on the avatar element, `textContent` on
`.avatar-initials`, and either points `.avatar-img` at `user.avatar_url` and
unhides it, or leaves it hidden so the coloured initials show. JS must never
write `textContent` on the avatar element itself — that would delete the image.

- `#tpl-message` → root `.msg` (JS sets `dataset.id`, `dataset.userId`,
  `.msg--own`, `.msg--compact` for same-author runs, `.msg--deleted`,
  `.msg--pending`, `.msg--unread-start`)
  - `.msg-avatar` (an avatar element — see Avatars above)
  - `.msg-author`, `.msg-time`, `.msg-edited` (JS toggles `[hidden]`)
  - `.msg-body` — JS sets rendered content
  - `.msg-attachments` — JS appends attachment clones
  - `.msg-reactions` — JS appends `#tpl-reaction` clones
  - `.msg-actions` with `.msg-react`, `.msg-reply` (quotes the body into the
    composer as `> ` lines; hidden for body-less messages), `.msg-edit`,
    `.msg-delete`, `.msg-copy`
  - clicking `.msg-author` or `.msg-avatar` opens the author's DM (pointer
    cursor only — deliberately no link styling)
- `#tpl-day-divider` → `.day-divider` with `.day-divider-label`
- `#tpl-channel-item` → `.chan` (dataset.id; classes `.chan--active`,
  `.chan--unread`, `.chan--muted`, `.chan--member`, `.chan--private` — CSS
  swaps the `.chan-hash` icon for `.chan-lock` on private channels)
  - `.chan-name`, `.chan-badge` (unread count, JS toggles `[hidden]`)
- `#tpl-dm-item` → `.dm` (dataset.id, dataset.userId; `.dm--active`,
  `.dm--unread`, `.dm--online`)
  - `.dm-avatar`, `.dm-name`, `.dm-badge`, `.dm-presence`
- `#tpl-attachment-image` → `.att-img` containing `img.att-img-el`
- `#tpl-attachment-file` → `.att-file` with `.att-file-name`,
  `.att-file-meta` (size), and an `a.att-file-link`
- `#tpl-reaction` → `button.reaction` (dataset.emoji; `.reaction--mine`)
  with `.reaction-emoji`, `.reaction-count`
- `#tpl-tray-item` → `.tray-item` with `.tray-item-name`,
  `.tray-item-progress`, `.tray-item-remove`
- `#tpl-palette-item` → `li.pal-item` (dataset.kind = `channel|dm|user|search`,
  dataset.id; `.pal-item--active` for keyboard focus)
  with `.pal-item-icon`, `.pal-item-title`, `.pal-item-sub`
- `#tpl-search-result` → `li.pal-item.pal-result` with `.res-channel`,
  `.res-author`, `.res-time`, `.res-snippet`
- `#tpl-toast` → `.toast` with `.toast-text` (JS adds `.toast--error`)
- `#tpl-member-row` → `.member` with `.member-avatar`, `.member-name`,
  `.member-meta`, `.member-remove`

## Dialogs

Markup provides one `<template>` per dialog; JS clones into `#modal-root`,
which uses `.modal-open` on `<body>` for scroll locking. Close buttons carry
`.modal-close`; the backdrop is `.modal-backdrop`.

- `#tpl-modal-new-channel` → form `.mform` with `[name=name]`, `[name=topic]`,
  `[name=is_private]`, `.mform-error`, submit `.mform-submit`
- `#tpl-modal-new-dm` → `.dm-picker-input`, `.dm-picker-list`
- `#tpl-modal-members` → `.members-list`, `.member-add-input`,
  `.member-add-list`, `.members-title`
- `#tpl-modal-profile` → `[name=display_name]`, `[name=status_text]`,
  `.color-swatches` (JS fills with `button.swatch[data-color]`),
  `.mform-error`, `.mform-submit`, `.mform-about` (small print: repo link and
  `.about-version`, which JS fills with the running build), plus the picture
  controls:
  `.avatar-preview` (an avatar element, see above), `.avatar-upload` (button),
  `.avatar-file` (`input[type=file][accept="image/*"]`, hidden — the button
  clicks it), `.avatar-remove` (button, JS hides it when there is no picture),
  plus the device-local appearance controls: `.combo-swatches` (JS fills with
  `button.combo` preset pairs), `.combo-sidebar` / `.combo-chat`
  (`input[type=color]`) and `.combo-reset` — these save to
  `localStorage["slock:colors"]` and apply immediately, outside the form submit;
  plus display prefs: `.seg[data-setting=density|side]` segmented toggles, the
  zoom stepper (`.zoom-range`, `.zoom-step[data-dir]`, `.zoom-val` — click to
  reset to 100%) and the font picker (`.font-select`, JS fills it with curated
  stacks minus faces `document.fonts.check` rules out, plus a Custom… entry
  that reveals `.font-custom` free text and an Upload… entry that clicks the
  hidden `.font-file` input — the uploaded face is stored in IndexedDB, listed
  as "Uploaded: <name>", and `.font-remove` deletes it), all device-local and
  applied on change
- `#tpl-modal-password` → `[name=current_password]`, `[name=new_password]`,
  `[name=confirm_password]`, `.mform-error`, `.mform-submit`
  (JS force-opens this when `must_change_pw` is true and hides its close button
  by adding `.modal--forced`)
- `#tpl-modal-admin` → `.admin-users` (tbody; JS clones `#tpl-admin-row`),
  `.admin-new-form` with `[name=email]`, `[name=display_name]`,
  `[name=is_admin]`, `.admin-new-result` (shows the temp password), `.mform-error`,
  plus a workspace section: `.ws-form` with `[name=workspace_name]` and
  `.ws-save`, `.ws-icon-preview` (an `<img>`), `.ws-icon-upload` (button),
  `.ws-icon-file` (hidden `input[type=file][accept="image/*"]`),
  `.ws-icon-remove` (button, JS hides it when there is no icon), `.ws-error`
- `#tpl-modal-admin` also carries the API-token section: `.tok-form` with
  `[name=token_name]`, `[name=token_scope]` and `.tok-create`; `.tok-list`
  (JS clones `#tpl-token-row` into it); `.tok-result` where the generated
  secret is shown once, with `.tok-secret` and `.tok-copy`; and `.tok-error`
- `#tpl-token-row` → `.trow` (dataset.id) with `.trow-name`, `.trow-scope`,
  `.trow-used` (last used, or "never"), `.trow-active-toggle` (checkbox) and
  `.trow-delete`
- `#tpl-admin-row` → `.arow` with `.arow-name`, `.arow-email`, `.arow-badges`,
  `.arow-admin-toggle`, `.arow-active-toggle`, `.arow-reset`
- `#tpl-modal-confirm` → `.confirm-text`, `.confirm-ok`, `.confirm-cancel`
- `#tpl-modal-files` → `.files-title`, `.files-list`, `.files-empty`,
  `.files-more` (pagination button)
- `#tpl-file-row` → `.frow` with `.frow-thumb` (`.frow-img` for images —
  clicking it opens the lightbox — else `.frow-icon`), `.frow-name`
  (download link) and `.frow-meta`

## State classes JS sets

| Target | Class / attribute | Meaning |
|---|---|---|
| `<html>` | `data-theme="dark"` / `"light"` | theme choice (default: follow system) |
| `<html>` | `--zoom` (inline style) | view zoom factor, 1 = 100% (`localStorage["slock:zoom"]`); `#app` divides its size by it and sets `zoom` so the scaled view still fills the viewport |
| `<html>` | `--font-sans` (inline style) | UI font stack override (`localStorage["slock:font"]`, absent = stylesheet default); the whole interface derives from this token. An uploaded font's bytes live in IndexedDB (`slock`/`fonts`) and register as the `slock-custom` family at boot |
| `<body>` | `.side-right` / `.side-left` | which side the sidebar sits on |
| `<body>` | `.density-compact` | compact messages: no avatar column, author + time inline (`localStorage["slock:density"]`) |
| `<body>` | `.nav-open` | mobile drawer open |
| `<body>` | `.nav-dragging` | a finger is dragging the drawer; CSS must drop the
  sidebar's transition so it tracks the touch, and JS sets `--nav-drag` (0..1) on
  `<body>` for the partial position |
| `<body>` | `.modal-open` | a dialog is mounted |
| `#app` | `.is-offline` | SSE disconnected |
| `#palette` | `[hidden]` | closed |

Default is `.side-left`; the profile modal's Sidebar toggle switches to
`.side-right` and the choice persists in `localStorage`.

Custom sidebar/chat colours (set in the profile modal) are applied as inline
CSS custom properties on `#sidebar` and `#main`: the picked colour becomes the
surface's base token and the rest of the token set (`--bg-*`, `--text-*`,
`--border*`, `--accent*`) is re-derived from its lightness. Each theme has its
own slot — the modal edits the active theme's — stored in
`localStorage["slock:colors"]` as `{light: {sidebar, chat}, dark: {...}}` hex
values; a missing slot falls back to the built-in default (light: Aubergine,
dark: Midnight). Both
containers set `color: var(--text-1)` so inherited text re-resolves against
the overridden tokens.

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl/⌘+K` | open palette |
| `Esc` | close palette / lightbox / modal, else clear composer focus |
| `↑` `↓` `Enter` | move and pick in the palette |
| `↑` in an empty composer | edit your last message |
| `Enter` / `Shift+Enter` | send / newline |
| `Ctrl/⌘+Shift+K` | new DM |

## Login pages

`login.html`: `#login-form` with `[name=email]`, `[name=password]`,
`#login-error`, `#login-submit`, `#forgot-link`, and `#forgot-form`
(`[name=email]`, `#forgot-error`, `#forgot-done`). Its behaviour is small
enough to live in an inline-free `login.js`. `reset.html`: `#reset-form` with
`[name=new_password]`, `[name=confirm_password]`, `#reset-error`, reading the
token from `?token=`.

## PWA

- `manifest.webmanifest`: name `slock`, `display: standalone`,
  `start_url: /`, `theme_color`/`background_color` matching the design, icons
  at 192/512 plus a maskable 512 and a monochrome 96 badge, all in `icons/`.
- `sw.js`: precache the shell, network-first for navigations, cache-first for
  `/icons/*`, never cache `/api/*`. Handles `push` (show notification, set
  `navigator.setAppBadge(badge)`) and `notificationclick` (focus an existing
  client and `postMessage({type:'navigate', url})`, else open the url).
