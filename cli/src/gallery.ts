// The jigsaws page in the terminal: every jigsaw on the site as a card with its picture, name and
// progress. Pick one to play it.
import type { RoomSummary } from '../../shared/protocol.ts'
import { AccountDialog, LoginDialog } from './dialog.ts'
import type { InputEvent } from './input.ts'
import { C, inRect, mix } from './screen.ts'
import type { Cells, Rect, Rgb, Scene, Terminal } from './screen.ts'
import type { Session } from './session.ts'
import type { Picture } from './view.ts'

const MIN_CARD = 24
const FRAME: Rgb = [62, 64, 74]

export class Gallery implements Scene {
  private term: Terminal
  private session: Session
  private open: (room: RoomSummary) => void
  private rooms: RoomSummary[] | null = null
  private error = ''
  private message = ''
  private thumbs = new Map<string, Picture | 'loading' | 'failed'>()
  // Thumbnails shrunk to a card's size: RGB, by id and size.
  private scaled = new Map<string, Uint8Array>()
  private sel = 0
  private scroll = 0
  private cols = 1
  private hits: { r: Rect; fn: () => void; hover?: () => void }[] = []

  constructor(term: Terminal, session: Session, open: (room: RoomSummary) => void) {
    this.term = term
    this.session = session
    this.open = open
  }

  // Shown on the status line until the next key, such as why a jigsaw didn't open.
  say(text: string) {
    this.message = text
    this.term.invalidate()
  }

  async load() {
    this.error = ''
    try {
      this.rooms = await this.session.rooms()
      this.sel = Math.min(this.sel, Math.max(0, this.rooms.length - 1))
    } catch (e) {
      this.error = (e as Error).message
    }
    this.term.invalidate()
    // Pictures four at a time, in the order they're shown.
    const queue = (this.rooms || []).filter((r) => !this.thumbs.has(r.id))
    const next = async (): Promise<void> => {
      const r = queue.shift()
      if (!r) return
      this.thumbs.set(r.id, 'loading')
      try {
        this.thumbs.set(r.id, await this.session.picture(r.id, r.thumb ? 'thumb' : 'image'))
      } catch {
        this.thumbs.set(r.id, 'failed')
      }
      this.term.invalidate()
      return next()
    }
    await Promise.all([next(), next(), next(), next()])
  }

  private account() {
    if (this.session.me) this.term.push(new AccountDialog(this.term, this.session))
    else this.term.push(new LoginDialog(this.term, this.session, () => {}))
  }

  input(e: InputEvent) {
    this.message = ''
    const n = this.rooms?.length || 0
    if (e.kind === 'wheel') {
      this.scroll = Math.max(0, this.scroll + e.dir)
    } else if (e.kind === 'mouse') {
      const hit = this.hits.find((h) => inRect(h.r, e.col, e.row))
      if (e.type === 'down' && e.button === 0) hit?.fn()
      else if (e.type === 'move') hit?.hover?.()
    } else {
      const k = e.key.toLowerCase()
      const move: Record<string, number> = { left: -1, a: -1, right: 1, d: 1, up: -this.cols, w: -this.cols, down: this.cols, s: this.cols }
      if (move[k] && n) {
        this.sel = Math.max(0, Math.min(n - 1, this.sel + move[k]))
        this.reveal = true
      } else if ((k === 'enter' || k === ' ') && this.rooms?.[this.sel]) this.open(this.rooms[this.sel])
      else if (k === 'l') this.account()
      else if (k === 'r') this.load()
      else if (k === 'q' || k === 'escape') this.term.quit()
    }
    this.term.invalidate()
  }

  // The selected card is scrolled into view on the next draw.
  private reveal = true

  draw(c: Cells) {
    this.hits = []
    const site = this.session.origin.replace(/^https?:\/\//, '')
    let x = c.text(1, 0, 'Jigsaws', C.text, undefined, true)
    c.text(x + 2, 0, site, C.dim)
    // The login button, top right.
    const label = this.session.me ? ` ${this.session.me.name} ▾ ` : ' Log in '
    const bx = c.w - [...label].length - 1
    c.text(bx, 0, label, this.session.me ? C.text : C.black, this.session.me ? C.field : C.accent, true)
    this.hits.push({ r: { col: bx, row: 0, w: [...label].length, h: 1 }, fn: () => this.account() })

    const status = this.message || 'Arrows choose · Enter play · L ' + (this.session.me ? 'account' : 'log in') + ' · R reload · Q quit'
    c.text(0, c.h - 1, (' ' + status).padEnd(c.w), C.black, this.message ? C.accent : C.dim)

    if (this.error) return void c.text(2, 2, this.error, C.bad)
    if (!this.rooms) return void c.text(2, 2, 'Loading the jigsaws…', C.dim)
    if (!this.rooms.length) return void c.text(2, 2, 'No jigsaws here yet: make one on the website.', C.dim)

    // As many cards across as fit, each at least MIN_CARD wide.
    this.cols = Math.max(1, Math.floor((c.w - 2) / (MIN_CARD + 1)))
    const slotW = Math.floor((c.w - 2) / this.cols)
    const imgW = slotW - 3
    const imgRows = Math.max(3, Math.round(imgW / 3))
    const slotH = imgRows + 4
    const top = 2
    const gridH = c.h - 1 - top
    const visible = Math.max(1, Math.floor(gridH / slotH))
    const lines = Math.ceil(this.rooms.length / this.cols)
    if (this.reveal) {
      const line = Math.floor(this.sel / this.cols)
      if (line < this.scroll) this.scroll = line
      if (line >= this.scroll + visible) this.scroll = line - visible + 1
      this.reveal = false
    }
    this.scroll = Math.max(0, Math.min(this.scroll, lines - visible))

    this.rooms.forEach((r, i) => {
      const line = Math.floor(i / this.cols) - this.scroll
      if (line < 0 || line >= visible) return
      const box = { col: 1 + (i % this.cols) * slotW, row: top + line * slotH, w: slotW - 1, h: slotH }
      const on = i === this.sel
      c.frame(box, on ? C.accent : FRAME)
      this.hits.push({ r: box, fn: () => ((this.sel = i), this.open(r)), hover: () => (this.sel = i) })
      this.picture(c, r, box.col + 1, box.row + 1, imgW, imgRows)
      const tx = box.col + 2
      const tw = box.w - 4
      const name = r.name || 'Untitled'
      c.text(tx, box.row + imgRows + 1, [...name].length > tw ? [...name].slice(0, tw - 1).join('') + '…' : name, C.text, undefined, true)
      const info = `${r.n} pieces${r.private ? ' · private' : ''}`
      c.text(tx, box.row + imgRows + 2, info, C.dim, undefined, false, tw)
      const state = r.done ? '✓ done' : `${Math.round(r.progress * 100)}%`
      c.text(tx + tw - [...state].length, box.row + imgRows + 2, state, r.done ? C.good : on ? C.accent : C.text)
    })
    if (lines > visible) c.text(c.w - 12, c.h - 2, ` ${this.scroll + 1}–${Math.min(lines, this.scroll + visible)} of ${lines} `, C.dim)
  }

  // A jigsaw's picture, shrunk to fit w cells by h (two pixels each), in the middle.
  private picture(c: Cells, r: RoomSummary, col: number, row: number, w: number, h: number) {
    const pic = this.thumbs.get(r.id)
    if (!pic || pic === 'loading' || pic === 'failed') {
      c.text(col + Math.floor((w - 1) / 2), row + Math.floor(h / 2), pic === 'failed' ? '?' : '·', C.dim)
      return
    }
    const key = `${r.id}:${w}x${h}`
    let rgb = this.scaled.get(key)
    if (!rgb) this.scaled.set(key, (rgb = shrink(pic, w, h * 2)))
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = ((y * 2) * w + x) * 3
        const b = ((y * 2 + 1) * w + x) * 3
        c.pixels(col + x, row + y, [rgb[a], rgb[a + 1], rgb[a + 2]], [rgb[b], rgb[b + 1], rgb[b + 2]])
      }
    }
  }
}

// The picture shrunk to fit w by h pixels, keeping its shape, the rest the table's colour. Each
// pixel is the average of the part of the picture it covers.
function shrink(p: Picture, w: number, h: number) {
  const out = new Uint8Array(w * h * 3)
  const k = Math.min(w / p.width, h / p.height)
  const dw = p.width * k
  const dh = p.height * k
  const ox = (w - dw) / 2
  const oy = (h - dh) / 2
  const bg = mix(C.bg, C.panel, 0.5)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3
      const sx0 = (x - ox) / k
      const sy0 = (y - oy) / k
      const sx1 = (x + 1 - ox) / k
      const sy1 = (y + 1 - oy) / k
      if (sx1 <= 0 || sy1 <= 0 || sx0 >= p.width || sy0 >= p.height) {
        out[o] = bg[0]
        out[o + 1] = bg[1]
        out[o + 2] = bg[2]
        continue
      }
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      const step = Math.max(1, Math.floor((sx1 - sx0) / 4))
      for (let sy = Math.max(0, Math.floor(sy0)); sy < Math.min(p.height, Math.ceil(sy1)); sy += step) {
        for (let sx = Math.max(0, Math.floor(sx0)); sx < Math.min(p.width, Math.ceil(sx1)); sx += step) {
          const q = (sy * p.width + sx) * 4
          r += p.data[q]
          g += p.data[q + 1]
          b += p.data[q + 2]
          n++
        }
      }
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
    }
  }
  return out
}
