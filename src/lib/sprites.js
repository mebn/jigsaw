// Piece sprites, drawn the same way on the main thread and in sprites.worker.js, each in two
// images with halved copies of either for drawing zoomed out:
// - color: the picture around the piece, not cut to its outline,
// - shape: in red, the distance to the outline (see SDF_R); in green, whether the nearest side is
//   cut (not inside a long piece).
// The GPU cuts the piece out of color with shape's distance, and draws the line along its cut sides
// from it, so both stay sharp however far the sprite is zoomed in (see gpu.js).

// How many halved copies each sprite gets, so a sprite list is [full, 1/2, 1/4, 1/8].
export const MIPS = 3

// How far the distance in shape reaches either side of the outline, in sprite pixels: 0 is this
// far outside, 255 this far inside, and the outline is half way.
export const SDF_R = 6

import { longPaths, sideCodes } from './geometry.js'

// How far a cell of a long piece reaches over its inner sides, in units of the short side, so its
// cells overlap a little and no hairline shows between them.
const GROW = 0.02

// Pixel size of every piece's sprite (they are all the same).
export function spriteSize({ w, h }, margin, sc) {
  return [Math.ceil((w + 2 * margin) * sc), Math.ceil((h + 2 * margin) * sc)]
}

// Draws piece p's color image into a sprite sized canvas. opts.image is an image or ImageBitmap of
// the whole picture.
function drawColor(ctx, { geo, room, image, margin: m, sc }, p) {
  const { w, h } = geo
  const c = ctx.canvas
  ctx.setTransform(sc, 0, 0, sc, c.width / 2, c.height / 2)
  const k = (image.naturalWidth || image.width) / room.width
  const W = room.width
  const H = room.height
  const x0 = Math.max(0, p.cx - w / 2 - m)
  const y0 = Math.max(0, p.cy - h / 2 - m)
  const x1 = Math.min(W, p.cx + w / 2 + m)
  const y1 = Math.min(H, p.cy + h / 2 + m)
  ctx.drawImage(image, x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k, x0 - p.cx, y0 - p.cy, x1 - x0, y1 - y0)
}

// Draws piece p's shape image into a sprite sized canvas (see the top of this file). pts are the
// outline's corners as x, y pairs, codes each line's (from one corner to the next) side code.
function drawShape(ctx, { sc }, path, long, pts, codes) {
  const c = ctx.canvas
  const W = c.width
  const H = c.height
  // Which pixels are inside.
  ctx.setTransform(sc, 0, 0, sc, W / 2, H / 2)
  ctx.fillStyle = '#000'
  ctx.fill(long ? long.fill : path)
  const img = ctx.getImageData(0, 0, W, H)
  const px = img.data

  // The distance from each pixel's middle to the outline, only near it: each side's segment updates
  // the pixels within SDF_R of it.
  const R = SDF_R
  const dist = new Float32Array(W * H).fill(R)
  const side = new Uint8Array(W * H).fill(4)
  const n = pts.length / 2
  for (let k = 0; k < n; k++) {
    const code = codes[k] ?? 4
    const ax = pts[k * 2] * sc + W / 2
    const ay = pts[k * 2 + 1] * sc + H / 2
    const bx = pts[((k + 1) % n) * 2] * sc + W / 2
    const by = pts[((k + 1) % n) * 2 + 1] * sc + H / 2
    const dx = bx - ax
    const dy = by - ay
    const ll = dx * dx + dy * dy || 1
    const gx0 = Math.max(0, Math.floor(Math.min(ax, bx) - R))
    const gx1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + R))
    const gy0 = Math.max(0, Math.floor(Math.min(ay, by) - R))
    const gy1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + R))
    for (let y = gy0; y <= gy1; y++) {
      const qy = y + 0.5 - ay
      for (let x = gx0; x <= gx1; x++) {
        const qx = x + 0.5 - ax
        const t = Math.min(1, Math.max(0, (qx * dx + qy * dy) / ll))
        const d = Math.hypot(qx - t * dx, qy - t * dy)
        const at = y * W + x
        if (d < dist[at]) {
          dist[at] = d
          side[at] = code
        }
      }
    }
  }
  for (let at = 0, q = 0; at < W * H; at++, q += 4) {
    const d = px[q + 3] >= 128 ? dist[at] : -dist[at]
    px[q] = Math.round((0.5 + d / (2 * R)) * 255)
    px[q + 1] = side[at] & 4 ? 255 : 0
    px[q + 2] = 0
    px[q + 3] = 255
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(img, 0, 0)
}

// Piece p's sprite: { color, shape }, each the image and its halved copies (see levels()).
// make(w, h) returns a blank canvas of that size; path is the piece's outline as a Path2D.
export function buildSprite(opts, p, path, make) {
  const [W, H] = spriteSize(opts.geo, opts.margin, opts.sc)
  const long = longPaths(p, opts.geo.S * GROW)
  const color = make(W, H)
  drawColor(color.getContext('2d'), opts, p)
  const shape = make(W, H)
  drawShape(shape.getContext('2d', { willReadFrequently: true }), opts, path, long, long ? long.pts : p.outline, long ? long.code : sideCodes(p))
  return { color: levels(color, make), shape: levels(shape, make) }
}

// The sprite followed by its halved copies. make(w, h) returns a blank canvas of that size. Each
// copy covers the same area as the sprite, so all of them are drawn at the sprite's world size.
export function levels(src, make) {
  const out = [src]
  let prev = src
  for (let k = 0; k < MIPS; k++) {
    const c = make(Math.max(1, Math.ceil(prev.width / 2)), Math.max(1, Math.ceil(prev.height / 2)))
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(prev, 0, 0, c.width, c.height)
    out.push(c)
    prev = c
  }
  return out
}
