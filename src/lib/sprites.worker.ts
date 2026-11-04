// Works out pieces' shapes off the main thread (see spriteShape()) and posts them back in batches,
// as plain pixels the engine writes straight into the GPU's shape atlas. Gets { job, size, sc, levels, items },
// items being { i, pts, codes } (see shapeOutline()), and posts { job, kind: 'front', items: [{ i,
// shape }] } as it goes, then { job, kind: 'done' }, or { job, kind: 'fail' } if it can't draw here.
// It's kept for the next jigsaw once done.
import { spriteShape } from './sprites.ts'
import type { SpriteJob, SpriteReply } from './sprites.ts'

// This runs as a module worker, but the app is type checked with the DOM's globals: the worker's own
// self, as far as it's used here.
declare const self: {
  onmessage: ((e: MessageEvent<SpriteJob>) => void) | null
  postMessage(message: SpriteReply, transfer?: Transferable[]): void
}

// A batch is posted after about this long (ms), so pieces show up while the rest are worked out.
const BATCH_MS = 16

self.onmessage = (e) => {
  const { job, size, sc, levels, items: todo } = e.data
  try {
    const [w, h] = size
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no 2d context')
    let items: Extract<SpriteReply, { kind: 'front' }>['items'] = []
    let transfer: Transferable[] = []
    let t = performance.now()
    const flush = (force?: boolean) => {
      if (!items.length || (!force && performance.now() - t < BATCH_MS)) return
      self.postMessage({ job, kind: 'front', items }, transfer)
      items = []
      transfer = []
      t = performance.now()
    }
    for (const it of todo) {
      const shape = spriteShape(ctx, sc, it, levels)
      items.push({ i: it.i, shape })
      for (const lv of shape) transfer.push(lv.data.buffer)
      flush()
    }
    flush(true)
    self.postMessage({ job, kind: 'done' })
  } catch (err) {
    self.postMessage({ job, kind: 'fail', message: String(err) })
  }
}
