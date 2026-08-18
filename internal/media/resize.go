package media

import (
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"math"
	"os"
	"path/filepath"
)

// flatten converts img to NRGBA and composites it onto white, so transparent
// pixels do not turn black once the variant is encoded as JPEG.
func flatten(img image.Image) *image.NRGBA {
	b := img.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Over)
	return dst
}

// resize scales src down so its long edge is at most maxEdge, preserving the
// aspect ratio. It is a box filter: every destination pixel is the average of
// the source pixels it covers, which is what a downscale should be. Images that
// already fit are returned unchanged; nothing is ever upscaled.
func resize(src *image.NRGBA, maxEdge int) *image.NRGBA {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	if sw <= maxEdge && sh <= maxEdge {
		return src
	}
	dw, dh := sw, sh
	if sw >= sh {
		dw = maxEdge
		dh = scaled(sh, maxEdge, sw)
	} else {
		dh = maxEdge
		dw = scaled(sw, maxEdge, sh)
	}

	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	xr := float64(sw) / float64(dw)
	yr := float64(sh) / float64(dh)
	for y := range dh {
		y0, y1 := span(y, yr, sh)
		for x := range dw {
			x0, x1 := span(x, xr, sw)
			var r, g, b, a uint32
			for sy := y0; sy < y1; sy++ {
				row := src.Pix[src.PixOffset(x0, sy) : src.PixOffset(x1-1, sy)+4]
				for i := 0; i < len(row); i += 4 {
					r += uint32(row[i])
					g += uint32(row[i+1])
					b += uint32(row[i+2])
					a += uint32(row[i+3])
				}
			}
			n := uint32((x1 - x0) * (y1 - y0))
			o := dst.PixOffset(x, y)
			dst.Pix[o] = uint8((r + n/2) / n)
			dst.Pix[o+1] = uint8((g + n/2) / n)
			dst.Pix[o+2] = uint8((b + n/2) / n)
			dst.Pix[o+3] = uint8((a + n/2) / n)
		}
	}
	return dst
}

// span returns the half-open source range covered by destination index i.
func span(i int, ratio float64, limit int) (lo, hi int) {
	lo = int(float64(i) * ratio)
	hi = int(math.Ceil(float64(i+1) * ratio))
	if hi > limit {
		hi = limit
	}
	if hi <= lo {
		hi = lo + 1
	}
	return lo, hi
}

func scaled(edge, maxEdge, longEdge int) int {
	n := int(math.Round(float64(edge) * float64(maxEdge) / float64(longEdge)))
	if n < 1 {
		return 1
	}
	return n
}

// writeJPEG encodes img to a temp file next to path and renames it into place,
// so a reader never sees a half-written variant.
func writeJPEG(path string, img image.Image) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".variant-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := jpeg.Encode(tmp, img, &jpeg.Options{Quality: JPEGQuality}); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
