package media

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.NRGBA{uint8(x % 256), uint8(y % 256), 0x40, 0xff})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestSaveNonImage(t *testing.T) {
	s := newStore(t)
	data := []byte("just some notes\n")
	res, err := s.Save("notes.txt", "text/plain", bytes.NewReader(data), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if res.SHA256 != hex.EncodeToString(sum[:]) {
		t.Errorf("sha = %s", res.SHA256)
	}
	if res.SizeBytes != int64(len(data)) {
		t.Errorf("size = %d", res.SizeBytes)
	}
	if res.Mime != "text/plain" || res.IsImage {
		t.Errorf("mime = %q isImage = %v", res.Mime, res.IsImage)
	}
	if res.HasDisplay || res.HasThumb {
		t.Error("non-image must have no variants")
	}
	f, ct, err := s.Open(res.SHA256, VariantOriginal)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	got, _ := io.ReadAll(f)
	if !bytes.Equal(got, data) || ct != "text/plain" {
		t.Errorf("read back %q %q", got, ct)
	}
}

func TestSaveTooLarge(t *testing.T) {
	s := newStore(t)
	_, err := s.Save("big.bin", "", bytes.NewReader(bytes.Repeat([]byte{'x'}, 5000)), 4096)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	entries, _ := os.ReadDir(filepath.Join(s.Dir, "tmp"))
	if len(entries) != 0 {
		t.Errorf("temp files left behind: %v", entries)
	}
}

// An upload of exactly maxBytes is allowed.
func TestSaveExactLimit(t *testing.T) {
	s := newStore(t)
	if _, err := s.Save("x.bin", "", bytes.NewReader(bytes.Repeat([]byte{'x'}, 4096)), 4096); err != nil {
		t.Fatal(err)
	}
}

func TestSaveDeduplicates(t *testing.T) {
	s := newStore(t)
	data := pngBytes(t, 2000, 1000)
	first, err := s.Save("a.png", "image/png", bytes.NewReader(data), 1<<24)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Save("b.png", "image/png", bytes.NewReader(data), 1<<24)
	if err != nil {
		t.Fatal(err)
	}
	if *first != *second {
		t.Errorf("dedup mismatch:\n%+v\n%+v", first, second)
	}
	entries, _ := os.ReadDir(filepath.Join(s.Dir, "tmp"))
	if len(entries) != 0 {
		t.Errorf("temp files left behind: %v", entries)
	}
}

func TestSaveImageVariants(t *testing.T) {
	s := newStore(t)
	res, err := s.Save("wide.png", "image/png", bytes.NewReader(pngBytes(t, 2400, 1200)), 1<<24)
	if err != nil {
		t.Fatal(err)
	}
	if res.Mime != "image/png" || !res.IsImage {
		t.Fatalf("mime = %q", res.Mime)
	}
	if res.Width != 2400 || res.Height != 1200 {
		t.Fatalf("dims = %dx%d", res.Width, res.Height)
	}
	if !res.HasDisplay || !res.HasThumb {
		t.Fatalf("want both variants, got %+v", res)
	}
	for _, tc := range []struct {
		variant string
		maxEdge int
	}{{VariantDisplay, DisplayMaxEdge}, {VariantThumb, ThumbMaxEdge}} {
		f, ct, err := s.Open(res.SHA256, tc.variant)
		if err != nil {
			t.Fatal(err)
		}
		cfg, err := jpeg.DecodeConfig(f)
		f.Close()
		if err != nil {
			t.Fatalf("%s: %v", tc.variant, err)
		}
		if ct != "image/jpeg" {
			t.Errorf("%s: ct = %q", tc.variant, ct)
		}
		if cfg.Width != tc.maxEdge || cfg.Height != tc.maxEdge/2 {
			t.Errorf("%s: %dx%d, want %d wide at 2:1", tc.variant, cfg.Width, cfg.Height, tc.maxEdge)
		}
	}
}

// A small image gets a thumb but no display variant; the client falls back to
// the original.
func TestSaveSmallImage(t *testing.T) {
	s := newStore(t)
	res, err := s.Save("small.png", "image/png", bytes.NewReader(pngBytes(t, 300, 200)), 1<<24)
	if err != nil {
		t.Fatal(err)
	}
	if res.HasDisplay {
		t.Error("HasDisplay set without a display file")
	}
	if !res.HasThumb {
		t.Error("want a thumb")
	}
	if _, err := os.Stat(filepath.Join(s.Dir, res.SHA256[:2], res.SHA256, "display.jpg")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("display.jpg exists: %v", err)
	}
	f, ct, err := s.Open(res.SHA256, VariantDisplay)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if ct != "image/png" {
		t.Errorf("missing variant should fall back to the original, got %q", ct)
	}
}

func TestSaveGIF(t *testing.T) {
	s := newStore(t)
	img := image.NewPaletted(image.Rect(0, 0, 800, 400), color.Palette{color.Black, color.White})
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	res, err := s.Save("a.gif", "image/gif", bytes.NewReader(buf.Bytes()), 1<<24)
	if err != nil {
		t.Fatal(err)
	}
	if res.Mime != "image/gif" || !res.IsImage || res.Width != 800 || !res.HasThumb {
		t.Fatalf("%+v", res)
	}
}

// WebP is served as an image but the standard library cannot decode it, so it
// carries no dimensions and no variants.
func TestSaveWebP(t *testing.T) {
	s := newStore(t)
	body := []byte("RIFF\x24\x00\x00\x00WEBPVP8 " + strings.Repeat("\x00", 24))
	res, err := s.Save("a.webp", "image/webp", bytes.NewReader(body), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if res.Mime != "image/webp" || !res.IsImage {
		t.Fatalf("mime = %q isImage = %v", res.Mime, res.IsImage)
	}
	if res.Width != 0 || res.Height != 0 || res.HasDisplay || res.HasThumb {
		t.Fatalf("%+v", res)
	}
}

// A file that fails to decode is stored as-is instead of failing the upload.
func TestSaveBrokenImage(t *testing.T) {
	s := newStore(t)
	broken := append(pngBytes(t, 40, 40)[:80], bytes.Repeat([]byte{0}, 200)...)
	res, err := s.Save("broken.png", "image/png", bytes.NewReader(broken), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsImage || res.HasThumb || res.Width != 0 {
		t.Fatalf("%+v", res)
	}
	if _, _, err := s.Open(res.SHA256, VariantOriginal); err != nil {
		t.Fatal(err)
	}
}

func TestMimeNeverActive(t *testing.T) {
	cases := []struct {
		name, detected, declared, filename, want string
	}{
		{"html sniffed", "text/html; charset=utf-8", "text/plain", "x.txt", "application/octet-stream"},
		{"html declared", "application/octet-stream", "text/html", "x.bin", "application/octet-stream"},
		{"svg declared", "application/octet-stream", "image/svg+xml", "x.svg", "application/octet-stream"},
		{"js by extension", "application/octet-stream", "", "x.js", "application/octet-stream"},
		{"declared fallback", "application/octet-stream", "application/zip", "x.zip", "application/zip"},
		{"extension fallback", "application/octet-stream", "", "x.zip", "application/zip"},
		{"sniff wins", "image/png", "image/jpeg", "x.jpg", "image/png"},
		{"unknown", "application/octet-stream", "", "x", "application/octet-stream"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveMime(tc.detected, tc.declared, tc.filename); got != tc.want {
				t.Errorf("resolveMime = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSaveHTMLIsNeutralised(t *testing.T) {
	s := newStore(t)
	res, err := s.Save("evil.html", "text/html", strings.NewReader("<html><body><script>alert(1)</script>"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if res.Mime != "application/octet-stream" {
		t.Fatalf("mime = %q", res.Mime)
	}
	_, ct, err := s.Open(res.SHA256, VariantOriginal)
	if err != nil {
		t.Fatal(err)
	}
	if ct != "application/octet-stream" {
		t.Fatalf("served as %q", ct)
	}
}

func TestOpenRejectsBadSHA(t *testing.T) {
	s := newStore(t)
	bad := []string{
		"", "..", "../../etc/passwd",
		strings.Repeat("a", 63),
		strings.Repeat("A", 64),
		strings.Repeat("g", 64),
		strings.Repeat("a", 32) + "/" + strings.Repeat("a", 31),
	}
	for _, sha := range bad {
		if _, _, err := s.Open(sha, VariantOriginal); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("Open(%q) err = %v", sha, err)
		}
		if err := s.Delete(sha); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("Delete(%q) err = %v", sha, err)
		}
	}
}

func TestDelete(t *testing.T) {
	s := newStore(t)
	res, err := s.Save("a.png", "image/png", bytes.NewReader(pngBytes(t, 2000, 500)), 1<<24)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(res.SHA256); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Open(res.SHA256, VariantOriginal); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("err = %v", err)
	}
	if err := s.Delete(res.SHA256); err != nil {
		t.Errorf("second delete: %v", err)
	}
}

func TestResizeBoxAverage(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	for y := range 4 {
		for x := range 4 {
			v := uint8(0)
			if x >= 2 {
				v = 200
			}
			src.Set(x, y, color.NRGBA{v, v, v, 0xff})
		}
	}
	out := resize(src, 2)
	if out.Bounds().Dx() != 2 || out.Bounds().Dy() != 2 {
		t.Fatalf("bounds = %v", out.Bounds())
	}
	if got := out.NRGBAAt(0, 0).R; got != 0 {
		t.Errorf("left = %d, want 0", got)
	}
	if got := out.NRGBAAt(1, 0).R; got != 200 {
		t.Errorf("right = %d, want 200", got)
	}
	if got := out.NRGBAAt(1, 0).A; got != 0xff {
		t.Errorf("alpha = %d", got)
	}
}

func TestResizeAspectRatioAndNoUpscale(t *testing.T) {
	tall := image.NewNRGBA(image.Rect(0, 0, 500, 1000))
	out := resize(tall, 100)
	if out.Bounds().Dx() != 50 || out.Bounds().Dy() != 100 {
		t.Errorf("bounds = %v, want 50x100", out.Bounds())
	}
	small := image.NewNRGBA(image.Rect(0, 0, 30, 20))
	if got := resize(small, 100); got != small {
		t.Errorf("upscaled to %v", got.Bounds())
	}
	// Extreme ratios still produce at least one pixel.
	strip := image.NewNRGBA(image.Rect(0, 0, 4000, 3))
	if out := resize(strip, 100); out.Bounds().Dy() != 1 {
		t.Errorf("bounds = %v", out.Bounds())
	}
}

func TestFlattenCompositesOntoWhite(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	src.Set(0, 0, color.NRGBA{0, 0, 0, 0})
	got := flatten(src).NRGBAAt(0, 0)
	if got != (color.NRGBA{0xff, 0xff, 0xff, 0xff}) {
		t.Errorf("transparent black flattened to %v", got)
	}
}
