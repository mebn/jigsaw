// Works out every piece's shape (see sprites.ts) for a jigsaw: in a few workers when the browser can,
// each given a run of pieces' outlines, and sent back as plain pixels for the GPU. Otherwise, or if
// a worker fails, on the main thread, a slice of a frame at a time (see buildSome()).
import { mipLevels, shapeOutline, spriteShape, spriteSize } from './sprites.ts'
import type { ShapePixels, SpriteJob, SpriteReply } from './sprites.ts'
import type { PuzzleGeometry } from './geometry.ts'

// How a jigsaw's sprites are laid out, the same for every piece: how far a sprite reaches past its
// grid cell (margin, world units), sprite pixels per world unit (sc), its size in pixels, its size
// in world units and how many mip levels it has.
export interface SpriteFormat {
  margin: number
  sc: number
  size: [number, number]
  world: [number, number]
  levels: number
}

export function spriteFormat(geo: PuzzleGeometry, n: number): SpriteFormat {
  const { w, h, S, pad } = geo
  const margin = pad + S * 0.12
  // All the sprites together come to about 16 million pixels, at most 2 and at least 0.35 per unit.
  const area = n * (w + 2 * margin) * (h + 2 * margin)
  const sc = Math.min(2, Math.max(0.35, Math.sqrt(16e6 / area)))
  const size = spriteSize(geo, margin, sc)
  return { margin, sc, size, world: [size[0] / sc, size[1] / sc], levels: mipLevels(size) }
}

// Every piece's four corners in its sprite, for the GPU to keep them sharp (see PIECE in gpu.ts):
// per corner, its place in sprite pixels and the outward normals of the sides into and out of it,
// and whether both those sides are cut (not inside a long piece).
export function spriteCorners(geo: PuzzleGeometry, { sc, size: [spw, sph] }: SpriteFormat) {
  const out = new Float32Array(geo.pieces.length * 32)
  const normal = (ax: number, ay: number, bx: number, by: number) => {
    const l = Math.hypot(bx - ax, by - ay) || 1
    return [(by - ay) / l, -(bx - ax) / l]
  }
  for (const p of geo.pieces) {
    const o = p.outline
    const last = o.length / 2 - 1
    for (let s = 0; s < 4; s++) {
      const at = p.sides[s]
      const before = at > 0 ? at - 1 : last - 1
      const vx = o[at * 2]
      const vy = o[at * 2 + 1]
      const n1 = normal(o[before * 2], o[before * 2 + 1], vx, vy)
      const n2 = normal(vx, vy, o[at * 2 + 2], o[at * 2 + 3])
      const sharp = !p.inner || (!p.inner[s] && !p.inner[(s + 3) % 4])
      out.set([vx * sc + spw / 2, vy * sc + sph / 2, n1[0], n1[1], n2[0], n2[1], sharp ? 1 : 0, 0], p.i * 32 + s * 8)
    }
  }
  return out
}

// At most this many workers, however many cores there are.
const SPRITE_WORKERS = 8
// The workers, kept from one jigsaw to the next so they're ready at once, and a count that tells one
// jigsaw's job from the next.
const pool: Worker[] = []
let lastJob = 0
const workerCount = () => Math.max(1, Math.min(SPRITE_WORKERS, (navigator.hardwareConcurrency || 2) - 1))
const canUseWorkers = () => typeof Worker === 'function' && typeof OffscreenCanvas === 'function'

// Starts the sprite workers ahead of time, so they're loaded by the time a jigsaw needs them.
export function warmSprites() {
  if (!canUseWorkers()) return
  try {
    while (pool.length < workerCount()) pool.push(new Worker(new URL('./sprites.worker.ts', import.meta.url), { type: 'module' }))
  } catch {
    // Started when they're needed instead, or not at all.
  }
}

// Ends workers that failed, or are still busy with a jigsaw that's gone.
function dropWorkers(workers: Worker[]) {
  for (const w of workers) {
    w.terminate()
    const k = pool.indexOf(w)
    if (k >= 0) pool.splice(k, 1)
  }
}

export class SpriteBuilder {
  private geo: PuzzleGeometry
  private format: SpriteFormat
  private done: (i: number, shape: ShapePixels) => void
  private changed: () => void
  // Whether piece i has a shape yet.
  private has: (i: number) => boolean
  private next = 0
  private ctx: CanvasRenderingContext2D | null = null
  // The workers on this jigsaw, while they're still sending shapes.
  private workers: Worker[] | null = null

  // done(i, shape) gets each piece's shape as it comes; changed() is called when some came from a
  // worker, or the workers stopped.
  constructor(geo: PuzzleGeometry, format: SpriteFormat, has: (i: number) => boolean, done: (i: number, shape: ShapePixels) => void, changed: () => void) {
    this.geo = geo
    this.format = format
    this.has = has
    this.done = done
    this.changed = changed
    this.startWorkers()
  }

  // Whether the main thread has shapes to work out (see buildSome()).
  get behind() {
    return !this.workers && this.next < this.geo.pieces.length
  }

  private startWorkers() {
    if (!canUseWorkers()) return
    warmSprites()
    const n = this.geo.pieces.length
    const parts = Math.min(pool.length, Math.ceil(n / 100))
    if (!parts) return
    const job = ++lastJob
    const workers = pool.slice(0, parts)
    let left = parts
    this.workers = workers
    // When all are done, or one fails: the main thread works out whatever is still missing.
    const stop = (failed: boolean) => {
      if (this.workers !== workers) return
      this.workers = null
      if (failed) dropWorkers(workers)
      this.changed()
    }
    const { size, sc, levels } = this.format
    const per = Math.ceil(n / parts)
    workers.forEach((worker, part) => {
      worker.onmessage = ({ data }: MessageEvent<SpriteReply>) => {
        if (this.workers !== workers || data.job !== job) return
        if (data.kind === 'front') {
          for (const { i, shape } of data.items) this.done(i, shape)
          this.changed()
        } else if (data.kind === 'done') {
          if (!--left) stop(false)
        } else {
          console.warn('Piece shapes are worked out on the page instead:', data.message)
          stop(true)
        }
      }
      worker.onerror = () => stop(true)
      const items: SpriteJob['items'] = []
      const transfer: Transferable[] = []
      for (let i = part * per; i < Math.min(n, (part + 1) * per); i++) {
        const o = shapeOutline(this.geo.pieces[i], this.geo)
        items.push({ i, ...o })
        transfer.push(o.pts.buffer, o.codes.buffer)
      }
      worker.postMessage({ job, size, sc, levels, items } satisfies SpriteJob, transfer)
    })
  }

  // Works out shapes on the main thread until the deadline (ms, as performance.now()).
  buildSome(until: number) {
    const n = this.geo.pieces.length
    if (this.next < n) this.ctx ??= makeCanvas(...this.format.size).getContext('2d', { willReadFrequently: true })
    while (this.next < n && performance.now() < until) {
      const i = this.next++
      if (this.has(i)) continue
      this.done(i, spriteShape(this.ctx!, this.format.sc, shapeOutline(this.geo.pieces[i], this.geo), this.format.levels))
    }
  }

  // The jigsaw is gone: workers still busy with it are ended.
  stop() {
    if (this.workers) dropWorkers(this.workers)
    this.workers = null
  }
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}
