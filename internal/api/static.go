package api

import (
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"slock/internal/httpx"
	webui "slock/web"
)

// extraMimeTypes covers extensions Go's mime package does not know from its
// built-in table. It must not rely on /etc/mime.types: that file does not exist
// in the runtime container, so anything missing here would be sniffed instead —
// and because every response carries X-Content-Type-Options: nosniff, a sniffed
// type cannot be corrected by the browser. A manifest served as text/plain is
// rejected outright by Chrome, which silently costs you the install prompt.
var extraMimeTypes = map[string]string{
	".webmanifest": "application/manifest+json",
	".ico":         "image/x-icon",
	".woff2":       "font/woff2",
}

// contentTypeFor returns the type to serve name as, or "" to let net/http decide.
func contentTypeFor(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ct, ok := extraMimeTypes[ext]; ok {
		return ct
	}
	return mime.TypeByExtension(ext)
}

// assetFS resolves to the on-disk directory in dev mode, otherwise the embedded tree.
func (s *Server) assetFS() fs.FS {
	if s.Cfg.DevWebDir != "" {
		return os.DirFS(s.Cfg.DevWebDir)
	}
	return webui.FS
}

// handleStatic serves the client. Unknown paths fall back to index.html so the
// app can own its routes; /api/* never reaches here except as a 404.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	upath := path.Clean("/" + r.URL.Path)

	if strings.HasPrefix(upath, "/api/") {
		httpx.JSON(w, http.StatusNotFound, &httpx.Error{Code: "not_found", Message: "No such endpoint."})
		return
	}

	name := strings.TrimPrefix(upath, "/")
	if name == "" {
		name = "index.html"
	}

	fsys := s.assetFS()
	f, err := fsys.Open(name)
	if err != nil {
		// Fall back to the app shell for client-side routes.
		name = "index.html"
		f, err = fsys.Open(name)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}
	defer f.Close()

	if st, err := f.Stat(); err == nil && st.IsDir() {
		f.Close()
		name = "index.html"
		f, err = fsys.Open(name)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer f.Close()
	}

	if ct := contentTypeFor(name); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	switch {
	case name == "sw.js":
		// The service worker must never be served stale, or updates never land.
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Service-Worker-Allowed", "/")
	case strings.HasPrefix(name, "icons/"):
		w.Header().Set("Cache-Control", "public, max-age=604800")
	default:
		w.Header().Set("Cache-Control", "no-cache")
	}

	if rs, ok := f.(io.ReadSeeker); ok {
		http.ServeContent(w, r, name, time.Time{}, rs)
		return
	}
	_, _ = io.Copy(w, f)
}
