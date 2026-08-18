// Command genicons draws the slock PWA icons. Keeping them generated means the
// repository carries no binary blobs nobody can edit.
//
//	go run ./tools/genicons
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

const outDir = "web/assets/icons"

// Brand colours, matching the accent ramp in web/assets/style.css.
var (
	brandTop    = color.NRGBA{99, 102, 241, 255}  // indigo
	brandBottom = color.NRGBA{139, 92, 246, 255}  // violet
	glyphColor  = color.NRGBA{255, 255, 255, 255} // the bubble
)

func main() {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		log.Fatal(err)
	}
	jobs := []struct {
		name       string
		size       int
		maskable   bool
		monochrome bool
	}{
		{"icon-192.png", 192, false, false},
		{"icon-512.png", 512, false, false},
		{"icon-maskable-512.png", 512, true, false},
		{"badge-96.png", 96, false, true},
		{"favicon-64.png", 64, false, false},
		{"apple-touch-icon.png", 180, true, false},
	}
	for _, j := range jobs {
		img := draw(j.size, j.maskable, j.monochrome)
		path := filepath.Join(outDir, j.name)
		f, err := os.Create(path)
		if err != nil {
			log.Fatal(err)
		}
		if err := png.Encode(f, img); err != nil {
			log.Fatal(err)
		}
		if err := f.Close(); err != nil {
			log.Fatal(err)
		}
		log.Printf("wrote %s (%dx%d)", path, j.size, j.size)
	}
}

// draw renders one icon. Coverage is supersampled 4x4 per pixel for clean
// edges without pulling in a rasteriser.
func draw(size int, maskable, monochrome bool) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	const ss = 4
	fs := float64(size)

	// A maskable icon must survive a circular crop, so the glyph shrinks and
	// the background bleeds to the edges.
	glyphScale := 1.0
	corner := 0.22
	if maskable {
		glyphScale = 0.72
		corner = 0.5 // full bleed: the platform applies its own mask
	}

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var bgCov, glyphCov float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					px := (float64(x) + (float64(sx)+0.5)/ss) / fs
					py := (float64(y) + (float64(sy)+0.5)/ss) / fs
					if insideRoundedRect(px, py, 0, 0, 1, 1, corner) {
						bgCov++
					}
					gx := (px - 0.5) / glyphScale
					gy := (py - 0.5) / glyphScale
					if insideBubble(gx+0.5, gy+0.5) {
						glyphCov++
					}
				}
			}
			total := float64(ss * ss)
			bgA := bgCov / total
			glA := glyphCov / total

			if monochrome {
				// A notification badge is a silhouette: white glyph, no plate.
				a := uint8(math.Round(glA * 255))
				img.SetNRGBA(x, y, color.NRGBA{255, 255, 255, a})
				continue
			}

			bg := lerp(brandTop, brandBottom, float64(y)/fs)
			out := color.NRGBA{bg.R, bg.G, bg.B, uint8(math.Round(bgA * 255))}
			if glA > 0 {
				// Composite the glyph over the plate, keeping the plate's alpha.
				out.R = mix(out.R, glyphColor.R, glA)
				out.G = mix(out.G, glyphColor.G, glA)
				out.B = mix(out.B, glyphColor.B, glA)
			}
			img.SetNRGBA(x, y, out)
		}
	}
	return img
}

// insideBubble is the slock mark: a speech bubble with a tail at lower left.
func insideBubble(x, y float64) bool {
	if insideRoundedRect(x, y, 0.17, 0.21, 0.66, 0.46, 0.15) {
		return true
	}
	// Tail, as a triangle hanging off the bubble's bottom edge.
	return insideTriangle(x, y,
		0.30, 0.60,
		0.30, 0.84,
		0.52, 0.65)
}

// insideRoundedRect reports whether (px,py) falls inside a rectangle at (x,y)
// of size w*h whose corners are rounded by r (all in unit coordinates).
func insideRoundedRect(px, py, x, y, w, h, r float64) bool {
	r = math.Min(r, math.Min(w, h)/2)
	dx := math.Max(math.Max(x+r-px, px-(x+w-r)), 0)
	dy := math.Max(math.Max(y+r-py, py-(y+h-r)), 0)
	if px < x || px > x+w || py < y || py > y+h {
		return false
	}
	return dx*dx+dy*dy <= r*r
}

func insideTriangle(px, py, ax, ay, bx, by, cx, cy float64) bool {
	d1 := sign(px, py, ax, ay, bx, by)
	d2 := sign(px, py, bx, by, cx, cy)
	d3 := sign(px, py, cx, cy, ax, ay)
	hasNeg := d1 < 0 || d2 < 0 || d3 < 0
	hasPos := d1 > 0 || d2 > 0 || d3 > 0
	return !(hasNeg && hasPos)
}

func sign(px, py, ax, ay, bx, by float64) float64 {
	return (px-bx)*(ay-by) - (ax-bx)*(py-by)
}

func lerp(a, b color.NRGBA, t float64) color.NRGBA {
	return color.NRGBA{
		R: mix(a.R, b.R, t),
		G: mix(a.G, b.G, t),
		B: mix(a.B, b.B, t),
		A: 255,
	}
}

func mix(a, b uint8, t float64) uint8 {
	t = math.Max(0, math.Min(1, t))
	return uint8(math.Round(float64(a)*(1-t) + float64(b)*t))
}
