package api

import (
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"slock/internal/db"
	"slock/internal/httpx"
	"slock/internal/media"
)

const (
	// multipartMemory is how much of the form is buffered in RAM; the file part
	// streams through a temp file beyond that.
	multipartMemory  = 8 << 20
	maxFilenameBytes = 120
	defaultMaxUpload = 50 << 20
)

// inlineImageTypes are the types safe to render in the browser. Anything else
// (SVG in particular, which can carry script) is served as a download.
var inlineImageTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// sanitizeFilename keeps a display name only: no directories, no control
// characters, bounded length.
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' {
			return -1
		}
		return r
	}, name)
	name = strings.TrimLeft(name, ".")
	if name == "" {
		name = "file"
	}
	if len(name) > maxFilenameBytes {
		ext := filepath.Ext(name)
		if len(ext) > 16 {
			ext = ""
		}
		name = name[:maxFilenameBytes-len(ext)] + ext
	}
	return name
}

func (s *Server) maxUploadBytes() int64 {
	if s.Cfg.MaxUploadBytes > 0 {
		return s.Cfg.MaxUploadBytes
	}
	return defaultMaxUpload
}

var errUploadTooLarge = httpx.Errorf(http.StatusRequestEntityTooLarge, "too_large",
	"That file is too large.")

// handleListChannelAttachments pages a channel's attachments, newest first,
// joined with their message for the sender and timestamp the client shows.
// Access mirrors message history (requireMembership): public channels for
// anyone signed in, membership otherwise.
func (s *Server) handleListChannelAttachments(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireMembership(ctx, id, me.ID); err != nil {
		return err
	}

	limit := httpx.Clamp(httpx.QueryInt(r, "limit", 50), 1, 200)
	before := int64(httpx.QueryInt(r, "before", 0))

	// Fetch one extra row to know whether another page exists.
	sql := `SELECT a.id, a.message_id, a.uploader_id, a.filename, a.mime, a.size_bytes,
	               a.is_image, a.width, a.height, a.has_display, a.has_thumb,
	               m.user_id, m.created_at
	          FROM attachments a
	          JOIN messages m ON m.id = a.message_id
	         WHERE m.channel_id = $1 AND m.deleted_at IS NULL`
	args := []any{id, limit + 1}
	if before > 0 {
		sql += ` AND a.id < $3`
		args = append(args, before)
	}
	sql += ` ORDER BY a.id DESC LIMIT $2`

	type channelAttachment struct {
		db.Attachment
		UserID    int64     `json:"user_id"`
		CreatedAt time.Time `json:"created_at"`
	}
	rows, err := s.DB.Pool.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	atts := []channelAttachment{}
	for rows.Next() {
		var a channelAttachment
		if err := rows.Scan(&a.ID, &a.MessageID, &a.UploaderID, &a.Filename, &a.Mime, &a.SizeBytes,
			&a.IsImage, &a.Width, &a.Height, &a.HasDisplay, &a.HasThumb,
			&a.UserID, &a.CreatedAt); err != nil {
			return err
		}
		atts = append(atts, a)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	hasMore := len(atts) > limit
	if hasMore {
		atts = atts[:limit]
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"attachments": atts, "has_more": hasMore})
	return nil
}

// handleUpload accepts one multipart "file" field, stores it through
// s.Media.Save, records an attachments row with no message_id yet, and returns
// the attachment.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	maxBytes := s.maxUploadBytes()

	// Leave room for the multipart envelope on top of the file itself.
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+(1<<20))
	if err := r.ParseMultipartForm(multipartMemory); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return errUploadTooLarge
		}
		return httpx.BadRequest("Expected a multipart upload.")
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		return httpx.BadRequest("Missing file.")
	}
	defer file.Close()

	filename := sanitizeFilename(header.Filename)
	res, err := s.Media.Save(filename, header.Header.Get("Content-Type"), file, maxBytes)
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.Is(err, media.ErrTooLarge) || errors.As(err, &tooBig) {
			return errUploadTooLarge
		}
		return err
	}

	a := db.Attachment{
		UploaderID: me.ID,
		Filename:   filename,
		Mime:       res.Mime,
		SizeBytes:  res.SizeBytes,
		SHA256:     res.SHA256,
		IsImage:    res.IsImage,
		Width:      res.Width,
		Height:     res.Height,
		HasDisplay: res.HasDisplay,
		HasThumb:   res.HasThumb,
	}
	err = s.DB.Pool.QueryRow(r.Context(),
		`INSERT INTO attachments (uploader_id, filename, mime, size_bytes, sha256,
		                          is_image, width, height, has_display, has_thumb)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
		a.UploaderID, a.Filename, a.Mime, a.SizeBytes, a.SHA256,
		a.IsImage, a.Width, a.Height, a.HasDisplay, a.HasThumb).Scan(&a.ID)
	if err != nil {
		return err
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{"attachment": a})
	return nil
}

// handleDownload streams a stored variant after checking the caller may read
// the owning message's channel (or is the uploader, for unattached files).
func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) error {
	me := currentUser(r)
	id, err := httpx.PathInt(r, "id")
	if err != nil {
		return err
	}
	variant := r.PathValue("variant")
	switch variant {
	case media.VariantOriginal, media.VariantDisplay, media.VariantThumb:
	default:
		return httpx.ErrNotFound
	}

	// The id is the only trusted input; the {filename} segment is decoration.
	var (
		a         db.Attachment
		channelID *int64
		deletedAt *time.Time
	)
	err = s.DB.Pool.QueryRow(r.Context(),
		`SELECT a.id, a.message_id, a.uploader_id, a.filename, a.mime, a.size_bytes, a.sha256,
		        a.is_image, a.width, a.height, a.has_display, a.has_thumb, m.channel_id, m.deleted_at
		   FROM attachments a
		   LEFT JOIN messages m ON m.id = a.message_id
		  WHERE a.id = $1`, id).
		Scan(&a.ID, &a.MessageID, &a.UploaderID, &a.Filename, &a.Mime, &a.SizeBytes, &a.SHA256,
			&a.IsImage, &a.Width, &a.Height, &a.HasDisplay, &a.HasThumb, &channelID, &deletedAt)
	if err != nil {
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		return err
	}

	if channelID == nil {
		// Not attached to a message yet: only the uploader can see it.
		if a.UploaderID != me.ID {
			return httpx.ErrForbidden
		}
	} else {
		// A deleted message's body is scrubbed and its attachments must go with
		// it — otherwise the file survives the delete for anyone with the id.
		if deletedAt != nil {
			return httpx.ErrNotFound
		}
		if err := s.requireMembership(r.Context(), *channelID, me.ID); err != nil {
			return err
		}
	}

	f, ctype, err := s.Media.Open(a.SHA256, variant)
	if err != nil {
		return httpx.ErrNotFound
	}
	defer f.Close()

	if ctype == "" {
		ctype = a.Mime
	}
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	modTime := time.Time{}
	if st, err := f.Stat(); err == nil {
		modTime = st.ModTime()
	}

	inline := a.IsImage && inlineImageTypes[strings.ToLower(a.Mime)] && variant != media.VariantOriginal
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Cache-Control", "private, max-age=86400")
	if inline {
		h.Set("Content-Disposition", "inline")
	} else {
		h.Set("Content-Disposition", contentDisposition(a.Filename))
	}
	http.ServeContent(w, r, a.Filename, modTime, f)
	return nil
}

// contentDisposition builds an attachment header with an ASCII fallback and an
// RFC 5987 UTF-8 form for non-ASCII names.
func contentDisposition(filename string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, filename)
	if ascii == "" {
		ascii = "file"
	}
	d := `attachment; filename="` + ascii + `"`
	if ascii != filename {
		d += "; filename*=UTF-8''" + url.PathEscape(filename)
	}
	return d
}
