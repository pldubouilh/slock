// Package webui embeds the static client so the binary ships alone.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:assets
var embedded embed.FS

// FS is the client asset tree rooted at the directory holding index.html.
var FS fs.FS

func init() {
	sub, err := fs.Sub(embedded, "assets")
	if err != nil {
		panic(err)
	}
	FS = sub
}
