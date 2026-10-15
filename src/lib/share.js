import { formatTime } from './time.js'

// The picture to share: the finished jigsaw, blurred and dimmed, with the podium (as it looks in the
// game) over it, in a white frame, with the site's address in the bottom right corner. Nothing in it
// is see-through, since many apps paste a copied picture's see-through parts as white or black.
const WIDTH = 1200
const BORDER = 22
const ADDRESS = 'jigsaw.marnil.dev'
// The podium is drawn at most this many times the size it has on the page, and at most this share
// of the picture's height.
const K_MAX = 1.1
const PODIUM_H = 0.5
// The picture behind the podium is blurred and dimmed like the page is behind it in the game.
const BLUR = 4
const DIM = 'rgba(0, 0, 0, 0.35)'
const GOLD = '#f5c542'
const SILVER = '#cfd6de'
const BRONZE = '#dd9358'
const INK = '#1c1a0e'
const FONT = 'ui-sans-serif, system-ui, -apple-system, sans-serif'

// Stands in the order they stand, left to right: second, first, third. Sizes as in the game.
const STANDS = [
  { place: 1, color: SILVER, height: 170 },
  { place: 0, color: GOLD, height: 220 },
  { place: 2, color: BRONZE, height: 135 },
]
const STAND_W = 150
const STAND_GAP = 10
const NAME_H = 40
const NAME_GAP = 10

// The two little icons beside the numbers, as in icons.jsx.
const PIECE = new Path2D('M5 5h4.5a2.5 2.5 0 1 1 5 0H19v4.5a2.5 2.5 0 1 1 0 5V19h-4.5a2.5 2.5 0 1 0-5 0H5v-4.5a2.5 2.5 0 1 0 0-5V5Z')
const CLOCK = new Path2D('M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7.5V12l3 2')

const round = (ctx, x, y, w, h, r) => {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

// A white edge round the shape just traced, with a shadow under it, as a sticker has.
const sticker = (ctx, width, fill) => {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 6
  ctx.lineJoin = 'round'
  ctx.lineWidth = width * 2
  ctx.strokeStyle = '#fff'
  ctx.stroke()
  ctx.restore()
  ctx.fillStyle = fill
  ctx.fill()
}

// One line of a stand: an icon, then the text, together centred on x.
const stat = (ctx, icon, text, x, y, k) => {
  const size = 14 * k
  const gap = 5 * k
  const w = ctx.measureText(text).width
  const left = x - (size + gap + w) / 2
  ctx.save()
  ctx.translate(left, y - size / 2)
  ctx.scale(size / 24, size / 24)
  ctx.lineWidth = 1.6
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = INK
  ctx.stroke(icon)
  ctx.restore()
  ctx.textAlign = 'left'
  ctx.fillText(text, left + size + gap, y)
  ctx.textAlign = 'center'
}

// The site's address, small, in a dark pill with its bottom right corner at (right, bottom). k
// scales it: 1 for a picture about 1200 pixels wide. Also on the timelapse (see timelapse.js).
export function drawAddress(ctx, right, bottom, k = 1) {
  ctx.save()
  ctx.font = `600 ${15 * k}px ${FONT}`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  const pad = 10 * k
  const h = 28 * k
  const w = ctx.measureText(ADDRESS).width + 2 * pad
  round(ctx, right - w, bottom - h, w, h, h / 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.fillText(ADDRESS, right - pad, bottom - h / 2 + k)
  ctx.restore()
}

// image: the picture (a canvas or an image element), ranked: the players, best first, each with
// name, pieces and seconds.
export function renderShare({ image, ranked }) {
  const iw = image.naturalWidth || image.width
  const ih = image.naturalHeight || image.height
  const ph = Math.round((WIDTH * ih) / iw)
  const top = ranked.slice(0, 3)
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH + 2 * BORDER
  canvas.height = ph + 2 * BORDER
  const ctx = canvas.getContext('2d')
  const px = BORDER
  const py = BORDER
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // The white frame, then the jigsaw inside it, blurred and dimmed like the page behind the podium.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  round(ctx, px, py, WIDTH, ph, 14)
  ctx.clip()
  // Drawn a little larger than the frame, so the blur has picture to blur at the edges. Browsers
  // that can't blur a canvas show it sharp.
  const e = BLUR * 3
  ctx.imageSmoothingQuality = 'high'
  if ('filter' in CanvasRenderingContext2D.prototype) ctx.filter = `blur(${BLUR}px)`
  ctx.drawImage(image, px - e, py - e, WIDTH + 2 * e, ph + 2 * e)
  ctx.filter = 'none'
  ctx.fillStyle = DIM
  ctx.fillRect(px, py, WIDTH, ph)
  ctx.restore()
  drawAddress(ctx, px + WIDTH - 14, py + ph - 14)

  // The podium in the middle, smaller if the picture is short.
  const stands = STANDS.filter((st) => top[st.place])
  if (!stands.length) return toBlob(canvas)
  const K = Math.min(K_MAX, (ph * PODIUM_H) / (220 + NAME_GAP + NAME_H), (WIDTH * 0.8) / (stands.length * STAND_W + (stands.length - 1) * STAND_GAP))
  const podiumH = (220 + NAME_GAP + NAME_H) * K
  const sw = STAND_W * K
  const gap = STAND_GAP * K
  const total = stands.length * sw + (stands.length - 1) * gap
  const base = py + ph / 2 + podiumH / 2
  stands.forEach((st, n) => {
    const p = top[st.place]
    const h = st.height * K
    const x = px + (WIDTH - total) / 2 + n * (sw + gap)
    const y = base - h
    // The block: a white border of 5, inside its size, like the page.
    const bw = 5 * K
    round(ctx, x + bw, y + bw, sw - 2 * bw, h - 2 * bw, [13 * K, 13 * K, 3 * K, 3 * K])
    sticker(ctx, bw, st.color)
    ctx.fillStyle = INK
    const size = (st.place === 0 ? 60 : 44) * K
    ctx.font = `800 ${size}px ${FONT}`
    const rankY = y + bw + 12 * K + size / 2
    ctx.fillText(String(st.place + 1), x + sw / 2, rankY)
    ctx.font = `600 ${13 * K}px ${FONT}`
    const row = 20 * K
    const line = rankY + size / 2 + 6 * K + row / 2
    stat(ctx, PIECE, String(p.pieces), x + sw / 2, line, K)
    stat(ctx, CLOCK, formatTime(p.seconds), x + sw / 2, line + row + 6 * K, K)
    // The name, in a dark pill above the block.
    ctx.font = `700 ${16 * K}px ${FONT}`
    let name = p.name
    while (name.length > 1 && ctx.measureText(name).width > sw - 32 * K) name = name.slice(0, -1)
    if (name !== p.name) name += '…'
    const nw = Math.min(sw, ctx.measureText(name).width + 32 * K)
    const nh = NAME_H * K
    const nb = 4 * K
    const ny = y - NAME_GAP * K - nh
    round(ctx, x + (sw - nw) / 2 + nb, ny + nb, nw - 2 * nb, nh - 2 * nb, nh / 2)
    sticker(ctx, nb, INK)
    ctx.fillStyle = '#fff'
    ctx.fillText(name, x + sw / 2, ny + nh / 2 + 1)
  })
  return toBlob(canvas)
}

const toBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No image'))), 'image/png'))

// Puts the picture on the clipboard. Where the browser won't allow that, it is saved as a file.
// Returns 'copied' or 'saved'.
// It takes the picture as a promise, so the copy still counts as the click that asked for it.
export async function shareImage(promise, name = 'jigsaw') {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('No clipboard')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': promise })])
    return 'copied'
  } catch {
    const blob = await promise
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(/[^\w-]+/g, '-').toLowerCase() || 'jigsaw'}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return 'saved'
  }
}
