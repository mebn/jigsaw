import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import { shapeOutline } from './sprites.js'
import { drawAddress } from './share.js'

// A timelapse of a jigsaw being put together, as a looping GIF: one frame each time its biggest group
// grew (saved by the server, see snapshot() in server/api.js), the group cut out of the picture on
// a plain background, with the site's address in the bottom right corner.

// The longest side of the GIF, in pixels.
const SIZE = 600
// Room round the picture, for the shadow.
const PAD = 16
const BACKGROUND = '#f2f1ee'
// At most this many frames, so a big jigsaw doesn't run for minutes.
const MAX_FRAMES = 140
// The whole timelapse lasts about this long (ms), with each frame shown between these.
const LENGTH = 8000
const MIN_DELAY = 40
const MAX_DELAY = 250
// The finished picture stays this long before it starts again.
const HOLD = 2500

// The snapshots as lists of cells, dropping any at the start that are a single piece (the cells of
// a long piece start out together, so its group can be the biggest before anything was joined).
export function framesFor(snapshots, unit) {
  const frames = snapshots.map(({ pieces }) => {
    const bits = Uint8Array.from(atob(pieces), (c) => c.charCodeAt(0))
    const cells = []
    for (let i = 0; i < bits.length * 8; i++) if (bits[i >> 3] & (1 << (i & 7))) cells.push(i)
    return cells
  })
  const single = (cells) => cells.length < 2 || (!!unit && cells.every((i) => unit[i] === unit[cells[0]]))
  while (frames.length && single(frames[0])) frames.shift()
  return frames
}

// Keeps at most MAX_FRAMES, evenly spread, always with the last.
function thin(frames) {
  if (frames.length <= MAX_FRAMES) return frames
  const out = []
  for (let k = 0; k < MAX_FRAMES; k++) out.push(frames[Math.round((k * (frames.length - 1)) / (MAX_FRAMES - 1))])
  return out
}

// Resolves with the GIF as a Blob. room: { width, height }; geo: from buildPuzzle(); image: the
// picture (an image or canvas); frames: from framesFor(). Yields now and then so the page stays
// responsive, and gives up (resolving with null) once stopped() is true.
export async function renderTimelapse({ room, geo, image, frames, stopped = () => false }) {
  frames = thin(frames)
  const k = (SIZE - 2 * PAD) / Math.max(room.width, room.height)
  const W = Math.round(room.width * k) + 2 * PAD
  const H = Math.round(room.height * k) + 2 * PAD
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  // Each cell's outline, in place in the finished picture.
  const paths = geo.pieces.map((p) => {
    const { pts } = shapeOutline(p, geo)
    const path = new Path2D()
    path.moveTo(p.cx + pts[0], p.cy + pts[1])
    for (let j = 2; j < pts.length; j += 2) path.lineTo(p.cx + pts[j], p.cy + pts[j + 1])
    path.closePath()
    return path
  })

  const draw = (cells) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = BACKGROUND
    ctx.fillRect(0, 0, W, H)
    ctx.setTransform(k, 0, 0, k, PAD, PAD)
    const shape = new Path2D()
    for (const i of cells) shape.addPath(paths[i])
    ctx.save()
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)'
    ctx.shadowBlur = 8
    ctx.shadowOffsetY = 2
    ctx.fillStyle = BACKGROUND
    ctx.fill(shape)
    ctx.restore()
    ctx.save()
    ctx.clip(shape)
    ctx.drawImage(image, 0, 0, room.width, room.height)
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    drawAddress(ctx, W - PAD - 6, H - PAD - 6, 0.6)
    return ctx.getImageData(0, 0, W, H).data
  }

  // One palette for every frame, from the last, which has every colour of the picture and the
  // background. Its last entry is left for see-through.
  const last = draw(frames[frames.length - 1])
  const colors = quantize(last, 255)
  const clear = colors.length
  const palette = [...colors, [0, 0, 0]]

  const delay = Math.max(MIN_DELAY, Math.min(MAX_DELAY, LENGTH / frames.length))
  const gif = GIFEncoder()
  let prev = null
  for (let f = 0; f < frames.length; f++) {
    const data = f === frames.length - 1 ? last : draw(frames[f])
    const index = applyPalette(data, colors)
    // Pixels that are as they were in the frame before are left see-through, so they keep showing
    // it and the GIF only stores what changed.
    if (!prev) prev = index.slice()
    else {
      for (let p = 0; p < index.length; p++) {
        if (index[p] === prev[p]) index[p] = clear
        else prev[p] = index[p]
      }
    }
    gif.writeFrame(index, W, H, {
      palette: f === 0 ? palette : undefined,
      delay: f === frames.length - 1 ? HOLD : delay,
      transparent: f > 0,
      transparentIndex: clear,
      // Leave the frame in place for the next to draw over.
      dispose: 1,
    })
    if (f % 8 === 7) {
      await new Promise((r) => setTimeout(r))
      if (stopped()) return null
    }
  }
  gif.finish()
  return new Blob([gif.bytes()], { type: 'image/gif' })
}
