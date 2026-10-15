// Works out pieces' shapes off the main thread (see spriteShape()) and posts them back in batches,
// as plain pixels the engine writes straight into the GPU's shape atlas. Gets { job, size, sc, items },
// items being { i, pts, codes } (see shapeOutline()), and posts { job, kind: 'front', items: [{ i,
// shape }] } as it goes, then { job, kind: 'done' }, or { job, kind: 'fail' } if it can't draw here.
// It's kept for the next jigsaw once done.
import { spriteShape } from './sprites.js'

// A batch is posted after about this long (ms), so pieces show up while the rest are worked out.
const BATCH_MS = 16

self.onmessage = (e) => {
  const { job, size, sc, items: todo } = e.data
  try {
    const [w, h] = size
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no 2d context')
    let items = []
    let transfer = []
    let t = performance.now()
    const flush = (force) => {
      if (!items.length || (!force && performance.now() - t < BATCH_MS)) return
      self.postMessage({ job, kind: 'front', items }, transfer)
      items = []
      transfer = []
      t = performance.now()
    }
    for (const it of todo) {
      const data = spriteShape(ctx, sc, it)
      items.push({ i: it.i, shape: { w, h, data } })
      transfer.push(data.buffer)
      flush()
    }
    flush(true)
    self.postMessage({ job, kind: 'done' })
  } catch (err) {
    self.postMessage({ job, kind: 'fail', message: String(err) })
  }
}
