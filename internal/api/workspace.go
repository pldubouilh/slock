package api

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strings"
	"unicode/utf8"

	"slock/internal/httpx"
	"slock/internal/media"
	"slock/internal/realtime"
	"slock/internal/version"
)

// Settings keys backing the workspace identity.
const (
	settingWorkspaceName    = "workspace_name"
	settingWorkspaceIconSHA = "workspace_icon_sha"
)

const (
	defaultWorkspaceName = "slock"
	maxWorkspaceNameLen  = 40
	maxWorkspaceIcon     = 4 << 20
)

// Workspace is the brandable identity of the install: what the sidebar and the
// sign-in page call this place.
type Workspace struct {
	Name    string `json:"name"`
	IconURL string `json:"icon_url"`
}

// loadWorkspace reads both settings in one query. Missing rows mean defaults.
func (s *Server) loadWorkspace(ctx context.Context) (*Workspace, error) {
	rows, err := s.DB.Pool.Query(ctx,
		`SELECT key, value FROM settings WHERE key = ANY($1)`,
		[]string{settingWorkspaceName, settingWorkspaceIconSHA})
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ws := &Workspace{Name: defaultWorkspaceName}
	var iconSHA string
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		switch k {
		case settingWorkspaceName:
			if v != "" {
				ws.Name = v
			}
		case settingWorkspaceIconSHA:
			iconSHA = v
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if iconSHA != "" {
		// Not named `version` — that is the package holding the build id.
		cacheKey := iconSHA
		if len(cacheKey) > 12 {
			cacheKey = cacheKey[:12]
		}
		ws.IconURL = "/api/workspace/icon?v=" + cacheKey
	}
	return ws, nil
}

func (s *Server) putSetting(ctx context.Context, key, value string) error {
	_, err := s.DB.Pool.Exec(ctx,
		`INSERT INTO settings (key, value) VALUES ($1, $2)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, key, value)
	return err
}

// publishWorkspace tells every connected client the branding changed.
func (s *Server) publishWorkspace(ws *Workspace) {
	s.Hub.PublishAll(realtime.Event{Type: "workspace.update",
		Data: map[string]any{"workspace": ws}})
}

// handleVersion reports the running build. Clients poll it and compare across
// reconnects to notice a deploy; it is unauthenticated because it is just a
// build id and the sign-in page wants it too.
func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) error {
	httpx.JSON(w, http.StatusOK, map[string]any{"version": version.String()})
	return nil
}

// handleGetWorkspace is deliberately unauthenticated: the sign-in page needs to
// know what this place is called before anyone has signed in.
func (s *Server) handleGetWorkspace(w http.ResponseWriter, r *http.Request) error {
	ws, err := s.loadWorkspace(r.Context())
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"workspace": ws})
	return nil
}

// handleManifest serves the PWA manifest with the workspace's own name baked
// in, so an installed app is called "Acme Chat" rather than "slock". Everything
// else comes from the static file, which stays the single source of truth for
// icons, colours and display mode.
//
// Browsers capture the name at install time, so renaming the workspace shows up
// on the next install or whenever the browser refreshes the manifest — it does
// not rename an already-installed app straight away.
func (s *Server) handleManifest(w http.ResponseWriter, r *http.Request) error {
	raw, err := fs.ReadFile(s.assetFS(), "manifest.webmanifest")
	if err != nil {
		return httpx.ErrNotFound
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		// A malformed asset should not take the app down; serve it verbatim.
		w.Header().Set("Content-Type", "application/manifest+json")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(raw)
		return nil
	}

	if ws, err := s.loadWorkspace(r.Context()); err == nil && ws.Name != "" {
		doc["name"] = ws.Name
		doc["short_name"] = ws.Name
	}

	body, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(body)
	return nil
}

// handleGetWorkspaceIcon serves the icon, unauthenticated for the same reason.
func (s *Server) handleGetWorkspaceIcon(w http.ResponseWriter, r *http.Request) error {
	var sha string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT value FROM settings WHERE key = $1`, settingWorkspaceIconSHA).Scan(&sha)
	if err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}
	if sha == "" {
		return httpx.ErrNotFound
	}
	return s.serveStoredImage(w, r, sha, "icon.jpg")
}

// handleUpdateWorkspace renames the workspace. Admin only.
func (s *Server) handleUpdateWorkspace(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Name *string `json:"name"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Name == nil {
		return httpx.BadRequest("Nothing to update.")
	}
	name := strings.TrimSpace(*in.Name)
	if name == "" || utf8.RuneCountInString(name) > maxWorkspaceNameLen {
		return httpx.BadRequest("Workspace name must be 1 to 40 characters.")
	}
	if err := s.putSetting(r.Context(), settingWorkspaceName, name); err != nil {
		return err
	}
	return s.respondWorkspace(w, r)
}

// handleUploadWorkspaceIcon replaces the mark beside the workspace name.
func (s *Server) handleUploadWorkspaceIcon(w http.ResponseWriter, r *http.Request) error {
	res, err := s.readImageUpload(w, r, maxWorkspaceIcon, "Workspace icons must be under 4 MB.")
	if err != nil {
		return err
	}
	if err := s.putSetting(r.Context(), settingWorkspaceIconSHA, res.SHA256); err != nil {
		return err
	}
	return s.respondWorkspace(w, r)
}

// handleDeleteWorkspaceIcon reverts to the built-in mark.
func (s *Server) handleDeleteWorkspaceIcon(w http.ResponseWriter, r *http.Request) error {
	if err := s.putSetting(r.Context(), settingWorkspaceIconSHA, ""); err != nil {
		return err
	}
	return s.respondWorkspace(w, r)
}

func (s *Server) respondWorkspace(w http.ResponseWriter, r *http.Request) error {
	ws, err := s.loadWorkspace(r.Context())
	if err != nil {
		return err
	}
	s.publishWorkspace(ws)
	httpx.JSON(w, http.StatusOK, map[string]any{"workspace": ws})
	return nil
}

// readImageUpload parses a single-file multipart form and stores it, enforcing
// that the result really is a displayable raster image. Shared by the avatar
// and workspace-icon endpoints.
func (s *Server) readImageUpload(w http.ResponseWriter, r *http.Request, maxBytes int64, tooBigMsg string) (*media.Result, error) {
	tooBig := httpx.Errorf(http.StatusRequestEntityTooLarge, "too_large", "%s", tooBigMsg)

	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+(1<<20))
	if err := r.ParseMultipartForm(4 << 20); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, tooBig
		}
		return nil, httpx.BadRequest("Expected a multipart upload.")
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, httpx.BadRequest("Missing file.")
	}
	defer file.Close()

	res, err := s.Media.Save(sanitizeFilename(header.Filename),
		header.Header.Get("Content-Type"), file, maxBytes)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.Is(err, media.ErrTooLarge) || errors.As(err, &maxErr) {
			return nil, tooBig
		}
		return nil, err
	}

	if !res.IsImage || !avatarImageTypes[strings.ToLower(res.Mime)] {
		return nil, httpx.BadRequest("That is not an image. Use a JPEG, PNG, GIF or WebP.")
	}
	if !res.HasThumb {
		return nil, httpx.BadRequest("That image could not be processed. Try a different file.")
	}
	return res, nil
}
