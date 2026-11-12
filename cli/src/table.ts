// The table as the terminal knows it: where every piece lies, which group it is in, what lies on top,
// and snapping a dropped group onto its neighbours (as Engine.snap in src/lib/engine.ts does).
import { buildPuzzle, gridOffset, neighbours } from '../../src/lib/geometry.ts'
import type { PuzzleGeometry } from '../../src/lib/geometry.ts'
import type { PieceMove, PlayerRef, RoomDetails, TrayInput, TrayRow } from '../../shared/protocol.ts'

export interface Tray {
  id: string
  x: number
  y: number
  w: number
  h: number
  name: string
  color: string
}

export class Table {
  room: RoomDetails
  geo: PuzzleGeometry
  n: number
  x: Float64Array
  y: Float64Array
  r: Uint8Array
  g: Int32Array
  by: (string | null)[]
  // Stacking order: the higher, the more on top.
  z: Float64Array
  top = 0
  trays = new Map<string, Tray>()
  players = new Map<string, string>()
  online: string[] = []

  constructor(room: RoomDetails) {
    this.room = room
    this.geo = buildPuzzle(room)
    this.n = room.cols * room.rows
    this.x = new Float64Array(this.n)
    this.y = new Float64Array(this.n)
    this.r = new Uint8Array(this.n)
    this.g = new Int32Array(this.n)
    this.by = new Array<string | null>(this.n).fill(null)
    this.z = new Float64Array(this.n)
    this.load(room)
  }

  // Everything as the server has it now (on start and after a reconnect).
  load(room: RoomDetails) {
    this.room = room
    for (const p of room.pieces) this.place(p)
    this.trays.clear()
    for (const t of room.trays) this.setTray(t)
    for (const p of room.players) this.players.set(p.id, p.name)
    this.online = room.online
  }

  place(p: PieceMove) {
    if (!(p.i >= 0 && p.i < this.n)) return
    this.x[p.i] = p.x
    this.y[p.i] = p.y
    this.r[p.i] = ((p.r % 4) + 4) % 4
    this.g[p.i] = p.g
    if (p.by !== undefined) this.by[p.i] = p.by
  }

  setTray(t: TrayInput | TrayRow) {
    this.trays.set(t.id, { id: t.id, x: t.x, y: t.y, w: t.w, h: t.h, name: t.name || '', color: t.color || '' })
  }

  learnPlayer(p: PlayerRef) {
    this.players.set(p.id, p.name)
  }

  members(g: number) {
    const out: number[] = []
    for (let i = 0; i < this.n; i++) if (this.g[i] === g) out.push(i)
    return out
  }

  groupCount() {
    return new Set(this.g).size
  }

  // Share of the jigsaw put together, 0 to 1.
  progress() {
    return this.n > 1 ? (this.n - this.groupCount()) / (this.n - 1) : 1
  }

  toTop(ids: Iterable<number>) {
    for (const i of ids) this.z[i] = ++this.top
  }

  // Whether these cells are one piece: a single cell, or the cells of one long piece.
  onePiece(list: number[]) {
    const u = this.geo.unit
    return list.length === 1 || (!!u && list.every((i) => u[i] === u[list[0]]))
  }

  // Snaps the dropped group ids onto the closest matching neighbour, then pulls in any other groups
  // that line up with it. held: groups that others are carrying, which nothing snaps onto. Returns
  // the pieces that changed.
  snap(ids: number[], user: string | null, held: Set<number>) {
    const { cols, rows } = this.room
    const { w, h, S } = this.geo
    const thr = S * 0.22
    const group = new Set(ids)
    const changed = new Set(ids)
    const nbrs = (i: number) => neighbours(i, cols, rows).filter((q) => !held.has(this.g[q]))
    const gap = (p: number, q: number) => {
      if (this.r[p] !== this.r[q]) return null
      const [ex, ey] = gridOffset(cols, w, h, p, q, this.r[p])
      const dx = this.x[q] - (this.x[p] + ex)
      const dy = this.y[q] - (this.y[p] + ey)
      return { dx, dy, d: Math.hypot(dx, dy) }
    }
    const credit = (list: number[]) => {
      if (!user || !this.onePiece(list)) return
      for (const i of list) {
        if (this.by[i]) continue
        this.by[i] = user
        changed.add(i)
      }
    }
    const shift = (list: Iterable<number>, dx: number, dy: number) => {
      for (const i of list) {
        this.x[i] += dx
        this.y[i] += dy
        changed.add(i)
      }
    }

    let best: { p: number; q: number; dx: number; dy: number; d: number } | null = null
    for (const p of ids) {
      for (const q of nbrs(p)) {
        if (group.has(q)) continue
        const m = gap(p, q)
        if (m && m.d < thr && (!best || m.d < best.d)) best = { p, q, ...m }
      }
    }
    if (!best) return changed
    shift(ids, best.dx, best.dy)
    credit(ids)
    const target = this.members(this.g[best.q])
    credit(target)
    for (const i of target) group.add(i)
    const parts = [
      { n: target.length, dx: 0, dy: 0 },
      { n: ids.length, dx: best.dx, dy: best.dy },
    ]
    for (let found = true; found; ) {
      found = false
      for (const p of [...group]) {
        for (const q of nbrs(p)) {
          if (group.has(q)) continue
          const m = gap(p, q)
          if (!m || m.d >= thr) continue
          const other = this.members(this.g[q])
          shift(other, -m.dx, -m.dy)
          for (const i of other) group.add(i)
          credit(other)
          parts.push({ n: other.length, dx: -m.dx, dy: -m.dy })
          found = true
        }
      }
    }
    // The largest group stays where it was and everything else lines up with it.
    const anchor = parts.reduce((a, b) => (b.n > a.n ? b : a))
    if (anchor.dx || anchor.dy) shift(group, -anchor.dx, -anchor.dy)
    let gid = Infinity
    for (const i of group) gid = Math.min(gid, i)
    for (const i of group) {
      if (this.g[i] !== gid) {
        this.g[i] = gid
        changed.add(i)
      }
    }
    return changed
  }

  // The box around every piece, in table units.
  bounds() {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i < this.n; i++) {
      x0 = Math.min(x0, this.x[i])
      y0 = Math.min(y0, this.y[i])
      x1 = Math.max(x1, this.x[i])
      y1 = Math.max(y1, this.y[i])
    }
    const e = this.geo.S
    return { x0: x0 - e, y0: y0 - e, x1: x1 + e, y1: y1 + e }
  }
}
