// Piece sprites. Each piece has a cell in two atlases on the GPU, with smaller copies of either in
// their mip levels for drawing zoomed out (see gpu.ts):
// - color: the picture around the piece, not cut to its outline, which the GPU draws itself, its
//   copies halved on the GPU,
// - shape: in red, the distance to the outline (see SDF_R); in green, whether the nearest side is
//   cut (not inside a long piece). Worked out here, in sprites.worker.ts or on the main thread, for
//   every mip level at that level's own size: a halved copy would only reach half as far from the
//   outline in its own pixels, so zoomed far out the edge would come out jagged.
// The GPU cuts the piece out of color with shape's distance, and draws the line along its cut sides
// from it, so both stay sharp however far the sprite is zoomed in or out.

// How many mip levels a sprite of size [w, h] gets: the sprite and its halved copies, at least
// [full, 1/2, 1/4, 1/8], and more for big sprites (jigsaws with few pieces), down to about 16 pixels.
export function mipLevels([w, h]: readonly number[]): number {
  return 1 + Math.max(3, Math.floor(Math.log2(Math.min(w, h) / 16)))
}

// How far the distance in shape reaches either side of the outline, in sprite pixels: 0 is this
// far outside, 255 this far inside, and the outline is half way.
export const SDF_R = 6

import { longPaths, sideCodes } from './geometry.ts'
import type { Piece, PuzzleGeometry } from './geometry.ts'

// What a piece's shape is made from (see shapeOutline()).
export interface ShapeOutline {
  pts: Float64Array
  codes: Uint8Array
}

// One mip level of a piece's shape as pixels, two bytes each (see spriteShape()), w by h.
export interface ShapeLevel {
  w: number
  h: number
  data: Uint8Array
}
// A piece's shape, every mip level from the full size down.
export type ShapePixels = ShapeLevel[]

// A 2D context to work out shapes on: a canvas's on the main thread, an offscreen one in a worker.
export type ShapeContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// What sprites.worker.ts is sent: a job's number, the sprite size [w, h] in pixels, sprite pixels
// per world unit, how many mip levels (see mipLevels()) and the pieces to work out.
export interface SpriteJob {
  job: number
  size: [number, number]
  sc: number
  levels: number
  items: (ShapeOutline & { i: number })[]
}

// What sprites.worker.ts posts back.
export type SpriteReply =
  | { job: number; kind: 'front'; items: { i: number; shape: ShapePixels }[] }
  | { job: number; kind: 'done' }
  | { job: number; kind: 'fail'; message: string }

// How far a cell of a long piece reaches over its inner sides, in units of the short side, so its
// cells overlap a little and no hairline shows between them.
const GROW = 0.02

// Pixel size of every piece's sprite (they are all the same).
export function spriteSize({ w, h }: Pick<PuzzleGeometry, 'w' | 'h'>, margin: number, sc: number): [number, number] {
  return [Math.ceil((w + 2 * margin) * sc), Math.ceil((h + 2 * margin) * sc)]
}

// What piece p's shape is made from, in arrays of their own that can be sent to a worker: pts, the
// corners of its outline (pushed out over the inner sides of a long piece) as x, y pairs, and codes,
// each line's (from one corner to the next) side code.
export function shapeOutline(p: Piece, geo: Pick<PuzzleGeometry, 'S'>): ShapeOutline {
  const long = longPaths(p, geo.S * GROW)
  return {
    pts: long ? Float64Array.from(long.pts) : Float64Array.from(p.outline),
    codes: Uint8Array.from(long ? long.code : sideCodes(p), (c) => c ?? 4),
  }
}

// A piece's shape, two bytes a pixel, red and green (see the top of this file), from its outline
// (see shapeOutline()), for each of levels mip levels. ctx: a sprite sized canvas with
// willReadFrequently; sc: sprite pixels per world unit at full size.
export function spriteShape(ctx: ShapeContext, sc: number, { pts, codes }: ShapeOutline, levels: number): ShapePixels {
  const path = new Path2D()
  path.moveTo(pts[0], pts[1])
  for (let k = 2; k < pts.length; k += 2) path.lineTo(pts[k], pts[k + 1])
  path.closePath()
  const { width, height } = ctx.canvas
  const out: ShapePixels = []
  // Level l lines up with the GPU's halved copies of the picture: its pixel x covers the full size
  // pixels x * 2^l to (x + 1) * 2^l.
  for (let l = 0; l < levels; l++) {
    const f = 1 / (1 << l)
    const w = Math.ceil(width * f)
    const h = Math.ceil(height * f)
    out.push({ w, h, data: shapeData(ctx, sc * f, path, pts, codes, w, h, (width / 2) * f, (height / 2) * f) })
  }
  return out
}

// See spriteShape(): one level, w by h pixels in the canvas's top left corner, the piece's middle at
// (ox, oy) and sc pixels per world unit. path is the outline as a Path2D, to fill to tell inside
// from out.
function shapeData(ctx: ShapeContext, sc: number, path: Path2D, pts: Float64Array, codes: Uint8Array, W: number, H: number, ox: number, oy: number) {
  // Which pixels are inside.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, W, H)
  ctx.setTransform(sc, 0, 0, sc, ox, oy)
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
    const ax = pts[k * 2] * sc + ox
    const ay = pts[k * 2 + 1] * sc + oy
    const bx = pts[((k + 1) % n) * 2] * sc + ox
    const by = pts[((k + 1) % n) * 2 + 1] * sc + oy
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
