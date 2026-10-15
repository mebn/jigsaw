// Builds every piece's sprites off the main thread and posts them back in batches as ImageBitmaps.
// Posts { kind: 'fail' } if it can't draw
// here, and the engine builds whatever is missing itself.
import { buildPuzzle, outlinePath } from './geometry.js'
import { buildSprite } from './sprites.js'

// A batch is posted after about this long (ms), so sprites show up while the rest are drawn.
const BATCH_MS = 16

self.onmessage = (e) => {
  const { room, image, margin, sc } = e.data
  try {
    const geo = buildPuzzle(room)
    const o = { geo, room, image, margin, sc }
    const make = (w, h) => new OffscreenCanvas(w, h)
    if (!make(1, 1).getContext('2d')) throw new Error('no 2d context')
    let items = []
    let transfer = []
    let t = performance.now()
    const add = (i, sprite) => {
      const lv = { color: sprite.color.map((c) => c.transferToImageBitmap()), shape: sprite.shape.map((c) => c.transferToImageBitmap()) }
      items.push({ i, lv })
      transfer.push(...lv.color, ...lv.shape)
    }
    const flush = (kind, force) => {
      if (!items.length || (!force && performance.now() - t < BATCH_MS)) return
      self.postMessage({ kind, items }, transfer)
      items = []
      transfer = []
      t = performance.now()
    }
    const paths = geo.pieces.map((p) => outlinePath(p.outline))
    for (const p of geo.pieces) {
      add(p.i, buildSprite(o, p, paths[p.i], make))
      flush('front')
    }
    flush('front', true)
    self.postMessage({ kind: 'done' })
  } catch (err) {
    self.postMessage({ kind: 'fail', message: String(err) })
  }
}
