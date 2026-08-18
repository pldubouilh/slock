// Package media stores uploaded files on disk and derives display/thumbnail
// variants for images. Content-addressed by sha256 so duplicate uploads are free.
package media

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"io"
	"io/fs"
	"log"
	"math"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
)

// Variants of a stored file.
const (
	VariantOriginal = "original"
	VariantDisplay  = "display" // recompressed, long edge <= DisplayMaxEdge
	VariantThumb    = "thumb"   // long edge <= ThumbMaxEdge
)

const (
	DisplayMaxEdge = 1600
	ThumbMaxEdge   = 480
	// Derived variants only — the original is always stored untouched, and the
	// lightbox swaps to it on zoom. 90 keeps the fit-view crisp without the
	// derived files ballooning.
	JPEGQuality = 90
)

// maxPixels caps the decoded size of an image, so a small file that expands
// into gigabytes of pixels cannot take the process down.
const maxPixels = 50 << 20

// ErrTooLarge is returned when the upload exceeds the configured limit.
var ErrTooLarge = errors.New("media: file too large")

// errBadSHA is reported for ids that are not 64 lowercase hex characters. It
// wraps fs.ErrNotExist so handlers can treat it as a plain 404.
var errBadSHA = fmt.Errorf("media: invalid id: %w", fs.ErrNotExist)

// Result describes a stored file.
type Result struct {
	SHA256     string
	SizeBytes  int64
	Mime       string
	IsImage    bool
	Width      int
	Height     int
	HasDisplay bool
	HasThumb   bool
}

// Store is a content-addressed directory of uploads.
type Store struct {
	Dir string
}

// New prepares the storage directory.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{Dir: dir}, nil
}

// Save streams r to disk (at most maxBytes), hashes it, sniffs the real content
// type, and for JPEG/PNG/GIF/WebP inputs derives display and thumb variants.
// declaredMime is the browser-supplied type and is only a hint.
func (s *Store) Save(filename, declaredMime string, r io.Reader, maxBytes int64) (*Result, error) {
	if maxBytes <= 0 {
		maxBytes = math.MaxInt64
	}
	tmpDir := filepath.Join(s.Dir, "tmp")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(tmpDir, "upload-*")
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		tmp.Close()
		if !committed {
			os.Remove(tmp.Name())
		}
	}()

	head, size, sum, err := drain(r, tmp, maxBytes)
	if err != nil {
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}

	ct := resolveMime(http.DetectContentType(head), declaredMime, filename)
	res := &Result{SHA256: sum, SizeBytes: size, Mime: ct, IsImage: isImageMime(ct)}

	dir := filepath.Join(s.Dir, sum[:2], sum)
	original := filepath.Join(dir, "original")
	if _, err := os.Stat(original); err == nil {
		s.describeExisting(dir, res)
		return res, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp.Name(), original); err != nil {
		return nil, err
	}
	committed = true

	if res.IsImage && decodable(ct) {
		if err := derive(dir, original, res); err != nil {
			// A file we cannot resize is still a perfectly good upload.
			log.Printf("media: derive variants for %s (%s): %v", sum[:12], ct, err)
		}
	}
	return res, nil
}

// Open returns a reader for one variant of a stored file plus its content type.
// It falls back to the original when the requested variant does not exist.
func (s *Store) Open(sha, variant string) (*os.File, string, error) {
	if !validSHA(sha) {
		return nil, "", errBadSHA
	}
	dir := filepath.Join(s.Dir, sha[:2], sha)
	if name, ok := variantFile(variant); ok {
		if f, err := os.Open(filepath.Join(dir, name)); err == nil {
			return f, "image/jpeg", nil
		}
	}
	f, err := os.Open(filepath.Join(dir, "original"))
	if err != nil {
		return nil, "", err
	}
	head := make([]byte, 512)
	n, err := f.Read(head)
	if err != nil && err != io.EOF {
		f.Close()
		return nil, "", err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		return nil, "", err
	}
	return f, resolveMime(http.DetectContentType(head[:n]), "", ""), nil
}

// Delete removes every variant of a stored file.
func (s *Store) Delete(sha string) error {
	if !validSHA(sha) {
		return errBadSHA
	}
	return os.RemoveAll(filepath.Join(s.Dir, sha[:2], sha))
}

// drain copies r into w, capping it at maxBytes, and returns the first 512
// bytes for sniffing, the total size and the hex sha256.
func drain(r io.Reader, w io.Writer, maxBytes int64) (head []byte, size int64, sum string, err error) {
	h := sha256.New()
	dst := io.MultiWriter(w, h)
	head = make([]byte, 0, 512)
	buf := make([]byte, 64<<10)
	for {
		n, rerr := r.Read(buf)
		if n > 0 {
			size += int64(n)
			if size > maxBytes {
				return nil, 0, "", ErrTooLarge
			}
			if len(head) < 512 {
				head = append(head, buf[:min(n, 512-len(head))]...)
			}
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return nil, 0, "", werr
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return nil, 0, "", rerr
		}
	}
	return head, size, hex.EncodeToString(h.Sum(nil)), nil
}

// describeExisting fills in the variant metadata of an object that was already
// on disk, so a duplicate upload costs nothing but a stat and a header decode.
func (s *Store) describeExisting(dir string, res *Result) {
	if !res.IsImage {
		return
	}
	if _, err := os.Stat(filepath.Join(dir, "display.jpg")); err == nil {
		res.HasDisplay = true
	}
	if _, err := os.Stat(filepath.Join(dir, "thumb.jpg")); err == nil {
		res.HasThumb = true
	}
	f, err := os.Open(filepath.Join(dir, "original"))
	if err != nil {
		return
	}
	defer f.Close()
	if cfg, _, err := image.DecodeConfig(f); err == nil {
		res.Width, res.Height = cfg.Width, cfg.Height
	}
}

// derive decodes the original and writes the display and thumb variants.
func derive(dir, original string, res *Result) error {
	f, err := os.Open(original)
	if err != nil {
		return err
	}
	defer f.Close()

	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return errors.New("empty image")
	}
	if int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return fmt.Errorf("image too large to decode: %dx%d", cfg.Width, cfg.Height)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return err
	}
	b := img.Bounds()
	res.Width, res.Height = b.Dx(), b.Dy()

	src := flatten(img)
	if max(b.Dx(), b.Dy()) > DisplayMaxEdge {
		if err := writeJPEG(filepath.Join(dir, "display.jpg"), resize(src, DisplayMaxEdge)); err != nil {
			return err
		}
		res.HasDisplay = true
	}
	if err := writeJPEG(filepath.Join(dir, "thumb.jpg"), resize(src, ThumbMaxEdge)); err != nil {
		return err
	}
	res.HasThumb = true
	return nil
}

func variantFile(variant string) (string, bool) {
	switch variant {
	case VariantDisplay:
		return "display.jpg", true
	case VariantThumb:
		return "thumb.jpg", true
	}
	return "", false
}

func validSHA(sha string) bool {
	if len(sha) != 64 {
		return false
	}
	for i := 0; i < len(sha); i++ {
		c := sha[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

var imageMimes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

func isImageMime(ct string) bool { return imageMimes[ct] }

// decodable reports whether the standard library can decode ct. WebP is an
// image we serve but cannot resize.
func decodable(ct string) bool {
	return ct == "image/jpeg" || ct == "image/png" || ct == "image/gif"
}

// activeMimes are types a browser may execute in the origin's context. A stored
// upload must never be served as one of them.
var activeMimes = map[string]bool{
	"text/html":                true,
	"application/xhtml+xml":    true,
	"image/svg+xml":            true,
	"text/xml":                 true,
	"application/xml":          true,
	"text/javascript":          true,
	"application/javascript":   true,
	"application/x-javascript": true,
	"text/ecmascript":          true,
	"application/ecmascript":   true,
}

// resolveMime picks the content type to store. The sniffed type wins; the
// browser-declared type and the filename extension are consulted only when
// sniffing gives up. Active content types are always neutralised.
func resolveMime(detected, declared, filename string) string {
	ct := baseType(detected)
	if ct == "" || ct == "application/octet-stream" {
		if d := baseType(declared); d != "" {
			ct = d
		}
	}
	if ct == "" || ct == "application/octet-stream" {
		if ext := filepath.Ext(filename); ext != "" {
			if d := baseType(mime.TypeByExtension(ext)); d != "" {
				ct = d
			}
		}
	}
	if ct == "" || activeMimes[ct] {
		return "application/octet-stream"
	}
	return ct
}

func baseType(ct string) string {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return strings.ToLower(strings.TrimSpace(ct))
}
