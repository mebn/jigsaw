// Piece sprites. Each piece has a cell in two atlases on the GPU, with halved copies of either in
// their mip levels for drawing zoomed out (see gpu.js):
// - color: the picture around the piece, not cut to its outline, which the GPU draws itself,
// - shape: in red, the distance to the outline (see SDF_R); in green, whether the nearest side is
//   cut (not inside a long piece). Worked out here, in sprites.worker.js or on the main thread.
// The GPU cuts the piece out of color with shape's distance, and draws the line along its cut sides
// from it, so both stay sharp however far the sprite is zoomed in.

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

// What piece p's shape is made from, in arrays of their own that can be sent to a worker: pts, the
// corners of its outline (pushed out over the inner sides of a long piece) as x, y pairs, and codes,
// each line's (from one corner to the next) side code.
export function shapeOutline(p, geo) {
  const long = longPaths(p, geo.S * GROW)
  return {
    pts: long ? Float64Array.from(long.pts) : Float64Array.from(p.outline),
    codes: Uint8Array.from(long ? long.code : sideCodes(p), (c) => c ?? 4),
  }
}

// A piece's shape as two bytes a pixel, red and green (see the top of this file), from its outline
// (see shapeOutline()). ctx: a sprite sized canvas with willReadFrequently; sc: sprite pixels per
// world unit.
export function spriteShape(ctx, sc, { pts, codes }) {
  const path = new Path2D()
  path.moveTo(pts[0], pts[1])
  for (let k = 2; k < pts.length; k += 2) path.lineTo(pts[k], pts[k + 1])
  path.closePath()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  return shapeData(ctx, sc, path, pts, codes)
}

// See spriteShape(): path is the outline as a Path2D, to fill to tell inside from out.
function shapeData(ctx, sc, path, pts, codes) {
  const c = ctx.canvas
  const W = c.width
  const H = c.height
  // Which pixels are inside.
  ctx.setTransform(sc, 0, 0, sc, W / 2, H / 2)
  ctx.fillStyle = '#000'
  ctx.fill(path)
  const px = ctx.getImageData(0, 0, W, H).data

  // The distance from each pixel's middle to the outline, only near it: each side's segment updates
  // the pixels within SDF_R of it. Kept squared until the end, which is much quicker.
  const R = SDF_R
  const dist = new Float32Array(W * H).fill(R * R)
  const side = new Uint8Array(W * H).fill(4)
  const n = pts.length / 2
  for (let k = 0; k < n; k++) {
    const code = k < codes.length ? codes[k] : 4
    const ax = pts[k * 2] * sc + W / 2
    const ay = pts[k * 2 + 1] * sc + H / 2
    const bx = pts[((k + 1) % n) * 2] * sc + W / 2
    const by = pts[((k + 1) % n) * 2 + 1] * sc + H / 2
    const dx = bx - ax
    const dy = by - ay
    const il = 1 / (dx * dx + dy * dy || 1)
    const sx0 = Math.min(ax, bx)
    const sx1 = Math.max(ax, bx)
    const sy0 = Math.min(ay, by)
    const sy1 = Math.max(ay, by)
    const gy0 = Math.max(0, Math.floor(sy0 - R))
    const gy1 = Math.min(H - 1, Math.ceil(sy1 + R))
    for (let y = gy0; y <= gy1; y++) {
      const cy = y + 0.5
      const qy = cy - ay
      // Only the part of the row within R of the segment's box can be within R of the segment.
      const oy = cy < sy0 ? sy0 - cy : cy > sy1 ? cy - sy1 : 0
      if (oy >= R) continue
      const reach = Math.sqrt(R * R - oy * oy)
      const gx0 = Math.max(0, Math.floor(sx0 - reach - 0.5))
      const gx1 = Math.min(W - 1, Math.ceil(sx1 + reach - 0.5))
      for (let x = gx0; x <= gx1; x++) {
        const qx = x + 0.5 - ax
        const t = Math.min(1, Math.max(0, (qx * dx + qy * dy) * il))
        const ex = qx - t * dx
        const ey = qy - t * dy
        const d = ex * ex + ey * ey
        const at = y * W + x
        if (d < dist[at]) {
          dist[at] = d
          side[at] = code
        }
      }
    }
  }
  const out = new Uint8Array(W * H * 2)
  for (let at = 0; at < W * H; at++) {
    const d = px[at * 4 + 3] >= 128 ? Math.sqrt(dist[at]) : -Math.sqrt(dist[at])
    out[at * 2] = Math.round((0.5 + d / (2 * R)) * 255)
    out[at * 2 + 1] = side[at] & 4 ? 255 : 0
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return out
}
