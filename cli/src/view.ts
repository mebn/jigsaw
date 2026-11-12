// Draws the table in the terminal: each character cell is two pixels, one above the other, drawn as
// "▀" with the top pixel as its colour and the bottom one as its background.
import { trayColor } from '../../src/lib/colors.ts'
import { hex, mix } from './screen.ts'
import type { Cells, Rgb } from './screen.ts'
import type { Table } from './table.ts'

// What the picture looks like, decoded: RGBA, width by height.
export interface Picture {
  width: number
  height: number
  data: Uint8Array
}

// A piece's shape as a grid of samples in its own (unturned) frame, centred on its grid cell.
interface Mask {
  x0: number
  y0: number
  step: number
  cols: number
  rows: number
  bits: Uint8Array
}

// One level of the picture, shrunk by a power of two, as RGB.
interface Level {
  width: number
  height: number
  rgb: Uint8Array
}

// Mask samples across a piece's short side.
const MASK_RES = 40
const COS = [1, 0, -1, 0]
const SIN = [0, 1, 0, -1]
// How many pixels a piece's short side is at each zoom level.
export const ZOOMS = [3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48]

const BG: Rgb = [24, 25, 28]

// What to highlight: the groups this player holds or points at, and others' held groups by colour.
export interface Marks {
  held: Set<number>
  hover: number | null
  remote: Map<number, Rgb>
}

export class View {
  // The middle of the screen, in table units, and the zoom (an index into ZOOMS).
  cx = 0
  cy = 0
  zoom = 4
  cols = 80
  rows = 24
  private masks: (Mask | undefined)[] = []
  private levels: Level[] = []
  private table: Table

  constructor(table: Table, picture: Picture) {
    this.table = table
    this.levels = mipmaps(picture)
  }

  // Table units per pixel.
  get scale() {
    return this.table.geo.S / ZOOMS[this.zoom]
  }
  // Pixels across and down the area the table is drawn in (all but the status line).
  get pw() {
    return this.cols
  }
  get ph() {
    return Math.max(1, this.rows - 1) * 2
  }

  // The table point at a character cell (0-based), in the middle of the cell.
  toTable(col: number, row: number): [number, number] {
    const s = this.scale
    return [this.cx + (col + 0.5 - this.pw / 2) * s, this.cy + (row * 2 + 1 - this.ph / 2) * s]
  }
  // The character cell a table point is in.
  toCell(x: number, y: number): [number, number] {
    const s = this.scale
    return [Math.floor((x - this.cx) / s + this.pw / 2), Math.floor(((y - this.cy) / s + this.ph / 2) / 2)]
  }

  // Shows the whole table, as big as fits.
  fit() {
    const b = this.table.bounds()
    this.cx = (b.x0 + b.x1) / 2
    this.cy = (b.y0 + b.y1) / 2
    const S = this.table.geo.S
    let z = 0
    for (let k = 0; k < ZOOMS.length; k++) {
      const s = S / ZOOMS[k]
      if ((b.x1 - b.x0) / s <= this.pw && (b.y1 - b.y0) / s <= this.ph) z = k
    }
    this.zoom = z
  }

  // Zooms by d steps, keeping the table point at (x, y) where it is on the screen.
  zoomBy(d: number, x = this.cx, y = this.cy) {
    const z = Math.max(0, Math.min(ZOOMS.length - 1, this.zoom + d))
    if (z === this.zoom) return
    const k = ZOOMS[this.zoom] / ZOOMS[z]
    this.cx = x + (this.cx - x) * k
    this.cy = y + (this.cy - y) * k
    this.zoom = z
  }

  private mask(i: number): Mask {
    let m = this.masks[i]
    if (!m) m = this.masks[i] = buildMask(this.table.geo.pieces[i].outline, this.table.geo.S / MASK_RES)
    return m
  }

  // The piece on top at table point (x, y), or -1.
  pieceAt(x: number, y: number) {
    const t = this.table
    let best = -1
    for (let i = 0; i < t.n; i++) if ((best < 0 || t.z[i] > t.z[best]) && this.covers(i, x, y)) best = i
    return best
  }

  private covers(i: number, x: number, y: number) {
    const t = this.table
    const dx = x - t.x[i]
    const dy = y - t.y[i]
    // Back into the piece's own frame: turned the other way.
    const k = (4 - t.r[i]) & 3
    const lx = dx * COS[k] - dy * SIN[k]
    const ly = dx * SIN[k] + dy * COS[k]
    const m = this.mask(i)
    const c = Math.floor((lx - m.x0) / m.step)
    const r = Math.floor((ly - m.y0) / m.step)
    return c >= 0 && r >= 0 && c < m.cols && r < m.rows && m.bits[r * m.cols + c] === 1
  }

  // Draws the table into the cells, all but the last row (the status line).
  render(c: Cells, marks: Marks) {
    const t = this.table
    const { pw, ph } = this
    const s = this.scale
    const geo = t.geo
    const reach = (Math.max(geo.w, geo.h) / 2 + geo.pad) * Math.SQRT2
    // Pieces by bucket, so each pixel only looks at the pieces near it.
    const B = reach * 2
    const buckets = new Map<number, number[]>()
    const key = (bx: number, by: number) => bx * 65536 + by
    const x0 = this.cx - (pw / 2) * s - B
    const y0 = this.cy - (ph / 2) * s - B
    const x1 = this.cx + (pw / 2) * s + B
    const y1 = this.cy + (ph / 2) * s + B
    for (let i = 0; i < t.n; i++) {
      if (t.x[i] < x0 || t.x[i] > x1 || t.y[i] < y0 || t.y[i] > y1) continue
      const k = key(Math.floor((t.x[i] - x0) / B), Math.floor((t.y[i] - y0) / B))
      const list = buckets.get(k)
      if (list) list.push(i)
      else buckets.set(k, [i])
    }
    const owner = new Int32Array(pw * ph).fill(-1)
    const rgb = new Float32Array(pw * ph * 3)
    // The picture level for this zoom: the biggest that's no finer than a pixel.
    const pic0 = this.levels[0]
    const picScale = pic0.width / t.room.width
    let L = 0
    while (L + 1 < this.levels.length && 2 ** (L + 1) <= s * picScale) L++
    const pic = this.levels[L]
    const pk = picScale / 2 ** L
    const trays = [...t.trays.values()]
    const near: number[] = []

    for (let py = 0; py < ph; py++) {
      const wy = this.cy + (py + 0.5 - ph / 2) * s
      for (let px = 0; px < pw; px++) {
        const wx = this.cx + (px + 0.5 - pw / 2) * s
        const bx = Math.floor((wx - x0) / B)
        const by = Math.floor((wy - y0) / B)
        near.length = 0
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of buckets.get(key(bx + a, by + b)) || []) near.push(i)
        let best = -1
        let lx = 0
        let ly = 0
        for (const i of near) {
          if (best >= 0 && t.z[i] <= t.z[best]) continue
          const dx = wx - t.x[i]
          const dy = wy - t.y[i]
          if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue
          const k = (4 - t.r[i]) & 3
          const ux = dx * COS[k] - dy * SIN[k]
          const uy = dx * SIN[k] + dy * COS[k]
          const m = this.mask(i)
          const c = Math.floor((ux - m.x0) / m.step)
          const r = Math.floor((uy - m.y0) / m.step)
          if (c >= 0 && r >= 0 && c < m.cols && r < m.rows && m.bits[r * m.cols + c] === 1) {
            best = i
            lx = ux
            ly = uy
          }
        }
        const o = (py * pw + px) * 3
        if (best >= 0) {
          owner[py * pw + px] = best
          const p = geo.pieces[best]
          const ix = Math.min(pic.width - 1, Math.max(0, Math.floor((p.cx + lx) * pk)))
          const iy = Math.min(pic.height - 1, Math.max(0, Math.floor((p.cy + ly) * pk)))
          const q = (iy * pic.width + ix) * 3
          rgb[o] = pic.rgb[q]
          rgb[o + 1] = pic.rgb[q + 1]
          rgb[o + 2] = pic.rgb[q + 2]
        } else {
          let c = BG
          for (const tr of trays) if (wx >= tr.x && wx < tr.x + tr.w && wy >= tr.y && wy < tr.y + tr.h) c = mix(BG, hex(trayColor(tr.color)), 0.18)
          rgb[o] = c[0]
          rgb[o + 1] = c[1]
          rgb[o + 2] = c[2]
        }
      }
    }

    // Edges: where a group meets the table or another group.
    const edge = (px: number, py: number, g: number) => {
      if (px < 0 || py < 0 || px >= pw || py >= ph) return false
      const o = owner[py * pw + px]
      return o < 0 || t.g[o] !== g
    }
    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        const o = owner[py * pw + px]
        if (o < 0) continue
        const g = t.g[o]
        if (!(edge(px - 1, py, g) || edge(px + 1, py, g) || edge(px, py - 1, g) || edge(px, py + 1, g))) continue
        const q = (py * pw + px) * 3
        const here: Rgb = [rgb[q], rgb[q + 1], rgb[q + 2]]
        const ring = marks.held.has(g) ? ([255, 214, 10] as Rgb) : marks.remote.get(g) || (marks.hover === g ? ([255, 255, 255] as Rgb) : null)
        const c = ring ? ring : mix(here, [0, 0, 0], 0.55)
        rgb[q] = c[0]
        rgb[q + 1] = c[1]
        rgb[q + 2] = c[2]
      }
    }

    for (let row = 0; row < ph / 2; row++) {
      for (let col = 0; col < pw; col++) {
        const a = (row * 2 * pw + col) * 3
        const b = ((row * 2 + 1) * pw + col) * 3
        c.pixels(col, row, [rgb[a], rgb[a + 1], rgb[a + 2]], [rgb[b], rgb[b + 1], rgb[b + 2]])
      }
    }
  }
}

// Fills a piece's outline (x, y pairs around its cell's middle) into a grid of samples step apart.
function buildMask(outline: Float32Array, step: number): Mask {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let k = 0; k < outline.length; k += 2) {
    x0 = Math.min(x0, outline[k])
    x1 = Math.max(x1, outline[k])
    y0 = Math.min(y0, outline[k + 1])
    y1 = Math.max(y1, outline[k + 1])
  }
  const cols = Math.ceil((x1 - x0) / step) + 1
  const rows = Math.ceil((y1 - y0) / step) + 1
  const bits = new Uint8Array(cols * rows)
  const xs: number[] = []
  const n = outline.length / 2
  for (let r = 0; r < rows; r++) {
    const y = y0 + (r + 0.5) * step
    xs.length = 0
    for (let k = 0; k < n; k++) {
      const ax = outline[k * 2]
      const ay = outline[k * 2 + 1]
      const bx = outline[((k + 1) % n) * 2]
      const by = outline[((k + 1) % n) * 2 + 1]
      if (ay <= y !== by <= y) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - x0) / step - 0.5))
      const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - x0) / step - 0.5))
      for (let c = c0; c <= c1; c++) bits[r * cols + c] = 1
    }
  }
  // Grown by a sample all round, so neighbouring pieces overlap a hair instead of leaving pinholes
  // between them where the samples fall just outside both.
  const grown = new Uint8Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!bits[r * cols + c]) continue
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const rr = r + a
        const cc = c + b
        if (rr >= 0 && cc >= 0 && rr < rows && cc < cols) grown[rr * cols + cc] = 1
      }
    }
  }
  return { x0, y0, step, cols, rows, bits: grown }
}

// The picture at full size, then halved again and again, each pixel the average of four.
function mipmaps(p: Picture): Level[] {
  const rgb = new Uint8Array(p.width * p.height * 3)
  for (let i = 0; i < p.width * p.height; i++) {
    rgb[i * 3] = p.data[i * 4]
    rgb[i * 3 + 1] = p.data[i * 4 + 1]
    rgb[i * 3 + 2] = p.data[i * 4 + 2]
  }
  const levels: Level[] = [{ width: p.width, height: p.height, rgb }]
  for (;;) {
    const a = levels[levels.length - 1]
    if (a.width < 2 || a.height < 2) break
    const w = a.width >> 1
    const h = a.height >> 1
    const out = new Uint8Array(w * h * 3)
    const src = a.rgb
    const row = a.width * 3
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const q = (y * 2 * a.width + x * 2) * 3
        const o = (y * w + x) * 3
        for (let c = 0; c < 3; c++) out[o + c] = (src[q + c] + src[q + 3 + c] + src[q + row + c] + src[q + row + 3 + c]) >> 2
      }
    }
    levels.push({ width: w, height: h, rgb: out })
  }
  return levels
}
