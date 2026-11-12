// The terminal as a grid of character cells: scenes draw into Cells, and the terminal is sent only
// the cells that changed since the last frame.
import { parseInput } from './input.ts'
import type { InputEvent } from './input.ts'

export type Rgb = [number, number, number]
export const pack = ([r, g, b]: Rgb) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const hex = (s: string): Rgb => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s)
  if (!m) return [139, 141, 152]
  const v = parseInt(m[1], 16)
  return [v >> 16, (v >> 8) & 255, v & 255]
}

export const C = {
  bg: [24, 25, 28] as Rgb,
  panel: [34, 35, 40] as Rgb,
  field: [48, 50, 58] as Rgb,
  text: [230, 230, 235] as Rgb,
  dim: [140, 142, 152] as Rgb,
  accent: [255, 214, 10] as Rgb,
  good: [74, 222, 128] as Rgb,
  bad: [248, 113, 113] as Rgb,
  black: [0, 0, 0] as Rgb,
  white: [255, 255, 255] as Rgb,
}

// A box on the screen, in cells.
export interface Rect {
  col: number
  row: number
  w: number
  h: number
}
export const inRect = (r: Rect, col: number, row: number) => col >= r.col && row >= r.row && col < r.col + r.w && row < r.row + r.h

export class Cells {
  w: number
  h: number
  ch: string[]
  fg: Int32Array
  bg: Int32Array
  bold: Uint8Array

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.ch = new Array<string>(w * h).fill(' ')
    this.fg = new Int32Array(w * h).fill(pack(C.text))
    this.bg = new Int32Array(w * h).fill(pack(C.bg))
    this.bold = new Uint8Array(w * h)
  }

  // One cell. bg left out keeps the cell's background.
  put(col: number, row: number, ch: string, fg: Rgb, bg?: Rgb, bold = false) {
    if (col < 0 || row < 0 || col >= this.w || row >= this.h) return
    const k = row * this.w + col
    this.ch[k] = ch
    this.fg[k] = pack(fg)
    if (bg) this.bg[k] = pack(bg)
    this.bold[k] = bold ? 1 : 0
  }

  // Two pixels in one cell, one above the other.
  pixels(col: number, row: number, top: Rgb, bottom: Rgb) {
    this.put(col, row, '▀', top, bottom)
  }

  // Text from (col, row), cut off at max cells. Returns the cell after it.
  text(col: number, row: number, s: string, fg: Rgb, bg?: Rgb, bold = false, max = Infinity) {
    let k = 0
    for (const ch of s) {
      if (k >= max) break
      this.put(col + k++, row, ch, fg, bg, bold)
    }
    return col + k
  }

  fill(r: Rect, bg: Rgb) {
    for (let y = r.row; y < r.row + r.h; y++) for (let x = r.col; x < r.col + r.w; x++) this.put(x, y, ' ', C.text, bg)
  }

  // A frame of box drawing lines just inside r.
  frame(r: Rect, fg: Rgb) {
    const x1 = r.col + r.w - 1
    const y1 = r.row + r.h - 1
    for (let x = r.col + 1; x < x1; x++) {
      this.put(x, r.row, '─', fg)
      this.put(x, y1, '─', fg)
    }
    for (let y = r.row + 1; y < y1; y++) {
      this.put(r.col, y, '│', fg)
      this.put(x1, y, '│', fg)
    }
    this.put(r.col, r.row, '╭', fg)
    this.put(x1, r.row, '╮', fg)
    this.put(r.col, y1, '╰', fg)
    this.put(x1, y1, '╯', fg)
  }

  // Escape codes that turn prev (what's on the terminal now, or null for nothing) into this.
  diff(prev: Cells | null, truecolor: boolean) {
    const same = prev && prev.w === this.w && prev.h === this.h
    const out: string[] = []
    let fg = -1
    let bg = -1
    let bold = -1
    let at = -1
    for (let k = 0; k < this.w * this.h; k++) {
      if (same && prev.ch[k] === this.ch[k] && prev.fg[k] === this.fg[k] && prev.bg[k] === this.bg[k] && prev.bold[k] === this.bold[k]) continue
      if (k !== at) out.push(`\x1b[${Math.floor(k / this.w) + 1};${(k % this.w) + 1}H`)
      if (this.bold[k] !== bold) out.push((bold = this.bold[k]) ? '\x1b[1m' : '\x1b[22m')
      if (this.fg[k] !== fg) out.push(color((fg = this.fg[k]), false, truecolor))
      if (this.bg[k] !== bg) out.push(color((bg = this.bg[k]), true, truecolor))
      out.push(this.ch[k])
      at = k + 1
      // The terminal wraps after the last column: say where to go next.
      if (at % this.w === 0) at = -1
    }
    return out.join('')
  }
}

function color(v: number, back: boolean, truecolor: boolean) {
  const r = v >> 16
  const g = (v >> 8) & 255
  const b = v & 255
  if (truecolor) return `\x1b[${back ? 48 : 38};2;${r};${g};${b}m`
  const q = (x: number) => Math.round((x / 255) * 5)
  return `\x1b[${back ? 48 : 38};5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m`
}

// What's on the screen: draws itself into the cells and takes the input.
export interface Scene {
  draw(c: Cells): void
  input(e: InputEvent): void
}

// The terminal: raw input, the alternate screen, and redrawing whatever is dirty 30 times a second.
export class Terminal {
  truecolor: boolean
  private layers: Scene[] = []
  private prev: Cells | null = null
  private dirty = true
  private timer: ReturnType<typeof setInterval> | null = null
  private out = process.stdout

  constructor(truecolor: boolean) {
    this.truecolor = truecolor
  }

  get cols() {
    return this.out.columns || 80
  }
  get rows() {
    return this.out.rows || 24
  }

  start() {
    if (!process.stdin.isTTY) throw new Error('Run this in a terminal.')
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1003h\x1b[?1006h')
    process.stdin.setRawMode(true)
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    process.stdin.on('data', (d: string) => {
      for (const e of parseInput(d)) {
        if (e.kind === 'key' && e.ctrl && e.key === 'c') return this.quit()
        this.layers[this.layers.length - 1]?.input(e)
      }
    })
    this.out.on('resize', () => {
      this.prev = null
      this.out.write('\x1b[2J')
      this.invalidate()
    })
    process.on('SIGTERM', () => this.quit())
    process.on('uncaughtException', (err) => {
      this.restore()
      console.error(err)
      process.exit(1)
    })
    this.timer = setInterval(() => this.draw(), 33)
  }

  // The scene on top gets the input; all of them draw, bottom first.
  push(s: Scene) {
    this.layers.push(s)
    this.invalidate()
  }
  pop(s: Scene) {
    this.layers = this.layers.filter((l) => l !== s)
    this.invalidate()
  }
  replace(s: Scene) {
    this.layers = [s]
    this.invalidate()
  }
  top() {
    return this.layers[this.layers.length - 1]
  }

  invalidate() {
    this.dirty = true
  }

  private draw() {
    if (!this.dirty) return
    this.dirty = false
    const c = new Cells(this.cols, this.rows)
    for (const l of this.layers) l.draw(c)
    this.out.write(c.diff(this.prev, this.truecolor))
    this.prev = c
  }

  restore() {
    if (this.timer) clearInterval(this.timer)
    this.out.write('\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[0m\x1b[?1049l')
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  }

  // Set by main: leaves cleanly (closing sockets first).
  onQuit: () => void = () => {}
  quit(msg?: string) {
    this.onQuit()
    this.restore()
    if (msg) process.stdout.write(msg + '\n')
    setTimeout(() => process.exit(0), 100)
  }
}
