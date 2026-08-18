package mail

import (
	"bytes"
	"fmt"
	htmltemplate "html/template"
	texttemplate "text/template"
)

// message is one mail in both flavours. The HTML side goes through
// html/template so every interpolated value is contextually escaped.
type message struct {
	text *texttemplate.Template
	html *htmltemplate.Template
}

func newMessage(name, text, html string) message {
	return message{
		text: texttemplate.Must(texttemplate.New(name + ".txt").Parse(text)),
		html: htmltemplate.Must(htmltemplate.New(name + ".html").Parse(html)),
	}
}

func render(m message, data map[string]string) (text, html string, err error) {
	var tb, hb bytes.Buffer
	if err := m.text.Execute(&tb, data); err != nil {
		return "", "", err
	}
	if err := m.html.Execute(&hb, data); err != nil {
		return "", "", err
	}
	return tb.String(), fmt.Sprintf(htmlShell, hb.String()), nil
}

// htmlShell wraps a body in the one bit of layout every mail shares. No images,
// no tracking, no external stylesheets: some clients block them and none of
// them are needed here.
const htmlShell = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d1c1d;max-width:520px">
%s
<p style="color:#616061;font-size:13px;margin-top:28px">Sent by slock.</p>
</div>`

const buttonStyle = `display:inline-block;padding:10px 18px;border-radius:6px;background:#3f6fe0;color:#ffffff;text-decoration:none;font-weight:600`

var resetTemplate = newMessage("reset",
	`Hi{{if .Name}} {{.Name}}{{end}},

We received a request to reset your slock password. Open the link below to
choose a new one:

{{.URL}}

If you did not ask for this, you can ignore this email; your password stays
as it is.

Sent by slock.
`,
	`<p>Hi{{if .Name}} {{.Name}}{{end}},</p>
<p>We received a request to reset your slock password.</p>
<p><a href="{{.URL}}" style="`+buttonStyle+`">Choose a new password</a></p>
<p style="color:#616061;font-size:13px">Or paste this into your browser: {{.URL}}</p>
<p>If you did not ask for this, you can ignore this email; your password stays as it is.</p>`)

var welcomeTemplate = newMessage("welcome",
	`Hi{{if .Name}} {{.Name}}{{end}},

An account has been created for you on slock.

Sign in: {{.URL}}
Email: {{.Email}}
Temporary password: {{.Password}}

Please change this password once you are signed in.

Sent by slock.
`,
	`<p>Hi{{if .Name}} {{.Name}}{{end}},</p>
<p>An account has been created for you on slock.</p>
<p><a href="{{.URL}}" style="`+buttonStyle+`">Sign in</a></p>
<table style="border-collapse:collapse;margin:16px 0">
<tr><td style="padding:4px 16px 4px 0;color:#616061">Email</td><td style="padding:4px 0"><strong>{{.Email}}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#616061">Temporary password</td><td style="padding:4px 0"><code style="background:#f4f4f4;padding:2px 6px;border-radius:4px">{{.Password}}</code></td></tr>
</table>
<p>Please change this password once you are signed in.</p>`)
