import { formatTime } from './format.ts'
import { CLOCK_PATH, PIECE_PATH } from '../components/icons.tsx'

// A picture to draw from: an image element or a canvas.
export type Picture = (HTMLImageElement | HTMLCanvasElement) & { naturalWidth?: number; naturalHeight?: number }

// A player on the podium: their name, how many connections they made and how long they played.
interface SharePlayer {
  name: string
  connections: number
  seconds: number
}

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
const FONT = 'ui-sans-serif, system-ui, -apple-system, sans-serif'

// The places on the podium in the order they stand, left to right: second, first, third.
export const PODIUM_ORDER = [1, 0, 2]

// The podium's colours and sizes, as the page has them (see --gold and the rest in styles.css).
function podiumLook() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  const px = (name: string) => parseFloat(v(name))
  const colors = [v('--gold'), v('--silver'), v('--bronze')]
  return {
    ink: v('--podium-ink'),
    width: px('--stand-w'),
    stands: PODIUM_ORDER.map((place) => ({ place, color: colors[place], height: px(`--stand-${place + 1}`) })),
  }
}
const STAND_GAP = 10
const NAME_H = 40
const NAME_GAP = 10

// The two little icons beside the numbers.
const PIECE = new Path2D(PIECE_PATH)
const CLOCK = new Path2D(CLOCK_PATH)

const round = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[]) => {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

// A white edge round the shape just traced, with a shadow under it, as a sticker has.
const sticker = (ctx: CanvasRenderingContext2D, width: number, fill: string) => {
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
const stat = (ctx: CanvasRenderingContext2D, icon: Path2D, text: string, x: number, y: number, k: number) => {
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
  ctx.strokeStyle = ctx.fillStyle
  ctx.stroke(icon)
  ctx.restore()
  ctx.textAlign = 'left'
  ctx.fillText(text, left + size + gap, y)
  ctx.textAlign = 'center'
}

// The site's address, small, in a dark pill with its bottom right corner at (right, bottom). k
// scales it: 1 for a picture about 1200 pixels wide. Also on the timelapse (see timelapse.ts).
export function drawAddress(ctx: CanvasRenderingContext2D, right: number, bottom: number, k = 1) {
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
// name, connections and seconds.
export function renderShare({ image, ranked }: { image: Picture; ranked: SharePlayer[] }): Promise<Blob> {
  const iw = image.naturalWidth || image.width
  const ih = image.naturalHeight || image.height
  const ph = Math.round((WIDTH * ih) / iw)
  const top = ranked.slice(0, 3)
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH + 2 * BORDER
  canvas.height = ph + 2 * BORDER
  const ctx = canvas.getContext('2d')!
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
  const look = podiumLook()
  const stands = look.stands.filter((st) => top[st.place])
  if (!stands.length) return toBlob(canvas)
  const tallest = Math.max(...look.stands.map((st) => st.height))
  const K = Math.min(K_MAX, (ph * PODIUM_H) / (tallest + NAME_GAP + NAME_H), (WIDTH * 0.8) / (stands.length * look.width + (stands.length - 1) * STAND_GAP))
  const podiumH = (tallest + NAME_GAP + NAME_H) * K
  const sw = look.width * K
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
    ctx.fillStyle = look.ink
    const size = (st.place === 0 ? 60 : 44) * K
    ctx.font = `800 ${size}px ${FONT}`
    const rankY = y + bw + 12 * K + size / 2
    ctx.fillText(String(st.place + 1), x + sw / 2, rankY)
    ctx.font = `600 ${13 * K}px ${FONT}`
    const row = 20 * K
    const line = rankY + size / 2 + 6 * K + row / 2
    stat(ctx, PIECE, String(p.connections), x + sw / 2, line, K)
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
    sticker(ctx, nb, look.ink)
    ctx.fillStyle = '#fff'
    ctx.fillText(name, x + sw / 2, ny + nh / 2 + 1)
  })
  return toBlob(canvas)
}

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No image'))), 'image/png'))

// Puts the picture on the clipboard. Where the browser won't allow that, it is saved as a file.
// Returns 'copied' or 'saved'.
// It takes the picture as a promise, so the copy still counts as the click that asked for it.
export async function shareImage(promise: Promise<Blob>): Promise<'copied' | 'saved'> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('No clipboard')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': promise })])
    return 'copied'
  } catch {
    saveFile(await promise, 'jigsaw.png')
    return 'saved'
  }
}

export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Once the download has started with it.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
