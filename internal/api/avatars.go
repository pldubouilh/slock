package api

import (
	"net/http"
	"time"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/media"
	"slock/internal/realtime"
)

// maxAvatarBytes is deliberately far below the attachment limit: a profile
// picture is displayed at 38px and is recompressed on the way in anyway.
const maxAvatarBytes = 8 << 20

// avatarImageTypes are the types we accept and can actually downscale.
var avatarImageTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// handleUploadAvatar stores a new profile picture for the caller. The image is
// content-addressed and recompressed by the media store, and the resulting sha
// is written to users.avatar_sha.
func (s *Server) handleUploadAvatar(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	res, err := s.readImageUpload(w, r, maxAvatarBytes, "Profile pictures must be under 8 MB.")
	if err != nil {
		return err
	}
	return s.setAvatar(w, r, me.ID, res.SHA256)
}

// handleDeleteAvatar drops the caller's picture, falling back to initials.
func (s *Server) handleDeleteAvatar(w http.ResponseWriter, r *http.Request) error {
	return s.setAvatar(w, r, currentUser(r).ID, "")
}

// setAvatar writes the sha, broadcasts the change, and returns the fresh user.
// The old object is left in the media store: it is content-addressed and may be
// shared with a message attachment, so deleting it here could break a message.
func (s *Server) setAvatar(w http.ResponseWriter, r *http.Request, userID int64, sha string) error {
	var u db.User
	row := s.DB.Pool.QueryRow(r.Context(),
		`UPDATE users SET avatar_sha = $2 WHERE id = $1 RETURNING `+userColumnsBare, userID, sha)
	if err := scanUserRow(row, &u); err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}

	public := u
	public.Email = ""
	public.MustChangePW = false
	s.Hub.PublishAll(realtime.Event{Type: "user.update", Data: map[string]any{"user": public}})

	httpx.JSON(w, http.StatusOK, map[string]any{"user": u})
	return nil
}

// handleGetAvatar serves a user's picture. Any signed-in user may fetch any
// other's: an avatar is public within the workspace by definition.
func (s *Server) handleGetAvatar(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}

	var sha string
	err = s.DB.Pool.QueryRow(r.Context(), `SELECT avatar_sha FROM users WHERE id = $1`, id).Scan(&sha)
	if err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}
	if sha == "" {
		return httpx.ErrNotFound
	}
	return s.serveStoredImage(w, r, sha, "avatar.jpg")
}

// serveStoredImage streams the thumbnail variant of a stored object. Callers
// have already decided who may see it.
func (s *Server) serveStoredImage(w http.ResponseWriter, r *http.Request, sha, name string) error {
	f, ctype, err := s.Media.Open(sha, media.VariantThumb)
	if err != nil {
		return httpx.ErrNotFound
	}
	defer f.Close()

	modTime := time.Time{}
	if st, err := f.Stat(); err == nil {
		modTime = st.ModTime()
	}
	if ctype == "" {
		ctype = "image/jpeg"
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Disposition", "inline")
	// The URL carries the content hash, so a given URL never changes meaning.
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	if len(sha) >= 16 {
		h.Set("ETag", `"`+sha[:16]+`"`)
	}
	http.ServeContent(w, r, name, modTime, f)
	return nil
}
