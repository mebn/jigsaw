// Imperative canvas engine: rendering (with WebGPU, see gpu.js), camera, dragging, rotation and snapping.
import { buildPuzzle, outlinePath, pack, packExtent, scatter, unitCells } from './geometry.js'
import { drawFront, levels, MIPS, spriteSize } from './sprites.js'
import { createGpu, PIECE_FLOATS, REF_FLOATS, TRAY_FLOATS } from './gpu.js'

const Q = Math.PI / 2
const COS = [1, 0, -1, 0]
const SIN = [0, 1, 0, -1]
const mod4 = (k) => ((k % 4) + 4) % 4
const rot = (x, y, k) => {
  k = mod4(k)
  return [x * COS[k] - y * SIN[k], x * SIN[k] + y * COS[k]]
}
const ease = (dt, ms) => 1 - Math.exp(-dt / ms)
const r2 = (v) => Math.round(v * 100) / 100
// Live drag updates are throttled to this interval (ms).
const LIVE_MS = 33
// How many live updates of a carry are kept for the spectator's replay (about eight seconds).
const TRACE_FRAMES = 240
// The burst where two pieces join: how long it lasts, after waiting for the pieces to land.
export const POP_MS = 520
const POP_DELAY = 80
const MAX_POPS = 12
// Pieces held with a finger ride this far (screen px) above it, so the finger doesn't hide them.
const TOUCH_LIFT = 72
const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')
// The size of an empty tray, in piece sizes.
const TRAY_W = 6
const TRAY_H = 4
// Tray colours, by the name stored with each tray.
export const TRAY_COLORS = {
  blue: '#3b82f6',
  green: '#22a06b',
  yellow: '#e0a800',
  orange: '#f97316',
  red: '#e5484d',
  purple: '#8e4ec6',
  gray: '#8b8d98',
}
// How far the table reaches from the middle of the pieces on every side, in jigsaw sizes.
const TABLE = 10
// How far a press may move and still count as a click.
const CLICK_PX = 5
// How far (screen px) an alt drag on an image goes from faintest to solid.
const REF_FADE_PX = 300
// How long (ms) tray and image buttons take to fade in or out.
const BTN_MS = 140
// Screen-space size of reference image handles.
const HANDLE = 7
// How far a tray's or image's buttons stand out over its top edge, as a part of their size, like a note's.
const BTN_OUT = 0.44
// A button of size tag on the top right corner (x, y) of something, standing out over its edges.
const cornerButton = (x, y, tag) => [x - tag * (1 - BTN_OUT), y - tag * BTN_OUT, x + tag * BTN_OUT, y + tag * (1 - BTN_OUT)]
// Cursor updates are throttled to this interval (ms); idle cursors vanish after CURSOR_IDLE.
const CURSOR_MS = 50
// How many moves of each player can be undone.
const HISTORY = 100
// Images, trays and notes as undo remembers them: plain copies. Two are the same when every field matches
// (a tray's pieces are left out, they are tracked with the pieces).
const snapObj = (o) => (o ? { ...o, pieces: o.pieces ? o.pieces.slice() : undefined } : null)
const sameObj = (a, b) =>
  !a || !b ? !a && !b : Object.keys(b).every((k) => k === 'pieces' || a[k] === b[k]) && Object.keys(a).every((k) => k === 'pieces' || b[k] === a[k])
const snapSel = (e) => ({ p: new Set(e.sel), r: new Set(e.selRefs), n: new Set(e.selNotes) })
const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v))
const sameSel = (a, b) => sameSet(a.p, b.p) && sameSet(a.r, b.r) && sameSet(a.n, b.n)
// As much of text as fits in width pixels in ctx's font, ending in "…" when cut short; '' if none does.
const fitText = (ctx, text, width) => {
  if (ctx.measureText(text).width <= width) return text
  let lo = 0
  let hi = text.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(text.slice(0, mid).trimEnd() + '…').width <= width) lo = mid
    else hi = mid - 1
  }
  return lo ? text.slice(0, lo).trimEnd() + '…' : ''
}
const sameLook = (a, b) => a.x === b.x && a.y === b.y && a.r === b.r && a.g === b.g && a.by === b.by && a.t === b.t
const CURSOR_IDLE = 20000
// Our selection and hover go out at most this often (ms); the most outlines drawn for other players.
const MARKS_MS = 100
const MAX_OUTLINES = 8
// Canvases are never drawn finer than this many pixels per CSS pixel.
const MAX_DPR = 2
const makeCanvas = (w, h) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}
// A CSS colour as [r, g, b, a], each 0 to 1, read back from a canvas so any colour the browser
// knows works.
const colors = new Map()
let colorCtx = null
const rgba = (css) => {
  let c = colors.get(css)
  if (!c) {
    colorCtx ??= makeCanvas(1, 1).getContext('2d', { willReadFrequently: true })
    colorCtx.clearRect(0, 0, 1, 1)
    colorCtx.fillStyle = '#000'
    colorCtx.fillStyle = css
    colorCtx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data
    colors.set(css, (c = [r / 255, g / 255, b / 255, a / 255]))
  }
  return c
}
// A colour premultiplied by its alpha, times alpha.
const pm = ([r, g, b, a], alpha = 1) => [r * a * alpha, g * a * alpha, b * a * alpha, a * alpha]
// a, or a bigger array if it holds fewer than n numbers.
const grow = (a, n) => (a.length >= n ? a : new Float32Array(Math.max(n, a.length * 2)))
// Arrow keys and WASD move the camera, at this many screen pixels per second, speeding up the
// longer they are held: up to PAN_BOOST times as fast after PAN_RAMP ms. Holding a piece, tray,
// image or note within EDGE_PX of the view's edge moves it the same way.
const PAN_SPEED = 900
const EDGE_PX = 40
const PAN_BOOST = 3.5
const PAN_RAMP = 1500
const PAN_KEYS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  w: [0, -1],
  s: [0, 1],
}
const CURSOR_COLORS = ['#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#d6409f', '#12a594', '#ca8a04']
const cursorColor = (id) => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length]
}

export class Engine {
  constructor(canvas, { room, image, pieces, refs, trays, overlay, user, userName, nameOf, guard, tooltip, send, onStats, onComplete, onRef, onRefDelete, onTray, onTrayDelete, onSnap, onMenu, onHistory }) {
    this.canvas = canvas
    // The table is drawn with WebGPU on a canvas stacked under the board (see startGpu() and
    // drawGpu()), the whole of it every frame. The board canvas only holds the small things on
    // top, drawn in 2D: image handles, the bursts where pieces join and the selection box.
    this.ctx = canvas.getContext('2d')
    this.gpuEl = document.createElement('canvas')
    this.gpuEl.className = 'gpu'
    // Over the notes: the trays and what lies in them, the pieces being carried and the outlines.
    this.gpuTop = document.createElement('canvas')
    this.gpuTop.className = 'gpu top'
    this.gpu = null
    // The camera the board was last drawn for.
    this.mv = { x: NaN, y: NaN, z: NaN, w: NaN, h: NaN }
    this.hitCtx = makeCanvas(1, 1).getContext('2d')
    // Other players' cursors go on a separate canvas stacked above the notes.
    this.overlay = overlay
    this.octx = overlay?.getContext('2d')
    this.room = room
    this.image = image
    // This player's id (stored on what they do) and name (shown on their cursor).
    this.user = user
    this.userName = userName
    // Looks up a player's name by id, for the tooltips.
    this.nameOf = nameOf || ((id) => id)
    // Called before any action that needs a player name; returns false to block it.
    this.guard = guard
    this.tooltip = tooltip
    this.send = send
    this.onStats = onStats
    // Pieces just connected, by this player (local) or another: onSnap({ seams, local }). The sound ignores seams.
    this.onSnap = onSnap
    // A right click on a piece, image, tray or note, without dragging: onMenu(sx, sy, kind, id). It is selected.
    this.onMenu = onMenu
    // Undo and redo, for this player's own moves: onHistory({ undo, redo }) says what is available.
    this.onHistory = onHistory
    this.onComplete = onComplete
    // Reference image changes: onRef(ref, live) while and after editing, onRefDelete(id).
    this.onRef = (ref, live) => {
      onRef?.(ref, live)
      if (!live) this.trackObj('ref', ref.id, ref)
    }
    this.onRefDelete = onRefDelete
    // Tray changes: onTray(tray, live) while and after moving it, onTrayDelete(id).
    this.onTray = (tray, live) => {
      onTray?.(tray, live)
      if (!live) this.trackObj('tray', tray.id, tray)
    }
    this.onTrayDelete = onTrayDelete
    // Spectator mode (see spectate.js): when set, it draws the table in its own screens instead of
    // the one view, and this player neither plays nor shows a cursor.
    this.spectator = null
    // How other players carried pieces just before putting them down: client -> { ids, ox, oy, r0,
    // frames: [{ t, px, py, k }] }, kept for the spectator's replays.
    this.traces = new Map()
    // Called with (cam, vw, vh) whenever the view changes, see addView().
    this.views = new Set()
    this.viewsVer = 0

    this.geo = buildPuzzle(room)
    const n = (this.n = room.cols * room.rows)
    // Long pieces: per cell, the cell its piece starts at (null if every cell is its own piece), and
    // the cells of each long piece by that first cell. The cells of a long piece are joined from the
    // start and act as one piece.
    this.unit = this.geo.unit
    this.longs = unitCells(this.unit)
    this.paths = this.geo.pieces.map((p) => outlinePath(p.outline))
    this.x = new Float64Array(n)
    this.y = new Float64Array(n)
    this.r = new Int8Array(n)
    this.g = new Int32Array(n)
    this.by = new Array(n).fill(null)
    // Pieces turned in place on the table, still animating: i -> { cx, cy, a } (a in radians, decays to
    // 0), one object shared by all the pieces of a module.
    this.turns = new Map()
    this.hl = null
    // Selected pieces (always whole groups), reference images and notes, by id.
    this.sel = new Set()
    this.selRefs = new Set()
    this.selNotes = new Set()
    // Set by the notes layer: { get() -> [{ id, x, y, w, h }], move(list, send), select(ids), focus(id) }.
    this.notes = null
    // Images, notes and trays riding along with a drag: { pointer, wx, wy, sx0, sy0, moved, note, refs,
    // notes, trays }. A moved tray also has lift: the pieces in it, picked up once the pointer moves.
    this.carry = null
    this.marquee = null
    // Other players' drags in progress: client -> { ids, ox, oy, r0 }.
    this.remote = new Map()
    // Other players' pointers: client -> { x, y, tx, ty, name, color, t }.
    this.cursors = new Map()
    this.lastCursor = 0
    // What other players have selected or hover over: client -> { sel, hl } (piece ids), outlined in
    // their cursor colour. Ours go out the same way, throttled, see sendMarks().
    this.marks = new Map()
    // The player on each other client, as their cursor and marks say, so a player keeps one colour.
    this.players = new Map()
    this.lastMarks = 0
    // Pieces other players carry are lifted with a shadow like ours: client -> { ids, set, value, target }.
    this.rlift = new Map()
    for (const p of pieces) {
      this.x[p.i] = p.x
      this.y[p.i] = p.y
      this.r[p.i] = p.r
      this.g[p.i] = p.g
      this.by[p.i] = p.by || null
    }
    const sizes = new Map()
    for (let i = 0; i < n; i++) sizes.set(this.g[i], (sizes.get(this.g[i]) || 0) + 1)
    this.order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => sizes.get(this.g[b]) - sizes.get(this.g[a]),
    )

    const { w, h, S, pad } = this.geo
    this.margin = pad + S * 0.12
    this.radius = Math.hypot(w / 2 + this.margin, h / 2 + this.margin)
    const spriteArea = n * (w + 2 * this.margin) * (h + 2 * this.margin)
    this.spriteScale = Math.min(2, Math.max(0.35, Math.sqrt(16e6 / spriteArea)))
    this.imgScale = image.naturalWidth / room.width
    // Every sprite has the same size, and is drawn at this size in world units.
    const [spw, sph] = spriteSize(this.geo, this.margin, this.spriteScale)
    this.spriteW = spw / this.spriteScale
    this.spriteH = sph / this.spriteScale
    // Per piece: its sprite and halved copies of it (see levels()), made in the background.
    this.sprites = new Array(n)
    this.built = 0

    // Reference images, shared by the room: { id, x, y, w, author } in world units (centre and width).
    this.refs = (refs || []).filter((r) => isFinite(r.x) && isFinite(r.y) && r.w > 0)
    this.refSel = null
    this.refDrag = null
    // A shift press on an image, until it turns out to be a click or a resize: { rh, pointer, sx0, sy0 }.
    this.refShift = null
    // A shift press on a piece in a tray, until it turns out to be a click (select the piece) or a
    // drag (move the tray): { th, i, pointer, sx0, sy0, wx, wy }.
    this.trayShift = null
    // An alt drag on an image, changing its opacity: { ref, pointer, sx0, op0, moved }.
    this.refFade = null
    // Tray and image buttons show only while the pointer is over their tray or image: hovered is that
    // one ('tray:<id>' or 'ref:<id>'), btnShow how far each one's buttons have faded in (0 to 1).
    this.hovered = null
    // The tray or image whose right click menu is open, the same way: its buttons stay shown.
    this.menuFor = null
    this.btnShow = new Map()
    this.btnT = 0

    // Trays, shared by the room: { id, x, y, w, h, color, pieces, author } in world units, x and y
    // being the top left corner. pieces lists the pieces in it, which it fits itself around. The last
    // one is on top. One can be selected: space and G then work on its pieces, Delete removes it.
    this.trays = (trays || [])
      .filter((t) => isFinite(t.x) && isFinite(t.y) && t.w > 0 && t.h > 0)
      .map((t) => ({ ...t, auto: !!t.auto, pieces: Array.isArray(t.pieces) ? t.pieces : [] }))
    this.traySel = null
    this.hist = { undo: [], redo: [] }
    // What every piece looked like at the last move, by anyone, so each move knows what it changed.
    this.sh = { x: this.x.slice(), y: this.y.slice(), r: this.r.slice(), g: this.g.slice(), by: this.by.slice() }
    this.shTray = new Map()
    this.trackTrays()
    // Where trays that others move are headed: id -> { x, y, w, h }.
    this.trayTo = new Map()
    // Images, trays and notes as they were at the last change, by anyone, by id.
    this.objSh = { ref: new Map(), tray: new Map(), note: new Map() }
    this.resetSeen('ref', this.refs)
    this.resetSeen('tray', this.trays)
    this.pend = null
    this.inPress = false
    this.pressId = 0
    this.refAspect = image.naturalHeight / image.naturalWidth
    const rk = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight))
    this.refImg = document.createElement('canvas')
    this.refImg.width = Math.max(1, Math.round(image.naturalWidth * rk))
    this.refImg.height = Math.max(1, Math.round(image.naturalHeight * rk))
    this.refImg.getContext('2d').drawImage(image, 0, 0, this.refImg.width, this.refImg.height)

    const b = this.bbox(this.order)
    const ext = Math.max(b.x1 - b.x0, b.y1 - b.y0, room.width, room.height) * TABLE
    const mx = (b.x0 + b.x1) / 2
    const my = (b.y0 + b.y1) / 2
    this.bounds = { x0: mx - ext, y0: my - ext, x1: mx + ext, y1: my + ext }

    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    this.vw = 1
    this.vh = 1
    this.cam = { x: mx, y: my, z: 1 }
    this.camAnim = null
    this.drag = null
    this.lift = null
    this.pan = null
    this.pointers = new Map()
    this.touches = new Set()
    // Pan keys held down right now.
    this.panKeys = new Set()
    // When the pan keys were first pressed, for speeding up while held.
    this.panSince = 0
    // View mode: the left button (and a finger) moves the table instead of pieces or selecting.
    this.panMode = false
    this.held = new Map()
    this.moving = new Map()
    // Bursts where pieces just joined: { x, y, t0, a } in world units.
    this.pops = []
    this.colors = { bg: '#f4f4f4', card: '#fafafa', edge: 'rgba(0,0,0,.1)', dot: 'rgba(0,0,0,.12)', shadow: 'rgba(0,0,0,.35)', sel: '#2f6fed' }
    this.last = performance.now()
    this.lastLive = 0

    // Whether the jigsaw is finished, so finishing it is only noticed once.
    this.done = this.isComplete()

    this.bind()
    this.resize()
    this.startSprites()
    const saved = this.loadCam()
    if (saved) this.cam = saved
    else this.fit(false)
    // Resolves once the table can be drawn; rejects if WebGPU can't be started.
    this.ready = this.startGpu()
  }

  // Starts WebGPU, puts every sprite made so far in its atlas and shows the GPU canvas. Sprites made
  // later go there as they come, see setSprite().
  async startGpu() {
    const [spw, sph] = spriteSize(this.geo, this.margin, this.spriteScale)
    const gpu = await createGpu(this.gpuEl, this.gpuTop, { cells: this.n, spw, sph, levels: MIPS + 1 })
    if (this.raf === -1) return gpu.destroy()
    this.gpu = gpu
    // Per frame: the pieces' instances (still, active, lifted, then the outlined ones again), trays and images.
    this.gi = new Float32Array((2 * this.n + 8) * PIECE_FLOATS)
    this.giu = new Uint32Array(this.gi.buffer)
    this.gTrays = new Float32Array(0)
    this.gRefs = new Float32Array(0)
    gpu.onLost = (why) => console.error('WebGPU device lost:', why)
    gpu.setRefImage(this.refImg)
    this.sprites.forEach((lv, i) => lv && gpu.upload(i, lv))
    this.canvas.before(this.gpuEl)
    this.canvas.after(this.gpuTop)
    this.resize()
  }

  // A piece's sprite levels, kept and sent to the GPU.
  setSprite(i, lv) {
    if (!this.sprites[i]) this.built++
    this.sprites[i] = lv
    this.gpu?.upload(i, lv)
  }

  // ---- lifecycle ----------------------------------------------------------

  bind() {
    const c = this.canvas
    this.h = {
      down: (e) => this.onDown(e),
      move: (e) => this.onMove(e),
      up: (e) => this.onUp(e),
      wheel: (e) => this.onWheel(e),
      key: (e) => {
        this.setShift(e)
        this.onKey(e)
      },
      keyup: (e) => {
        this.setShift(e)
        if (this.panKeys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key)) this.invalidate()
      },
      stopPan: () => this.panKeys.clear(),
      leave: () => {
        this.showTip(null)
        this.setHighlight(null)
        this.setHovered(null)
      },
      // The pointer is tracked over the whole window, so notes and panels above the canvas don't hide it.
      track: (e) => {
        if (!e.isPrimary) return
        const [sx, sy] = this.pos(e)
        if (sx < 0 || sy < 0 || sx > this.vw || sy > this.vh) return
        this.pointerAt = [sx, sy]
        this.sendCursor()
      },
      gone: () => {
        if (this.drag) return
        clearTimeout(this.cursorTimer)
        this.pointerAt = null
        this.send({ type: 'cursor', hide: true })
      },
      // No context menu on the table, nor anywhere while something is being dragged (a right or
      // shift + right click mid drag lands on whatever is under the pointer, not always the table).
      menu: (e) => {
        if (e.target === c || this.drag || this.pan || this.marquee || this.refDrag) e.preventDefault()
      },
      // The browser's own drag and drop (of a page selection, say) never starts from the table.
      nodrag: (e) => e.preventDefault(),
      // The canvas position is cached (see pos()); scrolling or resizing the window can move it.
      moved: () => {
        this.rect = this.canvas.getBoundingClientRect()
      },
    }
    c.addEventListener('pointerdown', this.h.down)
    c.addEventListener('pointermove', this.h.move)
    c.addEventListener('pointerup', this.h.up)
    c.addEventListener('pointercancel', this.h.up)
    c.addEventListener('pointerleave', this.h.leave)
    c.addEventListener('wheel', this.h.wheel, { passive: false })
    window.addEventListener('contextmenu', this.h.menu, true)
    this.host = c.parentElement
    this.host?.addEventListener('dragstart', this.h.nodrag)
    window.addEventListener('keydown', this.h.key)
    window.addEventListener('keyup', this.h.keyup)
    window.addEventListener('blur', this.h.stopPan)
    window.addEventListener('pointermove', this.h.track, true)
    document.documentElement.addEventListener('pointerleave', this.h.gone)
    window.addEventListener('blur', this.h.gone)
    window.addEventListener('scroll', this.h.moved, { capture: true, passive: true })
    window.addEventListener('resize', this.h.moved)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(c)
  }

  destroy() {
    const c = this.canvas
    c.removeEventListener('pointerdown', this.h.down)
    c.removeEventListener('pointermove', this.h.move)
    c.removeEventListener('pointerup', this.h.up)
    c.removeEventListener('pointercancel', this.h.up)
    c.removeEventListener('pointerleave', this.h.leave)
    c.removeEventListener('wheel', this.h.wheel)
    window.removeEventListener('contextmenu', this.h.menu, true)
    this.host?.removeEventListener('dragstart', this.h.nodrag)
    window.removeEventListener('keydown', this.h.key)
    window.removeEventListener('keyup', this.h.keyup)
    window.removeEventListener('blur', this.h.stopPan)
    window.removeEventListener('pointermove', this.h.track, true)
    document.documentElement.removeEventListener('pointerleave', this.h.gone)
    window.removeEventListener('blur', this.h.gone)
    window.removeEventListener('scroll', this.h.moved, { capture: true })
    window.removeEventListener('resize', this.h.moved)
    this.ro.disconnect()
    cancelAnimationFrame(this.raf)
    this.raf = -1
    this.spriteHost?.terminate()
    this.spriteWorker = this.spriteHost = null
    this.gpu?.destroy()
    this.gpu = null
    this.gpuEl.remove()
    this.gpuTop.remove()
  }

  resize() {
    const rect = (this.rect = this.canvas.getBoundingClientRect())
    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    this.vw = Math.max(1, rect.width)
    this.vh = Math.max(1, rect.height)
    for (const c of [this.canvas, this.gpuEl, this.gpuTop, this.overlay]) {
      // The spectator sizes the GPU canvases itself, to one screen at a time.
      if (!c || (this.spectator && (c === this.gpuEl || c === this.gpuTop))) continue
      c.width = Math.round(this.vw * this.dpr)
      c.height = Math.round(this.vh * this.dpr)
    }
    this.dirty = true
    this.invalidate()
  }

  setColors(colors) {
    this.colors = colors
    this.invalidate()
  }

  // Starts or stops spectator mode, see spectate.js.
  setSpectator(s) {
    this.spectator = s
    if (s) {
      this.setSelection(new Set())
      this.selectRef(null)
      this.selectTray(null)
      this.setHighlight(null)
      this.showTip(null)
    } else {
      this.dirty = true
      this.resize()
    }
    this.invalidate()
  }

  // Sizes the GPU canvases for one spectator screen, in device pixels. Nothing happens if they
  // already have that size.
  setGpuSize(w, h) {
    for (const c of [this.gpuEl, this.gpuTop]) {
      if (c.width !== w) c.width = w
      if (c.height !== h) c.height = h
    }
  }

  // Asks for a frame.
  invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.render())
  }

  // ---- camera -------------------------------------------------------------

  get zmin() {
    return Math.min(4 / this.geo.S, (this.vw / (this.bounds.x1 - this.bounds.x0)) * 2)
  }
  get zmax() {
    return 900 / this.geo.S
  }

  // Calls fn(cam, vw, vh) now and whenever the view changes. Returns a function that stops it.
  addView(fn) {
    this.views.add(fn)
    this.viewsVer++
    this.invalidate()
    return () => {
      this.views.delete(fn)
      this.viewsVer++
    }
  }

  toWorld(sx, sy) {
    return [(sx - this.vw / 2) / this.cam.z + this.cam.x, (sy - this.vh / 2) / this.cam.z + this.cam.y]
  }

  clampCam() {
    const { x0, y0, x1, y1 } = this.bounds
    this.cam.z = Math.min(this.zmax, Math.max(this.zmin, this.cam.z))
    this.cam.x = Math.min(x1, Math.max(x0, this.cam.x))
    this.cam.y = Math.min(y1, Math.max(y0, this.cam.y))
    this.saveCam()
  }

  zoomAt(sx, sy, f) {
    const [wx, wy] = this.toWorld(sx, sy)
    this.cam.z = Math.min(this.zmax, Math.max(this.zmin, this.cam.z * f))
    this.cam.x = wx - (sx - this.vw / 2) / this.cam.z
    this.cam.y = wy - (sy - this.vh / 2) / this.cam.z
    this.clampCam()
    this.invalidate()
  }

  // Eases the zoom around the middle of the view. Presses during the animation add up.
  zoomBy(f) {
    const a = this.camAnim
    const from = a?.zoom ? a.to : this.cam
    const z = Math.min(this.zmax, Math.max(this.zmin, from.z * f))
    this.camAnim = { from: { ...this.cam }, to: { x: from.x, y: from.y, z }, t0: performance.now(), ms: 260, zoom: true }
    this.invalidate()
  }

  bbox(ids, e = Math.max(this.geo.w, this.geo.h) / 2 + this.geo.pad) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const i of ids) {
      x0 = Math.min(x0, this.x[i] - e)
      y0 = Math.min(y0, this.y[i] - e)
      x1 = Math.max(x1, this.x[i] + e)
      y1 = Math.max(y1, this.y[i] + e)
    }
    return { x0, y0, x1, y1 }
  }

  frame(b, fill = 0.85, animate = true) {
    const z = Math.min(
      this.zmax,
      Math.max(this.zmin, Math.min((this.vw * fill) / (b.x1 - b.x0), (this.vh * fill) / (b.y1 - b.y0))),
    )
    const to = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z }
    if (animate) this.camAnim = { from: { ...this.cam }, to, t0: performance.now(), ms: 550 }
    else this.cam = to
    this.invalidate()
  }

  // C: frames everything on the table: pieces, trays, images and notes.
  fit(animate = true) {
    const b = this.bbox(this.order)
    const add = (x0, y0, x1, y1) => {
      b.x0 = Math.min(b.x0, x0)
      b.y0 = Math.min(b.y0, y0)
      b.x1 = Math.max(b.x1, x1)
      b.y1 = Math.max(b.y1, y1)
    }
    for (const t of this.trays) add(t.x, t.y, t.x + t.w, t.y + t.h)
    for (const r of this.refs) {
      const [w, h] = this.refSize(r)
      add(r.x - w / 2, r.y - h / 2, r.x + w / 2, r.y + h / 2)
    }
    for (const n of this.notes?.get() || []) add(n.x, n.y, n.x + n.w, n.y + n.h)
    this.frame(b, 0.82, animate)
  }

  saveCam() {
    clearTimeout(this.camTimer)
    this.camTimer = setTimeout(() => {
      try {
        localStorage.setItem(`cam:${this.room.id}`, JSON.stringify(this.cam))
      } catch {}
    }, 300)
  }

  loadCam() {
    try {
      const c = JSON.parse(localStorage.getItem(`cam:${this.room.id}`))
      if (c && isFinite(c.x) && isFinite(c.y) && c.z > 0) return c
    } catch {}
    return null
  }

  // ---- pieces -------------------------------------------------------------

  isComplete() {
    const g = this.g[0]
    for (let i = 1; i < this.n; i++) if (this.g[i] !== g) return false
    return true
  }

  // Per player id: how many pieces they connected.
  contributors() {
    const m = new Map()
    const get = (id) => {
      if (!m.has(id)) m.set(id, { id, pieces: 0 })
      return m.get(id)
    }
    for (let i = 0; i < this.n; i++) if (this.by[i] && (!this.unit || this.unit[i] === i)) get(this.by[i]).pieces++
    return m
  }

  // The cells of the piece cell i is part of: just i, or all of a long piece.
  cellsOf(i) {
    return (this.unit && this.longs.get(this.unit[i])) || [i]
  }

  // Whether these cells are one piece: a single cell, or the cells of one long piece.
  onePiece(list) {
    if (list.length === 1) return true
    const u = this.unit
    return !!u && list.length === this.cellsOf(list[0]).length && list.every((i) => u[i] === u[list[0]])
  }

  members(gid) {
    const out = []
    for (let i = 0; i < this.n; i++) if (this.g[i] === gid) out.push(i)
    return out
  }

  emitStats() {
    clearTimeout(this.statsTimer)
    this.statsTimer = setTimeout(() => this.onStats?.(), 120)
  }

  toTop(set) {
    this.order = this.order.filter((i) => !set.has(i)).concat([...set])
  }

  // Expands a set of pieces to the whole groups they belong to.
  withGroups(ids) {
    const gids = new Set()
    for (const i of ids) gids.add(this.g[i])
    const out = new Set()
    for (let i = 0; i < this.n; i++) if (gids.has(this.g[i])) out.add(i)
    return out
  }

  // Splits a list of pieces into one list per group.
  modules(ids) {
    const m = new Map()
    for (const i of ids) {
      if (!m.has(this.g[i])) m.set(this.g[i], [])
      m.get(this.g[i]).push(i)
    }
    return [...m.values()]
  }

  // The selected pieces that nobody else is holding right now. A selected tray counts as selecting
  // its pieces (without outlining them), so space and G work on them too. With loose, groups that
  // are in a tray are left out, so turning or sorting a selection leaves the trays as they are.
  freeSelection(loose = false) {
    if (this.done) return []
    const now = performance.now()
    if (!this.sel.size && this.traySel) {
      const t = this.trays.find((x) => x.id === this.traySel)
      return t ? this.trayPieces(t) : []
    }
    const ids = [...this.withGroups(this.sel)].filter((i) => !(this.held.get(i) > now))
    if (!loose || !this.trays.some((t) => t.pieces.length)) return ids
    const inTray = new Set(this.trays.flatMap((t) => t.pieces))
    const skip = new Set(ids.filter((i) => inTray.has(i)).map((i) => this.g[i]))
    return ids.filter((i) => !skip.has(this.g[i]))
  }

  // Ends any movement animation on these pieces, so they sit where they are headed.
  settle(ids) {
    for (const i of ids) {
      const to = this.moving.get(i)
      if (to) [this.x[i], this.y[i]] = to
      this.moving.delete(i)
    }
  }

  // Where piece i is drawn on the table, including a turn in progress: sets this.qx, this.qy and
  // this.qa (the angle). Kept in fields so drawing thousands of pieces allocates nothing.
  poseInto(i) {
    const t = this.turns.size ? this.turns.get(i) : undefined
    // A self turn only eases the piece's angle, around wherever it is (pieces carried by others).
    if (!t || t.self) {
      this.qx = this.x[i]
      this.qy = this.y[i]
      this.qa = this.r[i] * Q + (t ? t.a : 0)
      return
    }
    const dx = this.x[i] - t.cx
    const dy = this.y[i] - t.cy
    const c = Math.cos(t.a)
    const s = Math.sin(t.a)
    this.qx = t.cx + dx * c - dy * s
    this.qy = t.cy + dx * s + dy * c
    this.qa = this.r[i] * Q + t.a
  }

  setSelection(set, refs = new Set(), notes = new Set()) {
    const before = this.noSelHistory ? null : snapSel(this)
    if (this.done && set.size) set = new Set()
    const same = (a, b) => a.size === b.size && [...a].every((v) => b.has(v))
    this.sel = set
    this.selRefs = refs
    if (!same(notes, this.selNotes)) this.notes?.select(notes)
    this.selNotes = notes
    if (before) this.recordSel(before)
    this.sendMarks()
    this.invalidate()
  }

  get selCount() {
    return this.sel.size + this.selRefs.size + this.selNotes.size
  }

  // Everything except the pieces lying in trays.
  selectAll() {
    const inTray = new Set(this.trays.flatMap((t) => t.pieces))
    const pieces = new Set(Array.from({ length: this.n }, (_, i) => i).filter((i) => !inTray.has(i)))
    const refs = new Set(this.refs.map((r) => r.id))
    const notes = new Set((this.notes?.get() || []).map((n) => n.id))
    this.selectRef(null)
    this.setSelection(pieces, refs, notes)
  }

  toggleRef(id) {
    const refs = new Set(this.selRefs)
    refs.has(id) ? refs.delete(id) : refs.add(id)
    this.setSelection(this.sel, refs, this.selNotes)
  }

  toggleNote(id) {
    const notes = new Set(this.selNotes)
    notes.has(id) ? notes.delete(id) : notes.add(id)
    this.setSelection(this.sel, this.selRefs, notes)
  }

  // Picks up the whole selection: its pieces as a normal drag, with images and notes riding along.
  // Also called by the notes layer when a selected note is dragged, hence the pointer capture.
  grabSelection(e, from = {}) {
    const [sx, sy] = this.pos(e)
    const [wx, wy] = this.toWorld(sx, sy)
    if (!this.pointers.has(e.pointerId)) {
      this.canvas.setPointerCapture(e.pointerId)
      this.pointers.set(e.pointerId, [sx, sy])
    }
    const now = performance.now()
    const ids = [...this.withGroups(this.sel)].filter((j) => !(this.held.get(j) > now))
    if (ids.length) {
      this.startDrag(ids, wx, wy, e.pointerId, sx, sy)
      // Only a press on a piece can be a click that selects it.
      if (!from.piece) this.drag.moved = true
    }
    const notes = this.notes?.get().filter((n) => this.selNotes.has(n.id)) || []
    this.carry = {
      pointer: e.pointerId,
      wx: this.drag ? this.drag.px : wx,
      wy: this.drag ? this.drag.py : wy,
      sx0: sx,
      sy0: sy,
      moved: false,
      note: from.note || null,
      refs: this.refs.filter((r) => this.selRefs.has(r.id)).map((r) => ({ id: r.id, x: r.x, y: r.y })),
      notes: notes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
      trays: [],
    }
    this.canvas.style.cursor = 'grabbing'
    // Carried images go on top, like a lifted piece.
    this.refs = this.refs.filter((r) => !this.selRefs.has(r.id)).concat(this.refs.filter((r) => this.selRefs.has(r.id)))
    this.invalidate()
  }

  // A press on a note on its own: it moves alone, and a click without moving selects it.
  grabNote(e, id) {
    const n = this.notes?.get().find((x) => x.id === id)
    if (!n) return
    const [sx, sy] = this.pos(e)
    const [wx, wy] = this.toWorld(sx, sy)
    this.canvas.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, [sx, sy])
    this.carry = { pointer: e.pointerId, wx, wy, sx0: sx, sy0: sy, moved: false, note: id, refs: [], notes: [{ id, x: n.x, y: n.y }], trays: [] }
    this.canvas.style.cursor = 'grabbing'
  }

  carryAt(wx, wy, c = this.carry) {
    const dx = wx - c.wx
    const dy = wy - c.wy
    return {
      refs: c.refs.map((r) => ({ id: r.id, x: r.x + dx, y: r.y + dy })),
      notes: c.notes.map((n) => ({ id: n.id, x: n.x + dx, y: n.y + dy })),
      trays: c.trays.map((t) => ({ id: t.id, x: t.x + dx, y: t.y + dy })),
    }
  }

  // Each carried tray, where it is now.
  carriedTrays(list) {
    return list.map((p) => this.trays.find((t) => t.id === p.id)).filter(Boolean)
  }

  moveCarry(wx, wy) {
    const c = this.carry
    if (!c) return
    c.at = [wx, wy]
    const { refs, notes, trays } = this.carryAt(wx, wy)
    for (const p of refs) {
      const ref = this.refs.find((r) => r.id === p.id)
      if (ref) Object.assign(ref, p)
    }
    for (const p of trays) {
      const t = this.trays.find((x) => x.id === p.id)
      if (t) Object.assign(t, p)
    }
    if (notes.length) this.notes?.move(notes, null)
    this.sendCarry()
    this.invalidate()
  }

  sendCarry(force) {
    const now = performance.now()
    clearTimeout(this.carryTimer)
    const c = this.carry
    if (!c?.at) return
    if (force || now - (this.lastCarry || 0) >= LIVE_MS) {
      this.lastCarry = now
      const { refs, notes, trays } = this.carryAt(...c.at)
      for (const p of refs) {
        const ref = this.refs.find((r) => r.id === p.id)
        if (ref) this.onRef?.(ref, true)
      }
      for (const t of this.carriedTrays(trays)) this.onTray?.(t, true)
      if (notes.length) this.notes?.move(notes, 'live')
    } else {
      this.carryTimer = setTimeout(() => this.sendCarry(true), LIVE_MS - (now - this.lastCarry))
    }
  }

  endCarry() {
    const c = this.carry
    this.carry = null
    clearTimeout(this.carryTimer)
    if (!c) return
    // A click on a selected note without moving selects just that note.
    if (!c.moved && c.note) return this.notes?.click(c.note)
    if (!c.at) return
    const { refs, notes, trays } = this.carryAt(...c.at, c)
    for (const p of refs) {
      const ref = this.refs.find((r) => r.id === p.id)
      if (ref) this.onRef?.(ref, false)
    }
    for (const t of this.carriedTrays(trays)) this.onTray?.(t, false)
    if (notes.length) this.notes?.move(notes, 'save')
  }

  // Sprites are drawn in a worker when the browser can, and sent back as ImageBitmaps (which are
  // also quicker to draw). Otherwise, or if the worker fails, render() builds them here a slice of
  // a frame at a time. The worker is kept until destroy(), even when done: Chrome frees the bitmaps
  // it made when it ends. this.spriteWorker is set only while it is still sending sprites.
  startSprites() {
    this.buildAt = 0
    this.spriteWorker = null
    if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return
    let worker
    try {
      worker = new Worker(new URL('./sprites.worker.js', import.meta.url), { type: 'module' })
    } catch {
      return
    }
    this.spriteWorker = this.spriteHost = worker
    const stop = () => {
      if (this.spriteWorker === worker) this.spriteWorker = null
      this.invalidate()
    }
    worker.onmessage = ({ data }) => {
      if (this.spriteWorker !== worker) return
      if (data.kind === 'front') {
        for (const { i, lv } of data.items) this.setSprite(i, lv)
        this.invalidate()
      } else if (data.kind === 'done') {
        stop()
      } else stop()
    }
    worker.onerror = stop
    createImageBitmap(this.image)
      .then((image) => {
        if (this.spriteWorker !== worker) return
        const msg = { room: this.room, image, margin: this.margin, sc: this.spriteScale }
        worker.postMessage(msg, [image])
      })
      .catch(stop)
  }

  // Main thread fallback: builds sprites until the deadline.
  buildSome(until) {
    while (this.buildAt < this.n && performance.now() < until) {
      const i = this.buildAt++
      if (this.sprites[i]) continue
      this.setSprite(i, levels(this.makeSprite(i), makeCanvas))
    }
  }

  spriteOpts() {
    return { geo: this.geo, room: this.room, image: this.image, margin: this.margin, sc: this.spriteScale }
  }

  makeSprite(i) {
    const c = makeCanvas(...spriteSize(this.geo, this.margin, this.spriteScale))
    drawFront(c.getContext('2d'), this.spriteOpts(), this.geo.pieces[i], this.paths[i])
    return c
  }

  // What a point on the screen is over: an image (rh, or its resize handle), a tray (th) or a piece (i).
  // From the top: pieces in a tray, trays, the pieces lying on the table, images.
  pick(sx, sy) {
    let rh = this.refHit(sx, sy)
    const th = this.trayHit(sx, sy)
    if (rh && rh.mode === 'move' && th) rh = null
    const i = rh && rh.mode !== 'move' ? -1 : this.pieceAt(...this.toWorld(sx, sy), th)
    return { rh, th: rh ? null : th, i }
  }

  // The piece to act on at a point: a tray lies over the pieces on the table, so under one, only the
  // pieces in that tray count.
  pieceAt(wx, wy, th) {
    const i = this.hit(wx, wy)
    return i >= 0 && th && !th.tray.pieces.includes(i) ? -1 : i
  }

  hit(wx, wy) {
    const R = this.radius
    for (let k = this.order.length - 1; k >= 0; k--) {
      const i = this.order[k]
      const dx = wx - this.x[i]
      const dy = wy - this.y[i]
      if (dx > R || dx < -R || dy > R || dy < -R) continue
      const [rx, ly] = rot(dx, dy, -this.r[i])
      if (this.hitCtx.isPointInPath(this.paths[i], rx, ly)) return i
    }
    return -1
  }

  // ---- input --------------------------------------------------------------

  // Reading the canvas position on every pointer event would force a layout whenever the page
  // changed in between (the tooltip, the notes), so it is cached, see resize() and h.moved.
  pos(e) {
    const r = this.rect
    return [e.clientX - r.left, e.clientY - r.top]
  }

  onDown(e) {
    // A page selection (from Cmd+A in the browser, say) has no business on the table.
    if (!window.getSelection()?.isCollapsed) window.getSelection().removeAllRanges()
    const [sx, sy] = this.pos(e)
    this.canvas.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, [sx, sy])
    this.inPress = true
    if (e.pointerType === 'touch') this.touches.add(e.pointerId)
    else this.touches.delete(e.pointerId)
    this.camAnim = null

    if (this.drag) {
      if (e.pointerType === 'touch' && e.pointerId !== this.drag.pointer) this.spin(1)
      return
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      this.pan = null
      this.marquee = null
      this.refDrag = null
      this.refShift = null
      this.refFade = null
      this.trayShift = null
      this.endTrim()
      this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }
      this.invalidate()
      return
    }
    // Trimming an image: a drag over it picks the part to keep, a press anywhere else stops.
    if (this.trim) {
      const ref = this.refs.find((r) => r.id === this.trim.id)
      const [x0, y0, x1, y1] = ref ? this.refRect(ref) : [0, 0, -1, -1]
      if (e.button === 0 && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) {
        this.trim.box = { pointer: e.pointerId, sx0: sx, sy0: sy, sx, sy }
        return
      }
      this.endTrim()
    }
    // A tray's buttons: its auto sort switch, and its menu, opened below the button.
    if (e.button === 0 && !this.panMode) {
      const b = this.trayButtonAt(sx, sy)
      if (b?.kind === 'auto') return this.setTrayAuto(b.tray.id, !b.tray.auto)
      if (b) {
        const [x0, , , y1] = this.trayButtons(b.tray).menu
        return this.openMenu({ kind: 'tray', id: b.tray.id, sx: x0, sy: y1 + 4 })
      }
      // An image's menu button, the same way.
      const ref = this.refButtonAt(sx, sy)
      if (ref) {
        const [x0, , , y1] = this.refButton(ref)
        return this.openMenu({ kind: 'ref', id: ref.id, sx: x0, sy: y1 + 4 })
      }
    }
    // Right (or middle) button drags the table, as does any press in view mode.
    if (e.button === 1 || e.button === 2 || (this.panMode && e.button === 0)) {
      let menu = null
      if (e.button === 2) {
        const { rh, th, i: at } = this.pick(sx, sy)
        // A finished jigsaw is left alone: no lifting, moving or turning it.
        const i = this.done ? -1 : at
        if (i >= 0) {
          if (!(this.held.get(i) > performance.now())) menu = { kind: 'piece', i }
        } else if (rh) menu = { kind: 'ref', id: rh.ref.id }
        else if (th) menu = { kind: 'tray', id: th.tray.id }
        if (menu) Object.assign(menu, { sx, sy })
      }
      this.startPan(e.pointerId, sx, sy)
      this.pan.menu = menu
      return
    }
    if (e.button !== 0) return

    const [wx, wy] = this.toWorld(sx, sy)
    const picked = this.pick(sx, sy)
    // Without a hover (touch), pressing a tray or image shows its buttons.
    this.setHovered(this.hoverKey(picked))
    const { rh, th } = picked
    const i = this.done ? -1 : picked.i
    // Shift drag on a tray moves the tray, even from a piece in it, once the pointer moves; a shift
    // click on a piece in it still adds it to the selection or takes it out.
    if (th && e.shiftKey) {
      if (i < 0) return this.startTrayDrag(th, e.pointerId, sx, sy, wx, wy)
      if (this.guard && !this.guard()) return
      this.trayShift = { th, i, pointer: e.pointerId, sx0: sx, sy0: sy, wx, wy }
      return
    }
    if (i >= 0) {
      if (this.held.get(i) > performance.now()) return
      if (this.guard && !this.guard()) return
      this.selectRef(null)
      this.selectTray(null)
      if (e.shiftKey) return this.toggleGroup(i)
      if (this.sel.has(i)) this.grabSelection(e, { piece: true })
      else {
        if (this.selCount) this.setSelection(new Set())
        this.startDrag(this.members(this.g[i]), wx, wy, e.pointerId, sx, sy)
      }
      // Remembered so a click (no drag) can select what was clicked.
      if (this.drag) this.drag.piece = i
      return
    }
    // Alt drag on an image: sideways changes its opacity, fainter to the left.
    if (rh?.mode === 'move' && e.altKey) {
      e.preventDefault()
      if (this.guard && !this.guard()) return
      this.selectRef(rh.ref.id)
      this.refFade = { ref: rh.ref, pointer: e.pointerId, sx0: sx, op0: rh.ref.opacity ?? 1, moved: false }
      this.canvas.style.cursor = 'ew-resize'
      return
    }
    // Shift on an image: a click adds it to the selection or takes it out, a drag resizes it from the
    // corner nearest the pointer.
    if (rh?.mode === 'move' && e.shiftKey) {
      if (this.guard && !this.guard()) return
      const [x0, y0, x1, y1] = this.refRect(rh.ref)
      const cx = sx > (x0 + x1) / 2 ? 1 : 0
      const cy = sy > (y0 + y1) / 2 ? 1 : 0
      this.refShift = { rh: { ref: rh.ref, mode: 'resize', cx, cy }, pointer: e.pointerId, sx0: sx, sy0: sy }
      return
    }
    if (rh?.mode === 'move' && this.selRefs.has(rh.ref.id) && this.selCount > 1) {
      if (this.guard && !this.guard()) return
      this.selectRef(null)
      return this.grabSelection(e)
    }
    if (rh) return this.startRefDrag(rh, e.pointerId, wx, wy)
    if (th) return this.startTrayDrag(th, e.pointerId, sx, sy, wx, wy)
    this.selectTray(null)
    if (e.pointerType === 'touch') return this.startPan(e.pointerId, sx, sy)

    // Left drag on the empty table draws a selection box; shift adds to the selection.
    this.selectRef(null)
    const keep = e.shiftKey
    this.marquee = {
      pointer: e.pointerId,
      sx0: sx,
      sy0: sy,
      sx,
      sy,
      base: keep ? new Set(this.sel) : new Set(),
      baseRefs: keep ? new Set(this.selRefs) : new Set(),
      baseNotes: keep ? new Set(this.selNotes) : new Set(),
    }
    if (!keep && this.selCount) this.setSelection(new Set())
  }

  // Shift-click on a piece: its group goes in or out of the selection.
  toggleGroup(i) {
    this.selectRef(null)
    this.selectTray(null)
    const next = new Set(this.sel)
    const on = !next.has(i)
    for (const j of this.members(this.g[i])) on ? next.add(j) : next.delete(j)
    this.setSelection(next, this.selRefs, this.selNotes)
  }

  startPan(pointer, sx, sy) {
    this.pan = { pointer, sx, sy }
    this.canvas.style.cursor = 'grabbing'
    this.showTip(null)
    this.setHighlight(null)
  }

  // A right click on a piece, image or tray (m.kind): selects it, as a click would, and asks for the menu.
  openMenu(m) {
    if (!this.onMenu) return
    this.selectRef(null)
    this.selectTray(null)
    if (m.kind === 'piece') {
      if (!this.sel.has(m.i)) this.setSelection(new Set(this.members(this.g[m.i])))
    } else {
      this.setSelection(new Set(), new Set(), new Set(m.kind === 'note' ? [m.id] : []))
      if (m.kind === 'ref') this.selectRef(m.id)
      if (m.kind === 'tray') this.selectTray(m.id)
    }
    this.onMenu(m.sx, m.sy, m.kind, m.id)
  }

  // The same for a note, which is not part of the canvas: at a window position.
  openNoteMenu(id, x, y) {
    const r = this.canvas.getBoundingClientRect()
    this.openMenu({ kind: 'note', id, sx: x - r.left, sy: y - r.top })
  }

  onMove(e) {
    const [sx, sy] = this.pos(e)
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, [sx, sy])
    // Pressing the right button while holding pieces turns them, like space. A second button on a
    // pointer that is already down arrives as a move with e.button set, not as a pointerdown.
    if (this.drag && e.pointerId === this.drag.pointer && e.button === 2 && e.buttons & 2) this.spin(1, e.shiftKey)

    // A shift press on a piece in a tray that starts moving picks up the tray, from where the press was.
    const ts = this.trayShift
    if (ts && e.pointerId === ts.pointer) {
      if (Math.hypot(sx - ts.sx0, sy - ts.sy0) <= CLICK_PX) return
      this.trayShift = null
      if (this.trays.includes(ts.th.tray)) this.startTrayDrag(ts.th, ts.pointer, ts.sx0, ts.sy0, ts.wx, ts.wy)
    }
    const c = this.carry
    if (c && e.pointerId === c.pointer) {
      if (Math.hypot(sx - c.sx0, sy - c.sy0) > CLICK_PX) c.moved = true
      // A tray starts moving: pick up its pieces, from where the press was, so they keep their place.
      if (c.moved && c.lift) {
        const l = c.lift
        c.lift = null
        if (l.ids.length) {
          this.startDrag(l.ids, l.wx, l.wy, c.pointer, l.sx, l.sy, true)
          // Not a click, so no piece gets turned over or selected.
          this.drag.moved = true
          // Lifted as if from the tray's middle: growing around the pointer would push the pieces
          // far from it out over the tray's edge.
          const t = this.trays.find((x) => x.id === c.trays[0].id)
          if (t) {
            this.lift.cx = c.trays[0].x + t.w / 2 - l.wx
            this.lift.cy = c.trays[0].y + t.h / 2 - l.wy
          }
        }
      }
      if (!this.drag) {
        if (c.moved) this.moveCarry(...this.toWorld(sx, sy))
        return
      }
    }
    if (this.drag && e.pointerId === this.drag.pointer) {
      const d = this.drag
      d.sx = sx
      d.sy = sy
      if (Math.hypot(sx - d.sx0, sy - d.sy0) > CLICK_PX) d.moved = true
      this.updatePivot()
      this.sendLive()
      this.invalidate()
      return
    }
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      const d = Math.hypot(a[0] - b[0], a[1] - b[1])
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      this.cam.x -= (m[0] - this.pinch.m[0]) / this.cam.z
      this.cam.y -= (m[1] - this.pinch.m[1]) / this.cam.z
      this.zoomAt(m[0], m[1], d / this.pinch.d)
      this.pinch = { d, m }
      return
    }
    if (this.pan && e.pointerId === this.pan.pointer) {
      this.cam.x -= (sx - this.pan.sx) / this.cam.z
      this.cam.y -= (sy - this.pan.sy) / this.cam.z
      this.pan.sx = sx
      this.pan.sy = sy
      const m = this.pan.menu
      if (m && Math.hypot(sx - m.sx, sy - m.sy) > CLICK_PX) this.pan.menu = null
      this.clampCam()
      this.invalidate()
      return
    }
    const tb = this.trim?.box
    if (tb && e.pointerId === tb.pointer) {
      tb.sx = sx
      tb.sy = sy
      this.invalidate()
      return
    }
    if (this.marquee && e.pointerId === this.marquee.pointer) {
      this.marquee.sx = sx
      this.marquee.sy = sy
      this.updateMarquee()
      return
    }
    const rf = this.refFade
    if (rf && e.pointerId === rf.pointer) {
      rf.moved = true
      this.setRefOpacity(rf.ref.id, rf.op0 + (sx - rf.sx0) / REF_FADE_PX, true)
      return
    }
    const rs = this.refShift
    if (rs && e.pointerId === rs.pointer) {
      if (Math.hypot(sx - rs.sx0, sy - rs.sy0) <= CLICK_PX) return
      this.refShift = null
      this.startRefDrag(rs.rh, rs.pointer, ...this.toWorld(sx, sy))
      // The corner keeps its distance from the pointer, rather than jumping to it.
      const d = this.refDrag
      if (d) {
        const [w, h] = this.refSize(d.ref)
        const [px, py] = this.toWorld(rs.sx0, rs.sy0)
        d.ox = d.ref.x + (d.sx * w) / 2 - px
        d.oy = d.ref.y + (d.sy * h) / 2 - py
      }
    }
    if (this.refDrag && e.pointerId === this.refDrag.pointer) {
      this.moveRef(...this.toWorld(sx, sy))
      return
    }
    if (e.pointerType === 'mouse' && !e.buttons) {
      this.shift = e.shiftKey
      this.hover(sx, sy)
    }
  }

  onUp(e) {
    this.pointers.delete(e.pointerId)
    this.touches.delete(e.pointerId)
    if (this.drag && e.pointerId === this.drag.pointer) {
      const d = this.drag
      this.drop()
      // Clicking a piece without dragging selects it (its whole module), and only it.
      if (!d.moved && d.piece !== undefined) this.setSelection(new Set(this.members(this.g[d.piece])))
    }
    if (this.carry && e.pointerId === this.carry.pointer) this.endCarry()
    if (this.trayShift && e.pointerId === this.trayShift.pointer) {
      const { i } = this.trayShift
      this.trayShift = null
      this.toggleGroup(i)
    }
    if (this.pan && e.pointerId === this.pan.pointer) {
      const m = this.pan.menu
      this.pan = null
      this.canvas.style.cursor = this.panMode ? 'grab' : ''
      if (m && !this.drag) this.openMenu(m)
    }
    if (this.marquee && e.pointerId === this.marquee.pointer) {
      this.marquee = null
      this.sendCursor(true)
      this.invalidate()
    }
    if (this.trim?.box && e.pointerId === this.trim.box.pointer) this.applyTrim()
    if (this.refFade && e.pointerId === this.refFade.pointer) {
      const { ref, moved } = this.refFade
      this.refFade = null
      if (moved) this.setRefOpacity(ref.id, ref.opacity)
    }
    if (this.refShift && e.pointerId === this.refShift.pointer) {
      const { ref } = this.refShift.rh
      this.refShift = null
      if (this.refs.includes(ref)) this.toggleRef(ref.id)
    }
    if (this.refDrag && e.pointerId === this.refDrag.pointer) {
      const { ref } = this.refDrag
      this.refDrag = null
      clearTimeout(this.refTimer)
      this.onRef?.(ref, false)
    }
    if (this.pointers.size < 2) this.pinch = null
    // Letting go: the cursor shows what is under it again.
    if (!this.pointers.size && e.pointerType === 'mouse') this.hover(...this.pos(e))
    // The next press is a new gesture, for undo.
    if (!this.pointers.size) {
      this.inPress = false
      this.pressId++
    }
  }

  // Selects every group with a piece centre inside the box.
  updateMarquee() {
    const m = this.marquee
    const [ax, ay] = this.toWorld(Math.min(m.sx0, m.sx), Math.min(m.sy0, m.sy))
    const [bx, by] = this.toWorld(Math.max(m.sx0, m.sx), Math.max(m.sy0, m.sy))
    const hit = []
    for (let i = 0; i < this.n; i++) {
      const x = this.x[i]
      const y = this.y[i]
      if (x >= ax && x <= bx && y >= ay && y <= by) hit.push(i)
    }
    const next = this.withGroups(hit)
    for (const i of m.base) next.add(i)
    // Images and notes count when their centre is inside the box, like pieces.
    const inside = (x, y) => x >= ax && x <= bx && y >= ay && y <= by
    const refs = new Set(m.baseRefs)
    for (const r of this.refs) if (inside(r.x, r.y)) refs.add(r.id)
    const notes = new Set(m.baseNotes)
    for (const n of this.notes?.get() || []) if (inside(n.x + n.w / 2, n.y + n.h / 2)) notes.add(n.id)
    // Most moves change nothing but the box itself, which is cheap to draw.
    const same = (a, b) => a.size === b.size && [...a].every((v) => b.has(v))
    if (same(next, this.sel) && same(refs, this.selRefs) && same(notes, this.selNotes)) return this.invalidate()
    this.setSelection(next, refs, notes)
  }

  onWheel(e) {
    e.preventDefault()
    this.camAnim = null
    const [sx, sy] = this.pos(e)
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    const dy = Math.max(-200, Math.min(200, e.deltaY * unit))
    this.zoomAt(sx, sy, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)))
    if (this.drag) this.updatePivot()
  }

  onKey(e) {
    if (this.spectator) return
    if (e.target?.closest?.('input, textarea, [contenteditable]')) return
    // Dialogs over the board keep the keyboard.
    if (document.querySelector('.modal-bg')) return
    if (e.key === 'Escape' && this.trim) return this.endTrim()
    if (e.key === 'Escape' && !this.drag) {
      if (this.selCount) this.setSelection(new Set())
      this.selectRef(null)
      this.selectTray(null)
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !this.refDrag && !this.drag && !this.carry) {
      if (!this.refSel && !this.traySel && !this.selRefs.size && !this.selNotes.size) return
      e.preventDefault()
      return this.removeSelected()
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    // Cmd/Ctrl+A selects everything on the table, rather than the page's text.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && key === 'a' && !this.drag) {
      e.preventDefault()
      return this.selectAll()
    }
    // Cmd/Ctrl+Z undoes, with shift (or Ctrl+Y) redoes.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (key === 'z' || key === 'y') && !this.drag) {
      e.preventDefault()
      return key === 'y' || e.shiftKey ? this.redo() : this.undo()
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // Arrow keys and WASD move around the table while held, also while carrying pieces.
    if (PAN_KEYS[key]) {
      e.preventDefault()
      this.camAnim = null
      this.panKeys.add(key)
      this.invalidate()
      return
    }
    // While holding pieces: space turns them, G gathers the carried groups.
    if (this.drag) {
      if (key !== ' ' && key !== 'g') return
      e.preventDefault()
      if (e.repeat) return
      return key === ' ' ? this.spin(1, e.shiftKey) : this.gather(e.shiftKey)
    }
    // A number with pieces selected sends them to the tray with that number.
    if (/^[1-9]$/.test(key) && this.sel.size) {
      e.preventDefault()
      if (!e.repeat) this.sendToTray(+key)
      return
    }
    // With a selection on the table (or a tray selected), space turns the pieces where they lie
    // (shift: all as one) and G sorts them into a grid (shift: in random order).
    if ((key === ' ' || key === 'g') && (this.sel.size || this.traySel)) {
      e.preventDefault()
      if (!e.repeat) key === 'g' ? this.sortSelection(e.shiftKey) : this.rotateSelection(1, e.shiftKey)
    }
  }

  // Groups only form through grid neighbours, so a piece is connected iff a neighbour shares its
  // group. The other cells of a long piece don't count: they came that way.
  connected(i) {
    const { cols, rows } = this.room
    const c = i % cols
    const g = this.g[i]
    const u = this.unit
    const joined = (q) => this.g[q] === g && (!u || u[q] !== u[i])
    return (c > 0 && joined(i - 1)) || (c < cols - 1 && joined(i + 1)) || (i >= cols && joined(i - cols)) || (i < (rows - 1) * cols && joined(i + cols))
  }

  // Hovering a connected piece shows who connected it.
  hover(sx, sy) {
    if (this.trim) {
      this.canvas.style.cursor = 'crosshair'
      this.setHighlight(null)
      return this.showTip(this.trim.box ? null : { text: 'Drag over the image to pick the part to keep', sx, sy })
    }
    if (this.panMode) {
      this.canvas.style.cursor = 'grab'
      this.setHighlight(null)
      this.setHovered(null)
      return this.showTip(null)
    }
    const [wx, wy] = this.toWorld(sx, sy)
    let { rh, th, i } = this.pick(sx, sy)
    // With shift, a press on a tray takes the tray, not the piece under the pointer.
    if (this.shift && th) i = -1
    // The buttons stand out over the edge, so a tray or image stays hovered while over them.
    const b = this.trayButtonAt(sx, sy)
    const rb = !b && this.refButtonAt(sx, sy)
    if (!b && !rb) this.setHovered(this.hoverKey({ rh, th }))
    if (b) {
      this.canvas.style.cursor = 'pointer'
      this.setHighlight(null)
      if (b.kind === 'menu') return this.showTip(null)
      const text = b.tray.auto ? 'Auto sort is on: pieces put in this tray sort themselves' : 'Auto sort: sort the pieces put in this tray'
      return this.showTip({ text, sx, sy })
    }
    if (rb) {
      this.canvas.style.cursor = 'pointer'
      this.setHighlight(null)
      return this.showTip(null)
    }
    // A tray name that was cut short shows in full.
    const nm = [...(this.trayNames?.values() || [])].find((n) => sx >= n.rect[0] && sx <= n.rect[2] && sy >= n.rect[1] && sy <= n.rect[3])
    if (nm && (!th || i < 0)) {
      this.canvas.style.cursor = this.cursorFor(-1, null, th)
      this.setHighlight(null)
      return this.showTip({ text: nm.text, sx, sy })
    }
    // Shift over an image: a drag resizes it from the nearest corner, so the cursor says so.
    if (this.shift && i < 0 && rh?.mode === 'move') {
      const [x0, y0, x1, y1] = this.refRect(rh.ref)
      rh = { ref: rh.ref, mode: 'resize', cx: sx > (x0 + x1) / 2 ? 1 : 0, cy: sy > (y0 + y1) / 2 ? 1 : 0 }
    }
    this.canvas.style.cursor = this.cursorFor(this.done ? -1 : i, rh, th)
    let hl = null
    if (i >= 0 && this.by[i] && this.connected(i)) {
      const ids = this.cellsOf(i)
      hl = { key: `p:${ids[0]}`, ids, text: this.nameOf(this.by[i]) }
    }
    this.setHighlight(hl)
    // Hovering a reference image (not covered by a piece) shows who put it there.
    const text = hl ? hl.text : i < 0 && rh?.ref.author ? this.nameOf(rh.ref.author) : null
    this.showTip(text ? { text, sx, sy } : null)
  }

  // The pointer over a piece (i), an image's handles (rh) or a tray's name strip (th).
  // Shift pressed or let go: the cursor over an image changes with it, if nothing is being held.
  setShift(e) {
    if (e.key !== 'Shift' || this.shift === e.shiftKey) return
    this.shift = e.shiftKey
    if (!this.pointers.size && this.pointerAt && this.canvas.matches(':hover')) this.hover(...this.pointerAt)
  }

  // An open hand over anything that can be dragged, like on notes; it closes while dragging.
  cursorFor(i, rh, th) {
    if (rh?.mode === 'resize') return rh.cx === rh.cy ? 'nwse-resize' : 'nesw-resize'
    return i >= 0 || th || rh ? 'grab' : ''
  }

  setHighlight(hl) {
    if (hl?.key === this.hl?.key) return
    this.hl = hl
    this.sendMarks()
    this.invalidate()
  }

  showTip(t) {
    const el = this.tooltip
    if (!el) return
    if (!t) {
      el.style.opacity = '0'
      return
    }
    if (el.textContent !== t.text) el.textContent = t.text
    el.style.transform = `translate(${Math.round(t.sx + 14)}px, ${Math.round(t.sy + 16)}px)`
    el.style.opacity = '1'
  }

  // ---- dragging -----------------------------------------------------------

  // tray: the pieces are riding along with a moved tray, so they aren't outlined as carried.
  startDrag(ids, wx, wy, pointer, sx, sy, tray = false) {
    if (!ids.length) return
    const set = new Set(ids)
    this.toTop(set)
    this.drag = {
      ids,
      set,
      pointer,
      tray,
      touch: this.touches.has(pointer),
      sx,
      sy,
      px: wx,
      py: wy,
      ox: ids.map((j) => this.x[j] - wx),
      oy: ids.map((j) => this.y[j] - wy),
      r0: ids.map((j) => this.r[j]),
      k: 0,
      angle: 0,
      // Per piece: the centre of its module and the part of a spin still animating (radians).
      cx: new Float64Array(ids.length),
      cy: new Float64Array(ids.length),
      sa: new Float64Array(ids.length),
      // Per piece: the part of a gather (G) still animating, as an offset in world units.
      tx: new Float64Array(ids.length),
      ty: new Float64Array(ids.length),
      spinning: false,
      // A press that neither moves nor turns anything is a click.
      sx0: sx,
      sy0: sy,
      moved: false,
    }
    for (const i of ids) {
      this.turns.delete(i)
      this.moving.delete(i)
    }
    const keep = this.lift && this.lift.ids.length === ids.length && set.has(this.lift.ids[0])
    this.lift = { ids, set, value: keep ? this.lift.value : 0, target: 1, px: wx, py: wy, angle: 0 }
    this.canvas.style.cursor = 'grabbing'
    this.showTip(null)
    this.setHighlight(null)
    const d = this.drag
    this.send({ type: 'grab', ids, ox: d.ox.map(r2), oy: d.oy.map(r2), r0: d.r0, px: r2(wx), py: r2(wy), tray: tray || undefined })
    this.lastLive = performance.now()
    this.invalidate()
  }

  updatePivot() {
    const d = this.drag
    // A finger holds the pieces above itself, easing up as they lift.
    const up = d.touch && this.lift ? (TOUCH_LIFT * this.lift.value) : 0
    const [wx, wy] = this.toWorld(d.sx, d.sy - up)
    const { x0, y0, x1, y1 } = this.bounds
    d.px = Math.min(x1, Math.max(x0, wx))
    d.py = Math.min(y1, Math.max(y0, wy))
    this.lift.px = d.px
    this.lift.py = d.py
    this.moveCarry(d.px, d.py)
  }

  // Turns each carried module a quarter around its own centre, leaving the modules where they are.
  // With whole, everything carried turns together around its common centre instead.
  spin(dir, whole = false) {
    const d = this.drag
    if (!d) return
    const at = new Map(d.ids.map((i, j) => [i, j]))
    const sets = whole ? [d.ids.map((_, j) => j)] : this.modules(d.ids).map((m) => m.map((i) => at.get(i)))
    for (const js of sets) {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const j of js) {
        x0 = Math.min(x0, d.ox[j])
        y0 = Math.min(y0, d.oy[j])
        x1 = Math.max(x1, d.ox[j])
        y1 = Math.max(y1, d.oy[j])
      }
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      for (const j of js) {
        const [rx, ry] = rot(d.ox[j] - cx, d.oy[j] - cy, dir)
        d.ox[j] = cx + rx
        d.oy[j] = cy + ry
        ;[d.tx[j], d.ty[j]] = rot(d.tx[j], d.ty[j], dir)
        d.r0[j] = mod4(d.r0[j] + dir)
        d.cx[j] = cx
        d.cy[j] = cy
        d.sa[j] -= dir * Q
      }
    }
    d.spinning = true
    d.moved = true
    // Other players get the new offsets as a fresh grab that keeps the current turn.
    this.send({ type: 'grab', ids: d.ids, ox: d.ox.map(r2), oy: d.oy.map(r2), r0: d.r0, px: r2(d.px), py: r2(d.py), k: d.k })
    this.invalidate()
  }

  get packExtent() {
    return packExtent(this.geo)
  }

  // G while holding several groups: pulls them together in a grid around the pointer, none overlapping.
  // With shuffle (shift), the groups go in random order.
  gather(shuffle = false) {
    const d = this.drag
    if (!d) return
    const at = new Map(d.ids.map((i, j) => [i, j]))
    const mods = this.modules(d.ids).map((m) => m.map((i) => at.get(i)))
    if (mods.length < 2) return
    const e = this.packExtent
    const boxes = mods.map((js) => {
      const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      for (const j of js) {
        b.x0 = Math.min(b.x0, d.ox[j] - e)
        b.y0 = Math.min(b.y0, d.oy[j] - e)
        b.x1 = Math.max(b.x1, d.ox[j] + e)
        b.y1 = Math.max(b.y1, d.oy[j] + e)
      }
      return b
    })
    const spots = pack(boxes, this.geo.S, shuffle)
    mods.forEach((js, m) => {
      const b = boxes[m]
      const dx = spots[m][0] - (b.x0 + b.x1) / 2
      const dy = spots[m][1] - (b.y0 + b.y1) / 2
      for (const j of js) {
        d.ox[j] += dx
        d.oy[j] += dy
        d.cx[j] += dx
        d.cy[j] += dy
        d.tx[j] -= dx
        d.ty[j] -= dy
      }
    })
    d.spinning = true
    d.moved = true
    this.send({ type: 'grab', ids: d.ids, ox: d.ox.map(r2), oy: d.oy.map(r2), r0: d.r0, px: r2(d.px), py: r2(d.py), k: d.k })
    this.invalidate()
  }

  // Snaps each module on its own, then eases every piece the snap moved from where it was.
  snapModules(mods) {
    const x0 = this.x.slice()
    const y0 = this.y.slice()
    const g0 = this.g.slice()
    const changed = new Set()
    for (const m of mods) for (const j of this.snap(m)) changed.add(j)
    for (const i of changed) {
      if (this.x[i] === x0[i] && this.y[i] === y0[i]) continue
      this.moving.set(i, [this.x[i], this.y[i]])
      this.x[i] = x0[i]
      this.y[i] = y0[i]
    }
    this.joined(g0, changed, true)
    return changed
  }

  // After pieces moved (ids) and the groups were g0 before: finds every new seam, where two
  // neighbours that were apart are now in one group, and marks it with a burst and a sound.
  joined(g0, ids, local, who) {
    const { cols } = this.room
    const set = ids instanceof Set ? ids : new Set(ids)
    // Where a piece is going, if it's still easing there.
    const at = (i) => this.moving.get(i) || [this.x[i], this.y[i]]
    const seams = []
    for (const i of set) {
      const c = i % cols
      for (const q of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
        if (q < 0 || q >= this.n || this.g[q] !== this.g[i] || g0[q] === g0[i]) continue
        // Both moved: count the seam once.
        if (q < i && set.has(q)) continue
        const [x1, y1] = at(i)
        const [x2, y2] = at(q)
        seams.push([(x1 + x2) / 2, (y1 + y2) / 2])
      }
    }
    if (!seams.length) return
    this.onSnap?.({ seams: seams.length, local })
    if (who && this.spectator) {
      const at = seams.reduce((a, s) => [a[0] + s[0] / seams.length, a[1] + s[1] / seams.length], [0, 0])
      this.spectator.snapped({ client: who.client, trace: who.trace, ids: [...set], at, seams: seams.length })
    }
    if (calm?.matches) return
    // A long edge joining at once gets a few bursts spread along it, not one per seam.
    const step = Math.max(1, seams.length / MAX_POPS)
    const t0 = performance.now() + POP_DELAY
    for (let k = 0; k < seams.length; k += step) {
      const [x, y] = seams[Math.floor(k)]
      this.pops.push({ x, y, t0: t0 + (k / step) * 25, a: Math.random() * Math.PI })
    }
    this.invalidate()
  }

  // Space with a selection: turns each selected module a quarter around its centre, on the table.
  // With whole (shift), the selection turns as one around its common centre.
  rotateSelection(dir, whole = false) {
    if (this.guard && !this.guard()) return
    const ids = this.freeSelection()
    if (!ids.length) return
    this.settle(ids)
    const mods = this.modules(ids)
    const turned = []
    for (const m of whole ? [ids] : mods) {
      const b = this.bbox(m, 0)
      const cx = (b.x0 + b.x1) / 2
      const cy = (b.y0 + b.y1) / 2
      const t = { cx, cy, a: (this.turns.get(m[0])?.a || 0) - dir * Q }
      for (const i of m) {
        const [rx, ry] = rot(this.x[i] - cx, this.y[i] - cy, dir)
        this.x[i] = cx + rx
        this.y[i] = cy + ry
        this.r[i] = mod4(this.r[i] + dir)
        this.turns.set(i, t)
      }
      turned.push({ ids: m, cx: r2(cx), cy: r2(cy), d: dir })
    }
    // Pieces in a tray turn where they lie and don't snap to anything.
    const inTray = new Set(this.trays.flatMap((t) => t.pieces))
    const changed = this.snapModules(mods.filter((m) => !m.some((i) => inTray.has(i))))
    for (const i of ids) changed.add(i)
    this.fitTraysOf(ids)
    this.commit(changed, turned)
  }

  // Lays the selected modules out in a square grid, centred where the selection lies now.
  // With shuffle (shift), in random order rather than the order they lie in.
  sortSelection(shuffle = false, only = null) {
    if (this.guard && !this.guard()) return
    const ids = only || this.freeSelection(true)
    if (!ids.length) return
    this.settle(ids)
    const mods = this.modules(ids)
    const all = this.bbox(ids, 0)
    const cx = (all.x0 + all.x1) / 2
    const cy = (all.y0 + all.y1) / 2
    const boxes = mods.map((m) => this.bbox(m, this.packExtent))
    const spots = pack(boxes, this.geo.S, shuffle, !!only)
    const x0 = this.x.slice()
    const y0 = this.y.slice()
    mods.forEach((m, k) => {
      const b = boxes[k]
      const dx = cx + spots[k][0] - (b.x0 + b.x1) / 2
      const dy = cy + spots[k][1] - (b.y0 + b.y1) / 2
      for (const i of m) {
        this.x[i] += dx
        this.y[i] += dy
      }
    })
    const changed = this.snapModules(mods)
    // Ease everything from where it was, not just what the snap moved.
    for (const i of ids) {
      if (!this.moving.has(i)) this.moving.set(i, [this.x[i], this.y[i]])
      this.x[i] = x0[i]
      this.y[i] = y0[i]
    }
    this.toTop(new Set(ids))
    this.fitTraysOf(ids)
    this.commit(changed)
  }

  // Tells everyone where these pieces ended up (after a drop, turn or sort) and updates the rest.
  // turns: the spins around a point that got them there ({ ids, cx, cy, d }), so others can show them.
  commit(changed, turns, record = true) {
    this.growSelection()
    const items = this.track(changed)
    if (record && items.length) this.queue({ items })
    this.notifyHistory()
    this.send({
      type: 'moves',
      turns,
      pieces: [...changed].map((i) => {
        const [x, y] = this.moving.get(i) || [this.x[i], this.y[i]]
        return { i, x, y, r: this.r[i], g: this.g[i], by: this.by[i] }
      }),
    })
    this.emitStats()
    this.invalidate()
    this.checkComplete(true)
  }

  // Which tray each piece lies in now.
  trayMap() {
    const m = new Map()
    for (const t of this.trays) for (const i of t.pieces) m.set(i, t.id)
    return m
  }

  trackTrays() {
    this.shTray = this.trayMap()
  }

  // Compares the pieces with the snapshot and returns what changed, as { i, b, a } (before and after).
  // The snapshot catches up.
  track(changed) {
    const sh = this.sh
    const now = this.trayMap()
    const items = []
    for (const i of changed) {
      const [x, y] = this.moving.get(i) || [this.x[i], this.y[i]]
      const a = { x, y, r: this.r[i], g: this.g[i], by: this.by[i] || null, t: now.get(i) || null }
      const b = { x: sh.x[i], y: sh.y[i], r: sh.r[i], g: sh.g[i], by: sh.by[i] || null, t: this.shTray.get(i) || null }
      sh.x[i] = x
      sh.y[i] = y
      sh.r[i] = a.r
      sh.g[i] = a.g
      sh.by[i] = a.by
      if (a.t) this.shTray.set(i, a.t)
      else this.shTray.delete(i)
      if (!sameLook(a, b)) items.push({ i, a, b })
    }
    return items
  }

  notifyHistory() {
    this.onHistory?.({ undo: this.hist.undo.length > 0, redo: this.hist.redo.length > 0 })
  }

  // ---- history of images, trays, notes and the selection ----------------------

  // Remembers what an image, tray or note looked like (obj, or null once it is gone) as a change
  // of this player's, which undo can reverse. extra is merged into what it was before.
  trackObj(kind, id, obj, extra) {
    const sh = this.objSh[kind]
    const b = sh.get(id) || null
    const a = snapObj(obj)
    if (a) sh.set(id, a)
    else sh.delete(id)
    if (this.replaying || sameObj(a, b)) return
    this.queue({ objs: [{ kind, id, b: b && extra ? { ...b, ...extra } : b, a }] })
  }

  // The same, for a change someone else made: nothing to undo here, just keeps up.
  seen(kind, id, obj) {
    if (obj) this.objSh[kind].set(id, snapObj(obj))
    else this.objSh[kind].delete(id)
  }

  resetSeen(kind, list) {
    this.objSh[kind] = new Map(list.map((o) => [o.id, snapObj(o)]))
  }

  // Everything changed in one go (the same moment) is one step to undo.
  queue(part) {
    if (!this.pend) {
      this.pend = { items: [], objs: [], press: this.inPress ? this.pressId : null }
      queueMicrotask(() => this.flush())
    }
    if (part.items) this.pend.items.push(...part.items)
    if (part.objs) this.pend.objs.push(...part.objs)
  }

  flush() {
    const q = this.pend
    this.pend = null
    if (!q || (!q.items.length && !q.objs.length)) return
    const h = this.hist
    const now = performance.now()
    const top = h.undo[h.undo.length - 1]
    // Selecting what is then moved, in the same press, is part of that move.
    if (top?.sel && q.press !== null && top.press === q.press) h.undo.pop()
    else if (top && !top.sel && !q.items.length && q.objs.length === 1 && top.objs.length === 1 && !top.items.length && now - top.t < 10000) {
      // Typing in a note is one step, not one per pause.
      const o = q.objs[0]
      const t = top.objs[0]
      if (o.kind === 'note' && t.kind === 'note' && o.id === t.id && o.b && o.a && t.b && t.a) {
        t.a = o.a
        top.t = now
        h.redo.length = 0
        return this.notifyHistory()
      }
    }
    h.undo.push({ items: q.items, objs: q.objs, t: now })
    if (h.undo.length > HISTORY) h.undo.shift()
    h.redo.length = 0
    this.notifyHistory()
  }

  // Called from setSelection with what was selected before.
  recordSel(before) {
    const after = snapSel(this)
    if (sameSel(before, after)) return
    const h = this.hist
    const press = this.inPress ? this.pressId : null
    const top = h.undo[h.undo.length - 1]
    // Dragging out a box is one selection, not one per move.
    if (press !== null && top?.sel && top.press === press) {
      top.sel.a = after
      if (sameSel(top.sel.a, top.sel.b)) h.undo.pop()
    } else h.undo.push({ sel: { b: before, a: after }, press })
    if (h.undo.length > HISTORY) h.undo.shift()
    this.notifyHistory()
  }

  undo() {
    this.stepHistory(this.hist.undo, this.hist.redo, 'a', 'b')
  }

  redo() {
    this.stepHistory(this.hist.redo, this.hist.undo, 'b', 'a')
  }

  // Puts an image, tray or note into the state v (null: gone).
  applyObj(kind, id, v) {
    if (kind === 'note') {
      if (!this.notes) return
      if (v) this.notes.put(v)
      else this.notes.remove([id])
      this.seen('note', id, v)
      return
    }
    const list = kind === 'ref' ? this.refs : this.trays
    const cur = list.find((o) => o.id === id)
    if (!v) return cur && (kind === 'ref' ? this.removeRef(id) : this.removeTray(id))
    if (kind === 'ref') {
      if (cur) Object.assign(cur, v)
      else this.refs.push({ ...v })
      this.onRef(cur || this.refs[this.refs.length - 1], false)
      return
    }
    const { pieces, ...rest } = v
    if (cur) {
      Object.assign(cur, rest)
      this.onTray(cur, false)
      return
    }
    // A tray that was removed comes back with its pieces (those not in another tray by now), and its
    // number if that is still free.
    const taken = new Set(this.trays.flatMap((t) => t.pieces))
    const t = { ...rest, pieces: (pieces || []).filter((i) => !taken.has(i)) }
    if (t.num && this.trays.some((x) => x.num === t.num)) {
      const used = new Set(this.trays.map((x) => x.num))
      t.num = 0
      for (let n = 1; n <= 9 && !t.num; n++) if (!used.has(n)) t.num = n
    }
    this.trays.push(t)
    if (t.pieces.length) this.fitTray(t)
    this.onTray(t, false)
  }

  // Takes the latest entry off one stack and puts it back, onto the other. Pieces, images, trays
  // and notes someone else has changed since, or pieces they are holding now, stay as they are. An
  // entry with nothing left to restore is dropped, and the next one is tried.
  stepHistory(from, to, expect, set) {
    if (this.drag || !from.length) return
    if (this.guard && !this.guard()) return
    const sh = this.sh
    const now = performance.now()
    while (from.length) {
      const e = from.pop()
      if (e.sel) {
        // Skip a selection that is the one we have anyway, so a press always does something.
        const v = e.sel[set]
        if (sameSel(v, snapSel(this))) continue
        this.noSelHistory = true
        this.selectRef(null)
        this.selectTray(null)
        this.setSelection(new Set(v.p), new Set([...v.r].filter((id) => this.refs.some((r) => r.id === id))), new Set(v.n))
        this.noSelHistory = false
        to.push(e)
        return this.notifyHistory()
      }
      const objs = e.objs.filter((o) => sameObj(this.objSh[o.kind].get(o.id) || null, o[expect]))
      const items = e.items.filter((it) => {
        const w = it[expect]
        return (
          !(this.held.get(it.i) > now) &&
          sameLook({ x: sh.x[it.i], y: sh.y[it.i], r: sh.r[it.i], g: sh.g[it.i], by: sh.by[it.i] || null, t: this.shTray.get(it.i) || null }, w)
        )
      })
      if (!items.length && !objs.length) continue
      this.replaying = true
      for (const o of objs) this.applyObj(o.kind, o.id, o[set])
      const ids = items.map((it) => it.i)
      this.settle(ids)
      const touched = new Set()
      for (const { i, [set]: v } of items) {
        if (Math.hypot(v.x - this.x[i], v.y - this.y[i]) > 1e-6) this.moving.set(i, [v.x, v.y])
        const d = ((v.r - this.r[i] + 5) % 4) - 1
        if (d) this.turns.set(i, { self: true, a: -d * Q })
        this.r[i] = v.r
        this.g[i] = v.g
        this.by[i] = v.by
        const cur = this.shTray.get(i) || null
        if (cur !== v.t) {
          for (const t of this.trays) {
            const k = t.pieces.indexOf(i)
            if (k >= 0) {
              t.pieces.splice(k, 1)
              touched.add(t)
            }
          }
          const t = v.t && this.trays.find((x) => x.id === v.t)
          if (t) {
            t.pieces.push(i)
            touched.add(t)
          }
        }
      }
      if (ids.length) this.toTop(new Set(ids))
      this.refitTrays(touched)
      this.trackTrays()
      this.replaying = false
      to.push({ items, objs, t: now })
      if (ids.length) {
        this.noSelHistory = true
        this.setSelection(new Set(ids))
        this.noSelHistory = false
        this.commit(new Set(ids), undefined, false)
      } else {
        this.invalidate()
        this.notifyHistory()
      }
      return
    }
    this.notifyHistory()
  }

  // The moment the last piece goes in, by anyone: tell the page and bring the whole jigsaw into view.
  // local: this player's own move finished it, so this player tidies up (see finish()).
  checkComplete(local = false) {
    const done = this.isComplete()
    const was = this.done
    this.done = done
    if (done && !was) {
      this.onComplete?.()
      if (local) this.finish()
      setTimeout(() => this.fit(), 900)
    }
  }

  // The jigsaw is done: it turns the right way up, and the trays, images and notes are cleared away.
  finish() {
    if (this.drag) return
    const ids = Array.from({ length: this.n }, (_, i) => i)
    this.settle(ids)
    const k = (4 - this.r[0]) % 4
    if (k) {
      const b = this.bbox(ids, 0)
      const cx = (b.x0 + b.x1) / 2
      const cy = (b.y0 + b.y1) / 2
      // A quarter turn either way, or half a turn.
      const dir = k === 3 ? -1 : 1
      const t = { cx, cy, a: -(k === 2 ? 2 : dir) * Q }
      for (const i of ids) {
        const [rx, ry] = rot(this.x[i] - cx, this.y[i] - cy, k)
        this.x[i] = cx + rx
        this.y[i] = cy + ry
        this.r[i] = 0
        this.turns.set(i, t)
      }
      this.commit(ids, [{ ids, cx: r2(cx), cy: r2(cy), d: dir }])
    }
    for (const t of [...this.trays]) this.removeTray(t.id)
    for (const r of [...this.refs]) this.removeRef(r.id)
    const notes = this.notes?.get().map((n) => n.id) || []
    if (notes.length) {
      this.notes.remove(notes)
      for (const id of notes) this.trackObj('note', id, null)
    }
    this.setSelection(new Set())
    this.selectRef(null)
    this.selectTray(null)
  }

  dragState() {
    const d = this.drag
    return d.ids.map((i, j) => {
      const [ox, oy] = rot(d.ox[j], d.oy[j], d.k)
      return { i, x: d.px + ox, y: d.py + oy, r: mod4(d.r0[j] + d.k), g: this.g[i] }
    })
  }

  // The colour each image, tray or note is outlined in because another player has it selected.
  markedBy(key) {
    const out = new Map()
    for (const [c, m] of this.marks) {
      const color = this.colorOf(c)
      const ids = key === 'tray' ? [m.tray] : m[key]
      for (const id of ids) if (id && !out.has(id)) out.set(id, color)
    }
    return out
  }

  markNotes() {
    this.notes?.mark(this.markedBy('notes'))
  }

  // Pulls whole groups into the selection after pieces joined, telling others if it grew.
  growSelection() {
    if (!this.sel.size) return
    const n = this.sel.size
    this.sel = this.withGroups(this.sel)
    if (this.sel.size !== n) this.sendMarks()
  }

  // Tells the others what we have selected and hover over, so they can outline it in our colour.
  sendMarks(force) {
    const now = performance.now()
    clearTimeout(this.marksTimer)
    if (force || now - this.lastMarks >= MARKS_MS) {
      this.lastMarks = now
      const hl = this.hl && !this.drag ? this.hl.ids : []
      const refs = new Set(this.selRefs)
      if (this.refSel) refs.add(this.refSel)
      this.send({ type: 'marks', sel: [...this.sel], hl, refs: [...refs], notes: [...this.selNotes], tray: this.traySel, player: this.user || '' })
    } else {
      this.marksTimer = setTimeout(() => this.sendMarks(true), MARKS_MS - (now - this.lastMarks))
    }
  }

  // Not playing (a dialog is open): others see no cursor from us until we're back.
  setAway(away) {
    if (this.away === away) return
    this.away = away
    if (away) {
      clearTimeout(this.cursorTimer)
      this.send({ type: 'cursor', hide: true })
    } else this.sendCursor(true)
  }

  sendCursor(force) {
    const now = performance.now()
    clearTimeout(this.cursorTimer)
    if (!this.pointerAt || this.away) return
    if (force || now - this.lastCursor >= CURSOR_MS) {
      this.lastCursor = now
      const [x, y] = this.toWorld(...this.pointerAt)
      // While dragging out a selection box, its corners go along (in world units).
      const m = this.marquee
      const box = m && Math.abs(m.sx - m.sx0) + Math.abs(m.sy - m.sy0) > 2 ? [...this.toWorld(m.sx0, m.sy0), ...this.toWorld(m.sx, m.sy)].map(r2) : undefined
      this.send({ type: 'cursor', x: r2(x), y: r2(y), name: this.userName || '', player: this.user || '', box })
    } else {
      this.cursorTimer = setTimeout(() => this.sendCursor(true), CURSOR_MS - (now - this.lastCursor))
    }
  }

  // While dragging only the pivot and rotation go over the wire; the offsets were sent with "grab".
  sendLive(force) {
    const now = performance.now()
    clearTimeout(this.liveTimer)
    if (!this.drag) return
    if (force || now - this.lastLive >= LIVE_MS) {
      this.lastLive = now
      const d = this.drag
      this.send({ type: 'live', px: r2(d.px), py: r2(d.py), k: d.k })
    } else {
      this.liveTimer = setTimeout(() => this.sendLive(true), LIVE_MS - (now - this.lastLive))
    }
  }

  drop() {
    clearTimeout(this.liveTimer)
    const d = this.drag
    const state = this.dragState()
    for (const p of state) {
      this.x[p.i] = p.x
      this.y[p.i] = p.y
      this.r[p.i] = p.r
    }
    this.drag = null

    // Each carried group snaps on its own, so unrelated groups in a selection never merge by accident.
    const g0 = this.g.slice()
    const changed = new Set()
    const trayOf = this.trayMap()
    const carried = new Set(d.ids)
    const onto = []
    for (const grp of this.modules(d.ids)) {
      const out = {}
      for (const j of this.snap(grp, out)) changed.add(j)
      if (out.onto !== undefined && !carried.has(out.onto)) onto.push(out.onto)
    }
    this.joined(g0, changed, true)

    // The landing shrinks the pieces back around the pointer, moved along with them if everything
    // moved by the same snap offset.
    const l = this.lift
    const sdx = this.x[state[0].i] - state[0].x
    const sdy = this.y[state[0].i] - state[0].y
    const rigid = state.every((p) => Math.abs(this.x[p.i] - p.x - sdx) + Math.abs(this.y[p.i] - p.y - sdy) < 1e-6)
    if (rigid) {
      l.px = d.px + sdx
      l.py = d.py + sdy
      l.angle = d.k * Q
    }
    l.target = 0

    this.canvas.style.cursor = ''
    // Pieces carried along with their tray stay in it, wherever it's let go.
    const tray = this.carry?.trays[0] && this.trays.find((t) => t.id === this.carry.trays[0].id)
    if (tray) {
      this.placeInTrays(d.ids, d.px, d.py, tray)
      this.commit(changed)
      // Moving a whole tray doesn't sort it again.
      return
    }
    // Each group the carried pieces are in now goes in the tray its pieces that weren't carried were
    // in (those it snapped onto first), or in none. All carried, it goes by the tray under the pointer.
    const anchor = new Map()
    for (const q of onto) if (!anchor.has(this.g[q])) anchor.set(this.g[q], q)
    for (const i of changed) if (!carried.has(i) && !anchor.has(this.g[i])) anchor.set(this.g[i], i)
    const loose = []
    const changes = []
    for (const grp of this.modules(d.ids)) {
      const a = anchor.get(this.g[grp[0]])
      if (a === undefined) loose.push(...grp)
      else changes.push(this.placeInTrays(grp, d.px, d.py, this.trays.find((t) => t.id === trayOf.get(a)) || null))
    }
    if (loose.length) changes.push(this.placeInTrays(loose, d.px, d.py))
    this.commit(changed)
    for (const c of changes) this.autoSort(c)
  }

  // With out given, out.onto is set to the piece the group snapped onto, if any.
  snap(ids, out) {
    const { cols, rows } = this.room
    const { w, h, S } = this.geo
    const thr = S * 0.22
    const group = new Set(ids)
    const changed = new Set(ids)
    const nbrs = (i) => {
      const c = i % cols
      const r = (i / cols) | 0
      const out = []
      if (c > 0) out.push(i - 1)
      if (c < cols - 1) out.push(i + 1)
      if (r > 0) out.push(i - cols)
      if (r < rows - 1) out.push(i + cols)
      return out
    }
    const gap = (p, q) => {
      if (this.r[p] !== this.r[q]) return null
      const dc = (q % cols) - (p % cols)
      const dr = ((q / cols) | 0) - ((p / cols) | 0)
      const [ex, ey] = rot(dc * w, dr * h, this.r[p])
      const dx = this.x[q] - (this.x[p] + ex)
      const dy = this.y[q] - (this.y[p] + ey)
      return { dx, dy, d: Math.hypot(dx, dy) }
    }
    // A single piece (one cell, or a long piece) that gets connected is credited to this player
    // (kept forever); pieces already in a module keep their names.
    const credit = (list) => {
      if (!this.onePiece(list)) return
      for (const i of list) {
        if (this.by[i]) continue
        this.by[i] = this.user
        changed.add(i)
      }
    }
    const shift = (list, dx, dy) => {
      for (const i of list) {
        this.x[i] += dx
        this.y[i] += dy
        changed.add(i)
      }
    }

    // Snap the dropped group onto the closest matching neighbour.
    let best = null
    for (const p of ids) {
      for (const q of nbrs(p)) {
        if (group.has(q)) continue
        const m = gap(p, q)
        if (m && m.d < thr && (!best || m.d < best.d)) best = { p, q, ...m }
      }
    }
    if (!best) return changed
    if (out) out.onto = best.q
    shift(ids, best.dx, best.dy)
    credit(ids)
    const target = this.members(this.g[best.q])
    credit(target)
    for (const i of target) {
      group.add(i)
      changed.add(i)
    }
    // How far each group that joins was moved: the one snapped onto first, so it wins a tie.
    const parts = [
      { n: target.length, dx: 0, dy: 0 },
      { n: ids.length, dx: best.dx, dy: best.dy },
    ]

    // Pull in any other groups that now line up with the merged one.
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

    // The largest group stays where it was and everything else lines up with it, so adding a piece
    // never nudges a big group away from the loose pieces placed around it.
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

  // ---- dev tools (npm run dev only, see DevMenu.jsx) -----------------------

  // Puts pieces where they belong next to piece a, turned like it. Returns where they
  // were, so they can ease over from there.
  devPlace(ids, a) {
    const { cols } = this.room
    const { w, h } = this.geo
    const from = ids.map((i) => [this.x[i], this.y[i]])
    const now = performance.now()
    for (const i of ids) {
      const [ex, ey] = rot(((i % cols) - (a % cols)) * w, (((i / cols) | 0) - ((a / cols) | 0)) * h, this.r[a])
      this.x[i] = this.x[a] + ex
      this.y[i] = this.y[a] + ey
      this.r[i] = this.r[a]
      this.turns.delete(i)
    }
    return from
  }

  // Eases pieces from where they were (from, as devPlace returned) to where they are now.
  devEase(ids, from) {
    ids.forEach((i, k) => {
      this.moving.set(i, [this.x[i], this.y[i]])
      ;[this.x[i], this.y[i]] = from[k]
    })
  }

  // Joins two random neighbours that are apart: the smaller group moves onto the other.
  devConnect() {
    if (this.drag) return
    const { cols } = this.room
    const now = performance.now()
    const free = (i) => !(this.held.get(i) > now)
    const pairs = []
    for (let i = 0; i < this.n; i++) {
      if (!free(i)) continue
      if (i % cols < cols - 1 && this.g[i + 1] !== this.g[i] && free(i + 1)) pairs.push([i, i + 1])
      if (i + cols < this.n && this.g[i + cols] !== this.g[i] && free(i + cols)) pairs.push([i, i + cols])
    }
    if (!pairs.length) return
    let [p, q] = pairs[Math.floor(Math.random() * pairs.length)]
    if (this.members(this.g[p]).length > this.members(this.g[q]).length) [p, q] = [q, p]
    const ids = this.members(this.g[p])
    this.settle([...ids, ...this.members(this.g[q])])
    const from = this.devPlace(ids, q)
    const changed = this.snapModules([ids])
    this.devEase(ids, from)
    this.toTop(new Set(ids))
    this.placeInTrays(ids, this.x[q], this.y[q], this.trays.find((t) => t.pieces.includes(q)) || null)
    this.commit(changed, undefined, false)
  }

  // Puts every piece in place around the biggest group, finishing the jigsaw.
  devSolve() {
    if (this.drag || this.isComplete()) return
    const sizes = new Map()
    for (let i = 0; i < this.n; i++) sizes.set(this.g[i], (sizes.get(this.g[i]) || 0) + 1)
    const big = [...sizes].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
    const ids = []
    for (let i = 0; i < this.n; i++) if (this.g[i] !== big) ids.push(i)
    const all = Array.from({ length: this.n }, (_, i) => i)
    this.settle(all)
    const from = this.devPlace(ids, big)
    const g0 = this.g.slice()
    this.g.fill(0)
    this.joined(g0, ids, true)
    this.devEase(ids, from)
    this.toTop(new Set(ids))
    this.commit(all, undefined, false)
  }

  // Starts the jigsaw over: every piece apart and laid out afresh, as a new jigsaw would be, nobody
  // credited for anything and the trays emptied.
  devRestart() {
    if (this.drag) return
    const layout = scatter(this.room, (Math.random() * 2 ** 31) | 0)
    const now = performance.now()
    this.turns.clear()
    this.held.clear()
    this.remote.clear()
    for (const p of layout) {
      this.moving.set(p.i, [p.x, p.y])
      this.r[p.i] = p.r
      this.g[p.i] = p.g
      this.by[p.i] = null
    }
    this.setSelection(new Set())
    const full = this.trays.filter((t) => t.pieces.length)
    for (const t of full) t.pieces = []
    this.refitTrays(full)
    this.commit(layout.map((p) => p.i), undefined, false)
    setTimeout(() => this.fit(), 250)
  }

  // ---- remote -------------------------------------------------------------

  remoteMessage(msg) {
    const now = performance.now()
    if (msg.type === 'grab') {
      const n = msg.ids?.length
      if (!n || msg.ox?.length !== n || msg.oy?.length !== n || msg.r0?.length !== n) return
      const d = { ids: msg.ids, ox: msg.ox, oy: msg.oy, r0: msg.r0 }
      // A fresh grab for the pieces they already hold means they turned some: ease each one round.
      const prev = this.remote.get(msg.client)
      if (prev && prev.ids.length === n && prev.ids.every((id, j) => id === msg.ids[j])) {
        d.k = prev.k
        for (let j = 0; j < n; j++) {
          const dr = mod4(msg.r0[j] - prev.r0[j])
          if (dr) this.turns.set(msg.ids[j], { self: true, a: (this.turns.get(msg.ids[j])?.a || 0) - (dr === 3 ? -1 : dr) * Q })
        }
      }
      this.remote.set(msg.client, d)
      if (this.spectator) this.traces.set(msg.client, { ids: msg.ids, ox: msg.ox, oy: msg.oy, r0: msg.r0, frames: [] })
      this.rlift.set(msg.client, { ids: d.ids, set: new Set(d.ids), value: this.rlift.get(msg.client)?.value || 0, target: 1, tray: !!msg.tray })
      this.toTop(new Set(d.ids))
      this.remoteLive(d, msg.px, msg.py, msg.k | 0, now)
    } else if (msg.type === 'live') {
      const d = this.remote.get(msg.client)
      if (d) this.remoteLive(d, msg.px, msg.py, msg.k | 0, now)
      const tr = this.traces.get(msg.client)
      if (tr && isFinite(msg.px) && isFinite(msg.py)) {
        tr.frames.push({ t: now, px: msg.px, py: msg.py, k: msg.k | 0 })
        if (tr.frames.length > TRACE_FRAMES) tr.frames.shift()
      }
    } else if (msg.type === 'moves') {
      this.remote.delete(msg.client)
      const trace = this.traces.get(msg.client)
      this.traces.delete(msg.client)
      const rl = this.rlift.get(msg.client)
      if (rl) rl.target = 0
      this.applyRemote(msg.pieces, msg.turns, { client: msg.client, trace })
    } else if (msg.type === 'marks') {
      this.learnPlayer(msg)
      const ok = (a) => (Array.isArray(a) ? a.filter((i) => Number.isInteger(i) && i >= 0 && i < this.n) : [])
      const names = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 500) : [])
      const m = { sel: ok(msg.sel), hl: ok(msg.hl), refs: names(msg.refs), notes: names(msg.notes), tray: typeof msg.tray === 'string' ? msg.tray : null }
      if (m.sel.length || m.hl.length || m.refs.length || m.notes.length || m.tray) this.marks.set(msg.client, m)
      else this.marks.delete(msg.client)
      this.markNotes()
      this.invalidate()
    } else if (msg.type === 'cursor') {
      this.learnPlayer(msg)
      if (msg.hide) this.cursors.delete(msg.client)
      else if (isFinite(msg.x) && isFinite(msg.y)) {
        const c = this.cursors.get(msg.client)
        const name = String(msg.name || '').slice(0, 32) || 'Guest'
        const box = Array.isArray(msg.box) && msg.box.length === 4 && msg.box.every(isFinite) ? msg.box : null
        if (c) Object.assign(c, { tx: msg.x, ty: msg.y, name, t: now, box })
        else {
          const color = this.colorOf(msg.client)
          this.cursors.set(msg.client, { x: msg.x, y: msg.y, tx: msg.x, ty: msg.y, name, color, t: now, box })
        }
      }
      this.invalidate()
    } else if (msg.type === 'gone') {
      this.cursors.delete(msg.client)
      this.marks.delete(msg.client)
      this.players.delete(msg.client)
      this.traces.delete(msg.client)
      this.rlift.delete(msg.client)
      this.markNotes()
      const d = this.remote.get(msg.client)
      if (d) for (const i of d.ids) this.held.delete(i)
      this.remote.delete(msg.client)
    }
  }

  // Remembers which player is on a client (msg.player), and gives their cursor that player's colour.
  learnPlayer(msg) {
    if (typeof msg.player !== 'string' || !msg.player || this.players.get(msg.client) === msg.player) return
    this.players.set(msg.client, msg.player.slice(0, 64))
    const c = this.cursors.get(msg.client)
    if (c) c.color = this.colorOf(msg.client)
  }

  // A client's colour: its player's, so it stays the same across tabs and reloads, or its own for a guest.
  colorOf(client) {
    return cursorColor(this.players.get(client) || client)
  }

  remoteLive(d, px, py, k, now) {
    for (let j = 0; j < d.ids.length; j++) {
      const i = d.ids[j]
      if (this.drag?.set.has(i)) continue
      const [ox, oy] = rot(d.ox[j], d.oy[j], k)
      this.held.set(i, now + 2500)
      this.moving.set(i, [px + ox, py + oy])
      this.r[i] = mod4(d.r0[j] + k)
      // They turned the pieces they hold: ease each one's angle round.
      if (d.k !== undefined && k !== d.k) this.turns.set(i, { self: true, a: (this.turns.get(i)?.a || 0) - (k - d.k) * Q })
    }
    d.k = k
    this.invalidate()
  }

  // who is { client, trace } for pieces another player put down: the spectator replays what led to a snap.
  applyRemote(list, turns, who) {
    const g0 = this.g.slice()
    const touched = new Set()
    for (const p of list) {
      if (this.drag?.set.has(p.i)) continue
      this.held.delete(p.i)
      this.moving.set(p.i, [p.x, p.y])
      this.r[p.i] = p.r
      this.g[p.i] = p.g
      if (p.by !== undefined) this.by[p.i] = p.by
      const sh = this.sh
      sh.x[p.i] = p.x
      sh.y[p.i] = p.y
      sh.r[p.i] = p.r
      sh.g[p.i] = p.g
      sh.by[p.i] = this.by[p.i]
      touched.add(p.i)
    }
    // Pieces someone turned spin into place from where they lay, as they do on that player's screen.
    for (const t of Array.isArray(turns) ? turns : []) {
      if (!Array.isArray(t?.ids) || !isFinite(t.cx) || !isFinite(t.cy) || (t.d !== 1 && t.d !== -1)) continue
      const turn = { cx: t.cx, cy: t.cy, a: (this.turns.get(t.ids[0])?.a || 0) - t.d * Q }
      for (const i of t.ids) {
        if (!touched.has(i)) continue
        const to = this.moving.get(i)
        if (to) {
          ;[this.x[i], this.y[i]] = to
          this.moving.delete(i)
        }
        this.turns.set(i, turn)
      }
    }
    if (touched.size) this.toTop(touched)
    this.growSelection()
    this.joined(g0, touched, false, who)
    this.emitStats()
    this.checkComplete()
    this.invalidate()
  }

  // After a reconnect: catch up on whatever changed while the socket was down.
  resync(pieces) {
    const list = pieces.filter(
      (p) =>
        p.x !== this.x[p.i] || p.y !== this.y[p.i] || p.r !== this.r[p.i] || p.g !== this.g[p.i],
    )
    if (list.length) this.applyRemote(list)
  }

  // ---- reference images ---------------------------------------------------

  // The part of the picture an image shows, as fractions of it: [left, top, width, height].
  refTrim(ref) {
    return [ref.trimX ?? 0, ref.trimY ?? 0, ref.trimW ?? 1, ref.trimH ?? 1]
  }

  // An image's size on the table, of the part that shows: w is its width.
  refSize(ref) {
    const [, , tw, th] = this.refTrim(ref)
    return [ref.w, (ref.w * this.refAspect * th) / tw]
  }

  // Adds the reference image centred on a canvas point, or the middle of the view.
  addRef(sx = this.vw / 2, sy = this.vh / 2) {
    if (this.guard && !this.guard()) return
    const [x, y] = this.toWorld(sx, sy)
    // Fit comfortably in the current view.
    const w = Math.min(this.room.width, ((Math.min(this.vw, this.vh / this.refAspect) * 0.6) / this.cam.z))
    const ref = { id: Math.random().toString(36).slice(2, 10), x, y, w, opacity: 1, trimX: 0, trimY: 0, trimW: 1, trimH: 1, author: this.user || '' }
    this.refs.push(ref)
    this.selectRef(ref.id)
    this.onRef?.(ref, false)
  }

  // Delete or Backspace: removes the selected images, notes and tray (pieces stay).
  removeSelected() {
    if (this.guard && !this.guard()) return
    const refs = new Set(this.selRefs)
    if (this.refSel) refs.add(this.refSel)
    const notes = [...this.selNotes]
    if (this.traySel) this.removeTray(this.traySel)
    for (const id of refs) this.removeRef(id)
    if (notes.length) {
      this.notes?.remove(notes)
      for (const id of notes) this.trackObj('note', id, null)
    }
    this.setSelection(this.sel)
  }

  removeRef(id, remote = false) {
    if (!remote && this.guard && !this.guard()) return
    if (remote) this.seen('ref', id, null)
    else this.trackObj('ref', id, null)
    this.refs = this.refs.filter((r) => r.id !== id)
    if (this.refSel === id) this.refSel = null
    if (this.trim?.id === id) this.endTrim()
    this.selRefs.delete(id)
    if (this.refDrag?.ref.id === id) this.refDrag = null
    if (!remote) this.onRefDelete?.(id)
    this.invalidate()
  }

  // Another player added, moved or resized an image.
  remoteRef(ref) {
    if (this.refDrag?.ref.id === ref.id || this.carry?.refs.some((r) => r.id === ref.id)) return
    const cur = this.refs.find((r) => r.id === ref.id)
    if (cur) Object.assign(cur, ref)
    else this.refs.push(ref)
    this.seen('ref', ref.id, cur || ref)
    this.invalidate()
  }

  setRefs(refs) {
    const dragging = this.refDrag?.ref
    this.refs = refs.map((r) => (dragging && r.id === dragging.id ? dragging : r))
    if (this.refSel && !this.refs.some((r) => r.id === this.refSel)) this.refSel = null
    for (const id of this.selRefs) if (!this.refs.some((r) => r.id === id)) this.selRefs.delete(id)
    this.resetSeen('ref', this.refs)
    this.invalidate()
  }

  sendRefLive(force) {
    const now = performance.now()
    clearTimeout(this.refTimer)
    const d = this.refDrag
    if (!d) return
    if (force || now - (this.lastRefLive || 0) >= LIVE_MS) {
      this.lastRefLive = now
      this.onRef?.(d.ref, true)
    } else {
      this.refTimer = setTimeout(() => this.sendRefLive(true), LIVE_MS - (now - this.lastRefLive))
    }
  }

  selectRef(id) {
    if (this.refSel === id) return
    this.refSel = id
    this.sendMarks()
    this.invalidate()
  }

  // The screen rectangle, [x0, y0, x1, y1], of an image's menu button on its top right corner,
  // standing out over the edges a little, like a note's. That corner has no resize handle. Null when
  // the image is too small on the screen to hold it.
  refButton(ref) {
    const tag = Math.max(14, this.geo.S * 0.4 * this.cam.z)
    const [x0, y0, x1, y1] = this.refRect(ref)
    if (x1 - x0 < tag * 2 || y1 - y0 < tag * 2) return null
    return cornerButton(x1, y0, tag)
  }

  // The image whose menu button is at a screen point, if any.
  refButtonAt(sx, sy) {
    for (let k = this.refs.length - 1; k >= 0; k--) {
      if (this.hovered !== `ref:${this.refs[k].id}`) continue
      const b = this.refButton(this.refs[k])
      if (b && sx >= b[0] && sx <= b[2] && sy >= b[1] && sy <= b[3]) return this.refs[k]
    }
    return null
  }

  // Sets how see-through an image is (0.1 to 1), for everyone. live while the slider is dragged: shown
  // and passed on, but only saved, and remembered for undo, once it is let go.
  setRefOpacity(id, opacity, live = false) {
    const ref = this.refs.find((r) => r.id === id)
    if (!ref) return
    if (this.guard && !this.guard()) return
    ref.opacity = Math.min(1, Math.max(0.1, opacity))
    this.onRef?.(ref, live)
    this.invalidate()
  }

  // Trim: the next drag over the image picks the part of it that stays showing; Escape, or pressing
  // anywhere else, leaves it as it is.
  startTrim(id) {
    if (this.guard && !this.guard()) return
    if (!this.refs.some((r) => r.id === id)) return
    this.trim = { id, box: null }
    this.selectRef(id)
    if (this.selCount) this.setSelection(new Set())
    this.canvas.style.cursor = 'crosshair'
    this.invalidate()
  }

  endTrim() {
    if (!this.trim) return
    this.trim = null
    this.canvas.style.cursor = ''
    this.showTip(null)
    this.invalidate()
  }

  // The trim box, in screen space, kept inside its image: [x0, y0, x1, y1].
  trimRect() {
    const t = this.trim
    const ref = t && this.refs.find((r) => r.id === t.id)
    if (!ref || !t.box) return null
    const [x0, y0, x1, y1] = this.refRect(ref)
    const cx = (v) => Math.min(x1, Math.max(x0, v))
    const cy = (v) => Math.min(y1, Math.max(y0, v))
    const b = t.box
    return [cx(Math.min(b.sx0, b.sx)), cy(Math.min(b.sy0, b.sy)), cx(Math.max(b.sx0, b.sx)), cy(Math.max(b.sy0, b.sy))]
  }

  // Shows only the part of the image inside the trim box, left where it was on the table.
  applyTrim() {
    const ref = this.refs.find((r) => r.id === this.trim?.id)
    const box = this.trimRect()
    this.endTrim()
    if (!ref || !box || box[2] - box[0] < 4 || box[3] - box[1] < 4) return
    if (this.guard && !this.guard()) return
    const [x0, y0, x1, y1] = this.refRect(ref)
    const [tx, ty, tw, th] = this.refTrim(ref)
    const [a, b] = [(box[0] - x0) / (x1 - x0), (box[2] - x0) / (x1 - x0)]
    const [c, d] = [(box[1] - y0) / (y1 - y0), (box[3] - y0) / (y1 - y0)]
    const [wx0, wy0] = this.toWorld(box[0], box[1])
    const [wx1, wy1] = this.toWorld(box[2], box[3])
    Object.assign(ref, {
      trimX: tx + a * tw,
      trimY: ty + c * th,
      trimW: Math.max(0.01, (b - a) * tw),
      trimH: Math.max(0.01, (d - c) * th),
      x: (wx0 + wx1) / 2,
      y: (wy0 + wy1) / 2,
      w: wx1 - wx0,
    })
    this.onRef?.(ref, false)
    this.invalidate()
  }

  // Shows the whole picture again, at the same scale, with the part that showed staying where it was.
  untrim(id) {
    const ref = this.refs.find((r) => r.id === id)
    if (!ref) return
    if (this.guard && !this.guard()) return
    const [tx, ty, tw, th] = this.refTrim(ref)
    const [w, h] = this.refSize(ref)
    const fw = w / tw
    const fh = h / th
    Object.assign(ref, {
      x: ref.x - w / 2 - tx * fw + fw / 2,
      y: ref.y - h / 2 - ty * fh + fh / 2,
      w: fw,
      trimX: 0,
      trimY: 0,
      trimW: 1,
      trimH: 1,
    })
    this.onRef?.(ref, false)
    this.invalidate()
  }

  // Screen-space corners of a reference image: [x0, y0, x1, y1].
  refRect(ref) {
    const [w, h] = this.refSize(ref)
    const { cam, vw, vh } = this
    return [
      (ref.x - w / 2 - cam.x) * cam.z + vw / 2,
      (ref.y - h / 2 - cam.y) * cam.z + vh / 2,
      (ref.x + w / 2 - cam.x) * cam.z + vw / 2,
      (ref.y + h / 2 - cam.y) * cam.z + vh / 2,
    ]
  }

  // The selected image's handles win over everything; otherwise the topmost image under the point.
  refHit(sx, sy) {
    const sel = this.refs.find((r) => r.id === this.refSel)
    if (sel) {
      const [x0, y0, x1, y1] = this.refRect(sel)
      for (const cx of [0, 1]) {
        for (const cy of [0, 1]) {
          // The top right corner holds the menu button instead.
          if (cx && !cy) continue
          const hx = cx ? x1 : x0
          const hy = cy ? y1 : y0
          if (Math.abs(sx - hx) <= HANDLE + 3 && Math.abs(sy - hy) <= HANDLE + 3) return { ref: sel, mode: 'resize', cx, cy }
        }
      }
    }
    for (let k = this.refs.length - 1; k >= 0; k--) {
      const [x0, y0, x1, y1] = this.refRect(this.refs[k])
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) return { ref: this.refs[k], mode: 'move' }
    }
    return null
  }

  startRefDrag(rh, pointer, wx, wy) {
    const ref = rh.ref
    if (this.guard && !this.guard()) return
    this.selectRef(ref.id)
    if (this.selCount) this.setSelection(new Set())
    // Bring to front.
    this.refs = this.refs.filter((r) => r !== ref).concat(ref)
    const [w, h] = this.refSize(ref)
    this.refDrag = {
      ref,
      pointer,
      mode: rh.mode,
      dx: ref.x - wx,
      dy: ref.y - wy,
      // Resizing keeps the opposite corner in place.
      ax: ref.x + (rh.cx ? -w / 2 : w / 2),
      ay: ref.y + (rh.cy ? -h / 2 : h / 2),
      sx: rh.cx ? 1 : -1,
      sy: rh.cy ? 1 : -1,
    }
    if (rh.mode === 'move') this.canvas.style.cursor = 'grabbing'
    this.invalidate()
  }

  moveRef(wx, wy) {
    const d = this.refDrag
    const ref = d.ref
    d.moved = true
    if (d.mode === 'move') {
      ref.x = wx + d.dx
      ref.y = wy + d.dy
    } else {
      const [w0, h0] = this.refSize(ref)
      const a = h0 / w0
      const min = this.geo.S
      const w = Math.max(min, Math.max(d.sx * (wx + (d.ox || 0) - d.ax), (d.sy * (wy + (d.oy || 0) - d.ay)) / a))
      ref.w = w
      ref.x = d.ax + (d.sx * w) / 2
      ref.y = d.ay + (d.sy * w * a) / 2
    }
    this.sendRefLive()
    this.invalidate()
  }

  // ---- trays ----------------------------------------------------------------

  // Adds a tray in a random colour (one no other tray has, while there are some left). With pieces
  // selected, it's made around them, taking them out of any tray they were in. Otherwise it's empty,
  // centred on a canvas point or the middle of the view.
  addTray(sx = this.vw / 2, sy = this.vh / 2) {
    if (this.guard && !this.guard()) return
    const ids = this.sel.size ? this.freeSelection() : []
    const [x, y] = this.toWorld(sx, sy)
    const w = this.geo.S * TRAY_W
    const h = this.geo.S * TRAY_H
    const keys = Object.keys(TRAY_COLORS)
    const used = new Set(this.trays.map((t) => t.color))
    const free = keys.filter((k) => !used.has(k))
    const pick = free.length ? free : keys
    const color = pick[Math.floor(Math.random() * pick.length)]
    // The lowest of 1 to 9 no tray has; none once all are taken.
    const taken = new Set(this.trays.map((t) => t.num))
    let num = 0
    for (let n = 1; n <= 9 && !num; n++) if (!taken.has(n)) num = n
    const tray = {
      id: Math.random().toString(36).slice(2, 10),
      x: x - w / 2,
      y: y - h / 2,
      w,
      h,
      name: '',
      color,
      num,
      auto: false,
      pieces: [],
      author: this.user || '',
    }
    const left = []
    if (ids.length) {
      const moved = new Set(ids)
      for (const t of this.trays) {
        if (!t.pieces.some((i) => moved.has(i))) continue
        t.pieces = t.pieces.filter((i) => !moved.has(i))
        left.push(t)
      }
      tray.pieces = ids
      this.fitTray(tray)
    }
    this.trays.push(tray)
    this.refitTrays(left)
    if (this.selCount) this.setSelection(new Set())
    this.selectRef(null)
    this.selectTray(tray.id)
    this.onTray?.(tray, false)
  }

  selectTray(id) {
    if (this.traySel === id) return
    this.traySel = id
    this.sendMarks()
    this.invalidate()
  }

  removeTray(id, remote = false) {
    if (!remote && this.guard && !this.guard()) return
    const gone = this.trays.find((t) => t.id === id)
    if (remote) this.seen('tray', id, null)
    else this.trackObj('tray', id, null, { pieces: gone ? gone.pieces.slice() : [] })
    this.trays = this.trays.filter((t) => t.id !== id)
    if (this.traySel === id) this.traySel = null
    if (this.carry) this.carry.trays = this.carry.trays.filter((t) => t.id !== id)
    if (!remote) this.onTrayDelete?.(id)
    this.trackTrays()
    this.invalidate()
  }

  // Another player added, moved or filled a tray.
  remoteTray(tray) {
    if (this.carry?.trays.some((t) => t.id === tray.id)) return
    const cur = this.trays.find((t) => t.id === tray.id)
    if (cur) {
      // Its box eases to the new place, as the pieces carried in it do.
      const { x, y, w, h, ...rest } = tray
      Object.assign(cur, rest)
      if ([x, y, w, h].every(isFinite)) this.trayTo.set(cur.id, { x, y, w, h })
      else Object.assign(cur, { x, y, w, h })
    } else this.trays.push({ ...tray, pieces: tray.pieces || [] })
    this.seen('tray', tray.id, cur ? { ...cur, ...tray } : tray)
    this.trackTrays()
    this.invalidate()
  }

  setTrays(trays) {
    this.trays = trays.map((t) => ({ ...t, auto: !!t.auto, pieces: t.pieces || [] }))
    this.trayTo.clear()
    if (this.traySel && !this.trays.some((t) => t.id === this.traySel)) this.traySel = null
    this.resetSeen('tray', this.trays)
    this.trackTrays()
    this.invalidate()
  }

  // The topmost tray under a canvas point (pieces on it come first, see onDown).
  trayHit(sx, sy) {
    const [wx, wy] = this.toWorld(sx, sy)
    for (let k = this.trays.length - 1; k >= 0; k--) {
      const t = this.trays[k]
      if (wx >= t.x && wx <= t.x + t.w && wy >= t.y && wy <= t.y + t.h) return { tray: t }
    }
    return null
  }

  // The pieces to carry with a tray: its own, with the rest of their groups, less any that someone
  // else is holding.
  // With ordered, in the order they came into the tray, new ones last.
  trayPieces(t, ordered = false) {
    const now = performance.now()
    const all = this.withGroups(t.pieces)
    const list = [...all]
    if (ordered) {
      const rank = new Map()
      for (const i of t.pieces) if (!rank.has(this.g[i])) rank.set(this.g[i], rank.size)
      list.sort((a, b) => rank.get(this.g[a]) - rank.get(this.g[b]))
    }
    return list.filter((i) => !(this.held.get(i) > now))
  }

  // Where a piece is going, if it's still easing there.
  target(i) {
    return this.moving.get(i) || [this.x[i], this.y[i]]
  }

  // The margin between a tray's edge and the middles of its outermost pieces.
  get trayPad() {
    return this.radius + this.geo.S * 0.25
  }

  // Fits a tray around its pieces, with a margin. An empty tray keeps
  // its top left corner and shrinks to the size of a new one.
  fitTray(t) {
    const S = this.geo.S
    if (!t.pieces.length) {
      t.w = S * TRAY_W
      t.h = S * TRAY_H
      return
    }
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const i of t.pieces) {
      const [x, y] = this.target(i)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    const pad = this.trayPad
    t.x = x0 - pad
    t.y = y0 - pad
    t.w = x1 - x0 + pad * 2
    t.h = y1 - y0 + pad * 2
  }

  // After this player dropped pieces (ids) with the pointer at (wx, wy): everything carried goes in
  // the tray given (null: none), or else the tray under the pointer, and comes out of its tray when
  // let go of anywhere else. Every tray that gained or lost pieces, or had them moved, fits itself
  // around them again.
  placeInTrays(ids, wx, wy, into) {
    if (!this.trays.length) return
    for (let k = this.trays.length - 1; k >= 0 && into === undefined; k--) {
      const t = this.trays[k]
      if (wx >= t.x && wx <= t.x + t.w && wy >= t.y && wy <= t.y + t.h) into = t
    }
    const moved = this.withGroups(ids)
    const touched = new Set(into ? [into] : [])
    const left = []
    for (const t of this.trays) {
      if (t === into || !t.pieces.some((i) => moved.has(i))) continue
      t.pieces = t.pieces.filter((i) => !moved.has(i))
      touched.add(t)
      left.push(t)
    }
    if (into) into.pieces = [...new Set([...into.pieces, ...moved])]
    this.refitTrays(touched)
    return { into, left }
  }

  // Trays set to sort by themselves lay everything in them out in a grid, after pieces were put in
  // them or taken out (what placeInTrays returned).
  autoSort(change) {
    if (!change) return
    const list = change.into || change.left ? [change.into, ...(change.left || [])] : [change]
    for (const t of list) if (t?.auto && t.pieces.length) this.sortSelection(false, this.trayPieces(t, true))
  }

  // Turns a tray's own sorting on or off, for everyone. Turning it on sorts what is in it now.
  setTrayAuto(id, on) {
    const t = this.trays.find((x) => x.id === id)
    if (!t || !!t.auto === on) return
    if (this.guard && !this.guard()) return
    t.auto = on
    this.onTray?.(t, false)
    this.invalidate()
    this.autoSort({ into: t })
  }

  // The screen rectangles, [x0, y0, x1, y1], of a tray's buttons along its top edge, standing out over
  // it a little like a note's: its menu on the top right corner and its auto sort switch beside it.
  trayButtons(t) {
    const { cam, vw, vh } = this
    const tag = Math.max(14, this.geo.S * 0.4 * cam.z)
    const gap = tag * 0.3
    const menu = cornerButton((t.x + t.w - cam.x) * cam.z + vw / 2, (t.y - cam.y) * cam.z + vh / 2, tag)
    const x0 = menu[0] - gap * 0.6
    return { menu, auto: [x0 - tag, menu[1], x0, menu[3]], tag }
  }

  // Whether a tray is big enough on the screen to hold its number and buttons along its top edge.
  // Zoomed far out it isn't, and they are left out.
  trayTagsFit(t) {
    const tag = Math.max(14, this.geo.S * 0.4 * this.cam.z)
    const gap = tag * 0.3
    const w = (t.num ? tag + gap : 0) + tag * 2 + gap
    return t.w * this.cam.z >= w && t.h * this.cam.z >= tag * 1.5
  }

  // The tray button at a screen point, if any: { tray, kind }, kind being 'menu' or 'auto'.
  trayButtonAt(sx, sy) {
    for (let k = this.trays.length - 1; k >= 0; k--) {
      const t = this.trays[k]
      if (this.hovered !== `tray:${t.id}` || !this.trayTagsFit(t)) continue
      const b = this.trayButtons(t)
      for (const kind of ['menu', 'auto']) {
        const [x0, y0, x1, y1] = b[kind]
        if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) return { tray: t, kind }
      }
    }
    return null
  }

  // Renames or recolours a tray (look: { name } or { color }), for everyone.
  setTrayLook(id, look) {
    const t = this.trays.find((x) => x.id === id)
    if (!t || Object.keys(look).every((k) => t[k] === look[k])) return
    if (this.guard && !this.guard()) return
    Object.assign(t, look)
    this.onTray?.(t, false)
    this.invalidate()
  }

  // A number key with pieces selected, or Send to in their menu: lays them out in a grid in the tray
  // with that number (or id), next to whatever is in it already, and takes them out of any other tray.
  sendToTray(which) {
    const t = this.trays.find((x) => (typeof which === 'number' ? x.num === which : x.id === which))
    if (!t) return
    if (this.guard && !this.guard()) return
    const ids = this.freeSelection()
    if (!ids.length) return
    this.settle(ids)
    const mods = this.modules(ids)
    const boxes = mods.map((m) => this.bbox(m, this.packExtent))
    const spots = pack(boxes, this.geo.S)
    // The grid's extent around its middle.
    let gx0 = Infinity
    let gx1 = -Infinity
    let gy0 = Infinity
    let gy1 = -Infinity
    boxes.forEach((b, k) => {
      gx0 = Math.min(gx0, spots[k][0] - (b.x1 - b.x0) / 2)
      gx1 = Math.max(gx1, spots[k][0] + (b.x1 - b.x0) / 2)
      gy0 = Math.min(gy0, spots[k][1] - (b.y1 - b.y0) / 2)
      gy1 = Math.max(gy1, spots[k][1] + (b.y1 - b.y0) / 2)
    })
    const gw = gx1 - gx0
    const gh = gy1 - gy0
    const moved = this.withGroups(ids)
    const rest = t.pieces.filter((i) => !moved.has(i))
    // Where the grid's top left corner goes: the middle of an empty tray, else beside what's in it.
    // The tray grows along its shorter side, so a wide one gets the grid above or below it and a
    // tall one to its left or right, on whichever side the pieces came from.
    let left = t.x + t.w / 2 - gw / 2
    let top = t.y + t.h / 2 - gh / 2
    if (rest.length) {
      const b = this.bbox(rest, this.packExtent)
      const from = this.bbox(ids, 0)
      const fx = (from.x0 + from.x1) / 2
      const fy = (from.y0 + from.y1) / 2
      const mx = (b.x0 + b.x1) / 2
      const my = (b.y0 + b.y1) / 2
      if (b.x1 - b.x0 >= b.y1 - b.y0) {
        left = mx - gw / 2
        top = fy < my ? b.y0 - gh : b.y1
      } else {
        top = my - gh / 2
        left = fx < mx ? b.x0 - gw : b.x1
      }
    }
    left -= gx0
    top -= gy0
    const x0 = this.x.slice()
    const y0 = this.y.slice()
    mods.forEach((m, k) => {
      const b = boxes[k]
      const dx = left + spots[k][0] - (b.x0 + b.x1) / 2
      const dy = top + spots[k][1] - (b.y0 + b.y1) / 2
      for (const i of m) {
        this.x[i] += dx
        this.y[i] += dy
      }
    })
    const changed = this.snapModules(mods)
    // Ease everything from where it was, not just what the snap moved.
    for (const i of ids) {
      if (!this.moving.has(i)) this.moving.set(i, [this.x[i], this.y[i]])
      this.x[i] = x0[i]
      this.y[i] = y0[i]
    }
    this.toTop(new Set(ids))
    const change = this.placeInTrays(ids, 0, 0, t)
    this.commit(changed)
    this.autoSort(change)
  }

  // After pieces were turned or sorted: the trays they're in fit themselves around them again.
  fitTraysOf(ids) {
    const set = ids instanceof Set ? ids : new Set(ids)
    this.refitTrays(this.trays.filter((t) => t.pieces.some((i) => set.has(i))))
  }

  refitTrays(trays) {
    for (const t of trays) {
      this.fitTray(t)
      this.onTray?.(t, false)
    }
    if (trays.size || trays.length) this.invalidate()
  }

  // A press on a tray: moves it, carrying the pieces in it along. The pieces are only
  // picked up once the pointer moves, so a click just selects the tray.
  startTrayDrag(th, pointer, sx, sy, wx, wy) {
    const t = th.tray
    if (this.guard && !this.guard()) return
    if (this.selCount) this.setSelection(new Set())
    this.selectRef(null)
    this.selectTray(t.id)
    this.trays = this.trays.filter((x) => x !== t).concat(t)
    this.carry = {
      pointer,
      wx,
      wy,
      sx0: sx,
      sy0: sy,
      moved: false,
      note: null,
      refs: [],
      notes: [],
      trays: [{ id: t.id, x: t.x, y: t.y }],
      lift: { ids: this.trayPieces(t), wx, wy, sx, sy },
    }
    this.canvas.style.cursor = 'grabbing'
    this.invalidate()
  }

  // Which way the table moves while something is held near the edge of the view: -1, 0 or 1 on each
  // axis. Only once it has been moved, so pressing on something near the edge doesn't move the table.
  edgeDir() {
    const held = this.drag || this.carry || this.refDrag
    if (!held?.moved) return [0, 0]
    const p = this.drag ? [this.drag.sx, this.drag.sy] : this.pointers.get(held.pointer)
    if (!p) return [0, 0]
    const [sx, sy] = p
    const dir = (v, size) => (v < EDGE_PX ? -1 : v > size - EDGE_PX ? 1 : 0)
    return [dir(sx, this.vw), dir(sy, this.vh)]
  }

  // After the table moves under the pointer, what it holds keeps up with it.
  follow() {
    if (this.drag) {
      this.updatePivot()
      this.sendLive()
    } else if (this.carry?.moved) {
      const p = this.pointers.get(this.carry.pointer)
      if (p) this.moveCarry(...this.toWorld(...p))
    }
    const d = this.refDrag
    const p = d?.moved && this.pointers.get(d.pointer)
    if (p) this.moveRef(...this.toWorld(...p))
  }

  // ---- rendering ----------------------------------------------------------

  render() {
    if (this.raf === -1) return
    this.raf = 0
    const now = performance.now()
    const dt = Math.min(64, now - this.last)
    this.last = now
    let again = false

    if (!this.spriteWorker && this.built < this.n) {
      this.buildSome(now + 12)
      again = true
    }

    if (this.camAnim) {
      const a = this.camAnim
      const t = Math.min(1, (now - a.t0) / a.ms)
      const e = 1 - Math.pow(1 - t, 3)
      const lz = Math.log(a.from.z) + (Math.log(a.to.z) - Math.log(a.from.z)) * e
      this.cam = {
        x: a.from.x + (a.to.x - a.from.x) * e,
        y: a.from.y + (a.to.y - a.from.y) * e,
        z: Math.exp(lz),
      }
      if (t >= 1) {
        this.camAnim = null
        this.clampCam()
      } else again = true
    }

    let [vx, vy] = this.edgeDir()
    for (const k of this.panKeys) {
      vx += PAN_KEYS[k][0]
      vy += PAN_KEYS[k][1]
    }
    vx = Math.sign(vx)
    vy = Math.sign(vy)
    if (vx || vy) {
      this.panSince ||= now
      const boost = 1 + (PAN_BOOST - 1) * Math.min(1, (now - this.panSince) / PAN_RAMP) ** 2
      const f = (PAN_SPEED * boost * dt) / 1000 / Math.hypot(vx, vy) / this.cam.z
      this.cam.x += vx * f
      this.cam.y += vy * f
      this.clampCam()
      this.follow()
      again = true
    } else this.panSince = 0

    if (this.drag) {
      const d = this.drag
      const target = d.k * Q
      d.angle += (target - d.angle) * ease(dt, 45)
      if (Math.abs(target - d.angle) > 0.001) again = true
      else d.angle = target
      if (d.spinning) {
        const f = ease(dt, 45)
        const fm = ease(dt, 60)
        let left = 0
        let far = 0
        for (let j = 0; j < d.sa.length; j++) {
          d.sa[j] -= d.sa[j] * f
          d.tx[j] -= d.tx[j] * fm
          d.ty[j] -= d.ty[j] * fm
          left = Math.max(left, Math.abs(d.sa[j]))
          far = Math.max(far, Math.abs(d.tx[j]) + Math.abs(d.ty[j]))
        }
        if (left > 0.001 || far > 0.05) again = true
        else {
          d.sa.fill(0)
          d.tx.fill(0)
          d.ty.fill(0)
          d.spinning = false
        }
      }
    }

    if (this.lift) {
      const l = this.lift
      l.value += (l.target - l.value) * ease(dt, l.target ? 55 : 70)
      if (Math.abs(l.target - l.value) < 0.005) {
        l.value = l.target
        if (!l.target) this.lift = null
      } else again = true
      if (this.drag?.touch && this.lift === l) {
        this.updatePivot()
        this.sendLive()
      }
    }

    for (const [id, rl] of this.rlift) {
      rl.value += (rl.target - rl.value) * ease(dt, rl.target ? 55 : 70)
      if (Math.abs(rl.target - rl.value) < 0.005) {
        rl.value = rl.target
        if (!rl.target) this.rlift.delete(id)
      } else again = true
    }

    for (const [id, c] of this.cursors) {
      if (now - c.t > CURSOR_IDLE) {
        this.cursors.delete(id)
        continue
      }
      const f = ease(dt, 45)
      c.x += (c.tx - c.x) * f
      c.y += (c.ty - c.y) * f
      if (Math.abs(c.tx - c.x) + Math.abs(c.ty - c.y) > 0.05) again = true
      else {
        c.x = c.tx
        c.y = c.ty
      }
    }
    if (this.cursors.size) {
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.invalidate(), CURSOR_IDLE + 100)
    }

    if (this.turns.size) {
      const f = ease(dt, 45)
      // A module's pieces share one turn; ease each turn once.
      const eased = new Set()
      for (const [i, t] of this.turns) {
        if (!eased.has(t)) {
          eased.add(t)
          t.a -= t.a * f
        }
        if (Math.abs(t.a) < 0.001) this.turns.delete(i)
      }
      again = true
    }

    for (const [i, [tx, ty]] of this.moving) {
      const f = ease(dt, 40)
      this.x[i] += (tx - this.x[i]) * f
      this.y[i] += (ty - this.y[i]) * f
      if (Math.abs(tx - this.x[i]) + Math.abs(ty - this.y[i]) < 0.05) {
        this.x[i] = tx
        this.y[i] = ty
        this.moving.delete(i)
      } else again = true
    }

    for (const [id, to] of this.trayTo) {
      const t = this.trays.find((x) => x.id === id)
      if (!t || this.carry?.trays.some((c) => c.id === id)) {
        this.trayTo.delete(id)
        continue
      }
      const f = ease(dt, 40)
      for (const k of ['x', 'y', 'w', 'h']) t[k] += (to[k] - t[k]) * f
      if (Math.abs(to.x - t.x) + Math.abs(to.y - t.y) + Math.abs(to.w - t.w) + Math.abs(to.h - t.h) < 0.05) {
        Object.assign(t, to)
        this.trayTo.delete(id)
      } else again = true
    }

    if (this.pops.length || this.spectator) again = true

    this.draw()
    if (again) this.invalidate()
  }

  draw() {
    if (this.spectator) return this.spectator.draw(this.last)
    const { ctx, cam, vw, vh } = this
    const mv = this.mv
    if (cam.x !== mv.x || cam.y !== mv.y || cam.z !== mv.z || vw !== mv.w || vh !== mv.h || this.viewsVer !== this.viewFn) {
      mv.x = cam.x
      mv.y = cam.y
      mv.z = cam.z
      mv.w = vw
      mv.h = vh
      this.viewFn = this.viewsVer
      for (const fn of this.views) fn(cam, vw, vh)
    }
    if (this.gpu) this.drawGpu(mv)
    if (this.dirty) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      this.dirty = false
    }
    this.drawChrome()
  }

  // The world rectangle a view shows, grown by e on every side, into this.cull.
  cullRect(v, e) {
    const c = (this.cull ??= {})
    const hw = v.w / 2 / v.z + e
    const hh = v.h / 2 / v.z + e
    c.x0 = v.x - hw
    c.y0 = v.y - hh
    c.x1 = v.x + hw
    c.y1 = v.y + hh
    return c
  }

  // Builds a frame for the GPU (see gpu.js) for view v, in device pixels: the trays and reference
  // images in view, the pieces lying on the table in table order, the lifted pieces, and the
  // selected and hovered pieces once more for their outlines.
  drawGpu(v) {
    const { dpr } = this
    const z = v.z * dpr
    const sx = (wx) => ((wx - v.x) * v.z + v.w / 2) * dpr
    const sy = (wy) => ((wy - v.y) * v.z + v.h / 2) * dpr
    const { x0: wx0, y0: wy0, x1: wx1, y1: wy1 } = this.cullRect(v, 0)

    this.gTrays = grow(this.gTrays, this.trays.length * TRAY_FLOATS)
    let trays = 0
    const markedTrays = this.markedBy('tray')
    const markedRefs = this.markedBy('refs')
    const radius = Math.min(this.geo.S * 0.25, 10 / v.z) * z
    for (const t of this.trays) {
      if (t.x + t.w < wx0 || t.x > wx1 || t.y + t.h < wy0 || t.y > wy1) continue
      const color = rgba(TRAY_COLORS[t.color] || TRAY_COLORS.gray)
      const on = t.id === this.traySel
      const mark = !on && markedTrays.get(t.id)
      const rect = [sx(t.x), sy(t.y), sx(t.x + t.w), sy(t.y + t.h)]
      const r = Math.min(radius, (rect[2] - rect[0]) / 2, (rect[3] - rect[1]) / 2)
      this.gTrays.set([...rect, ...pm(color, 0.16), ...pm(on ? rgba(this.colors.sel) : mark ? rgba(mark) : color, on || mark ? 1 : 0.7), r, (on || mark ? 2.5 : 1.25) * dpr, 0, 0], trays++ * TRAY_FLOATS)
    }

    this.gRefs = grow(this.gRefs, this.refs.length * REF_FLOATS)
    let refs = 0
    for (const ref of this.refs) {
      const [w, h] = this.refSize(ref)
      if (ref.x + w / 2 < wx0 || ref.x - w / 2 > wx1 || ref.y + h / 2 < wy0 || ref.y - h / 2 > wy1) continue
      const on = this.selRefs.has(ref.id)
      const mark = !on && markedRefs.get(ref.id)
      const rect = [sx(ref.x - w / 2), sy(ref.y - h / 2), sx(ref.x + w / 2), sy(ref.y + h / 2)]
      this.gRefs.set([...rect, ...pm(rgba(on ? this.colors.sel : mark || this.colors.dot)), (on || mark ? 3 : 1) * dpr, ref.opacity ?? 1, 0, 0, ...this.refTrim(ref)], refs++ * REF_FLOATS)
    }

    const R = this.radius
    const seen = (x, y, e) => x + e >= wx0 && x - e <= wx1 && y + e >= wy0 && y - e <= wy1
    this.gn = 0
    const lifted = this.lift?.set
    const rlifted = this.rlift.size ? new Set([...this.rlift.values()].flatMap((rl) => rl.ids)) : null
    // Trays lie above the pieces on the table, and the pieces in them above the trays.
    const inTray = this.trays.length ? new Set(this.trays.flatMap((t) => t.pieces)) : null
    for (const i of this.order) {
      if (lifted?.has(i) || rlifted?.has(i) || inTray?.has(i)) continue
      this.poseInto(i)
      if (seen(this.qx, this.qy, R)) this.gpuPiece(i, this.qx, this.qy, this.qa, 1, v)
    }
    const still = [0, this.gn]
    if (inTray) {
      for (const i of this.order) {
        if (lifted?.has(i) || rlifted?.has(i) || !inTray.has(i)) continue
        this.poseInto(i)
        if (seen(this.qx, this.qy, R)) this.gpuPiece(i, this.qx, this.qy, this.qa, 1, v)
      }
    }
    const trayed = [still[1], this.gn - still[1]]
    const lift = [this.gn, 0]
    // Lifted pieces (ours and others'), as they're drawn: id -> [x, y, angle, scale]. Outlines use
    // these, so they fit the pieces while they're lifted, carried and put down again.
    const drawn = new Map()
    if (this.lift) {
      this.liftPoses((i, x, y, a, s) => {
        drawn.set(i, [x, y, a, s])
        if (seen(x, y, R * s)) this.gpuPiece(i, x, y, a, s, v)
      })
    }
    // Pieces other players carry, grown a little as ours are.
    let rvalue = 0
    for (const rl of this.rlift.values()) {
      const s = 1 + 0.045 * rl.value
      rvalue = Math.max(rvalue, rl.value)
      for (const i of rl.ids) {
        if (lifted?.has(i)) continue
        this.poseInto(i)
        drawn.set(i, [this.qx, this.qy, this.qa, s])
        if (seen(this.qx, this.qy, R * s)) this.gpuPiece(i, this.qx, this.qy, this.qa, s, v)
      }
    }
    lift[1] = this.gn - lift[0]
    // The outlined pieces exactly as they're drawn, and the box around them on the screen.
    const outlined = (ids, box) => {
      const first = this.gn
      for (const i of ids) {
        let p = drawn.get(i)
        if (!p) {
          this.poseInto(i)
          p = [this.qx, this.qy, this.qa, 1]
        }
        const [x, y, a, s] = p
        const e = R * s * z
        if (!seen(x, y, R * s) || !this.gpuPiece(i, x, y, a, s, v)) continue
        const X = sx(x)
        const Y = sy(y)
        box[0] = Math.min(box[0], X - e)
        box[1] = Math.min(box[1], Y - e)
        box[2] = Math.max(box[2], X + e)
        box[3] = Math.max(box[3], Y + e)
      }
      return [first, this.gn - first]
    }
    // While carrying pieces, the selection outline goes under them, and leaves them out.
    const selBox = [Infinity, Infinity, -Infinity, -Infinity]
    const carried = this.drag && lifted
    const sel = this.sel.size ? outlined(carried ? [...this.sel].filter((i) => !carried.has(i)) : this.sel, selBox) : [0, 0]
    const hlBox = [Infinity, Infinity, -Infinity, -Infinity]
    // The hover outline leaves out selected pieces, which have the selection's.
    const hover = this.hl && !this.drag ? this.hl.ids.filter((i) => !this.sel.has(i)) : []
    // The pieces we carry are outlined too, over everything. There is no hover while carrying, so
    // they take its place. Pieces riding along in a moved tray are not.
    const hl = this.drag && this.lift ? (this.drag.tray ? [0, 0] : outlined(this.lift.ids, hlBox)) : hover.length ? outlined(hover, hlBox) : [0, 0]
    // What other players hold, select or hover over, each in their cursor colour. What they carry is
    // outlined as it's drawn, lifted, over everything, like ours.
    const extra = []
    for (const c of new Set([...this.marks.keys(), ...this.remote.keys()])) {
      if (extra.length >= MAX_OUTLINES) break
      const m = this.marks.get(c)
      const rl = this.rlift.get(c)
      // Pieces riding along in a tray they move aren't outlined, as with ours.
      const tray = rl?.target && rl.tray
      const up = new Set(rl?.target && !tray ? rl.ids.filter((i) => !lifted?.has(i)) : [])
      // Pieces we carry are left out: they're outlined in our colour, where we hold them.
      const held = tray ? [] : this.remote.get(c)?.ids || []
      const ids = new Set([...(m?.sel || []), ...(m?.hl || []), ...held].filter((i) => !up.has(i) && !lifted?.has(i)))
      const color = rgba(this.colorOf(c))
      if (ids.size) {
        const box = [Infinity, Infinity, -Infinity, -Infinity]
        extra.push({ range: outlined(ids, box), box, color })
      }
      if (up.size) {
        const box = [Infinity, Infinity, -Infinity, -Infinity]
        extra.push({ range: outlined(up, box), box, color, over: true })
      }
    }

    let sp = this.geo.S
    while (sp * v.z < 22) sp *= 2
    while (sp * v.z > 44) sp /= 2
    const lv = Math.max(this.lift?.value || 0, rvalue)
    const l = this.lift || rvalue > 0 ? { value: lv } : null
    this.gpu.frame({
      W: this.gpuEl.width,
      H: this.gpuEl.height,
      cam: [v.x, v.y, z],
      sprite: [this.spriteW, this.spriteH],
      bg: rgba(this.colors.bg),
      dot: rgba(this.colors.dot),
      dotStep: sp,
      dotSize: Math.max(1, 1.25 * dpr),
      trays: { data: this.gTrays, count: trays },
      refs: { data: this.gRefs, count: refs },
      pieces: { data: this.gi, count: this.gn },
      seg: { still, trayed, lift, sel, hl },
      selBox,
      hlBox,
      extra,
      selColor: rgba(this.colors.sel),
      hlColor: rgba(this.drag ? this.colors.sel : this.colors.line || '#000'),
      hlOver: !!this.drag,
      outline: [2.5 * dpr, 0.5 * dpr],
      selUnder: !!this.drag,
      shadow: l && { color: rgba(this.colors.shadow), blur: (4 + 26 * l.value) * dpr, ox: (1 + 7 * l.value) * dpr, oy: (2 + 16 * l.value) * dpr },
    })
  }

  // Adds piece i at (x, y), turned a and scaled s, to the frame's instances for view v, like a 2D
  // drawImage with the transform (a b c d e f). False while its sprite isn't on the GPU yet.
  gpuPiece(i, x, y, a, s, v) {
    if (!this.sprites[i] || !this.gpu.has[i] || (this.gn + 1) * PIECE_FLOATS > this.gi.length) return false
    const z = v.z * this.dpr * s
    const c = Math.cos(a) * z
    const sn = Math.sin(a) * z
    const k = this.gn++ * PIECE_FLOATS
    const f = this.gi
    f[k] = c
    f[k + 1] = sn
    f[k + 2] = -sn
    f[k + 3] = c
    f[k + 4] = ((x - v.x) * v.z + v.w / 2) * this.dpr
    f[k + 5] = ((y - v.y) * v.z + v.h / 2) * this.dpr
    this.giu[k + 6] = i
    return true
  }

  // Where each lifted piece is drawn: fn(i, x, y, angle, scale). Lifted pieces grow a little,
  // spreading out from the pointer as they do, or from (cx, cy) off it when set (a tray's middle, in
  // the carried pieces' own frame, before any turn). Carried, each sits at its offset from the
  // pointer, turned with the carry and with what's left of a spin around its module's middle, and
  // of a gather (G). Landing after a drop, they shrink back to where they lie.
  liftPoses(fn) {
    const l = this.lift
    const s = 1 + 0.045 * l.value
    const d = this.drag && this.drag.set === l.set ? this.drag : null
    const a = d ? d.angle : l.angle
    // Growing around (cx, cy) moves the pointer's own spot by (1 - s) of the way to it, turned with
    // the pieces: (px, py) is where the carried pieces' origin is drawn, in world units.
    const gx = (l.cx || 0) * (1 - s)
    const gy = (l.cy || 0) * (1 - s)
    const px = l.px + gx * Math.cos(a) - gy * Math.sin(a)
    const py = l.py + gx * Math.sin(a) + gy * Math.cos(a)
    if (!d) {
      for (const i of l.ids) fn(i, px + (this.x[i] - l.px) * s, py + (this.y[i] - l.py) * s, this.r[i] * Q, s)
      return
    }
    const ca = Math.cos(d.angle)
    const sa = Math.sin(d.angle)
    for (let j = 0; j < d.ids.length; j++) {
      const t = d.sa[j]
      const dx = d.ox[j] - d.cx[j]
      const dy = d.oy[j] - d.cy[j]
      const ox = d.spinning ? d.cx[j] + dx * Math.cos(t) - dy * Math.sin(t) + d.tx[j] : d.ox[j]
      const oy = d.spinning ? d.cy[j] + dx * Math.sin(t) + dy * Math.cos(t) + d.ty[j] : d.oy[j]
      fn(d.ids[j], px + (ox * ca - oy * sa) * s, py + (ox * sa + oy * ca) * s, d.r0[j] * Q + (d.spinning ? t : 0) + d.angle, s)
    }
  }

  // Screen-space overlays: the selection box and the selected reference image's handles.
  drawChrome() {
    const { ctx, dpr, cam, vw, vh } = this
    const sel = this.refSel && this.refs.find((r) => r.id === this.refSel)
    if (sel) {
      this.dirty = true
      const [x0, y0, x1, y1] = this.refRect(sel)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = this.colors.sel
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
      ctx.fillStyle = this.colors.bg
      // No handle in the top right corner, which holds the menu button, and none while trimming.
      for (const [hx, hy] of this.trim
        ? []
        : [
            [x0, y0],
            [x0, y1],
            [x1, y1],
          ]) {
        ctx.beginPath()
        ctx.roundRect(hx - HANDLE / 2 - 1, hy - HANDLE / 2 - 1, HANDLE + 2, HANDLE + 2, 3)
        ctx.fill()
        ctx.stroke()
      }
    }
    // Trimming: what would be cut away is shaded, the part kept is outlined.
    const tb = sel && this.trim?.id === sel.id && this.trimRect()
    if (tb) {
      const [x0, y0, x1, y1] = this.refRect(sel)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.beginPath()
      ctx.rect(x0, y0, x1 - x0, y1 - y0)
      ctx.rect(tb[0], tb[1], tb[2] - tb[0], tb[3] - tb[1])
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
      ctx.fill('evenodd')
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 4])
      ctx.strokeStyle = this.colors.sel
      ctx.strokeRect(tb[0], tb[1], tb[2] - tb[0], tb[3] - tb[1])
      ctx.setLineDash([])
    }
    this.drawPops()
    this.drawCursors()
    const m = this.marquee
    if (m && Math.abs(m.sx - m.sx0) + Math.abs(m.sy - m.sy0) > 2) {
      const x = Math.min(m.sx0, m.sx)
      const y = Math.min(m.sy0, m.sy)
      const w = Math.abs(m.sx - m.sx0)
      const h = Math.abs(m.sy - m.sy0)
      this.dirty = true
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 0.1
      ctx.fillStyle = this.colors.sel
      ctx.fillRect(x, y, w, h)
      ctx.globalAlpha = 1
      ctx.lineWidth = 1
      ctx.strokeStyle = this.colors.sel
      ctx.strokeRect(x + 0.5, y + 0.5, w, h)
    }
  }

  // Where the pointer was, and how far the pieces were turned, u (0 to 1) of the way through frames.
  traceAt(f, u) {
    const at = f[0].t + (f[f.length - 1].t - f[0].t) * u
    let b = f.findIndex((q) => q.t >= at)
    if (b < 0) b = f.length - 1
    const a = Math.max(0, b - 1)
    const m = f[b].t > f[a].t ? Math.min(1, Math.max(0, (at - f[a].t) / (f[b].t - f[a].t))) : 1
    return {
      px: f[a].px + (f[b].px - f[a].px) * m,
      py: f[a].py + (f[b].py - f[a].py) * m,
      k: m < 0.5 ? f[a].k : f[b].k,
    }
  }

  // Draws what draw() makes with the pieces of a carry (see traces) as they were u (0 to 1) of the way
  // through it, then puts them back where they lie. For the spectator's replays.
  withTrace(trace, u, draw) {
    const { ids, ox, oy, r0, frames } = trace
    const keep = ids.map((i) => [this.x[i], this.y[i], this.r[i]])
    const { px, py, k } = this.traceAt(frames, u)
    // The last stretch eases into where they really ended up (the snap).
    const land = Math.max(0, (u - 0.88) / 0.12)
    for (let j = 0; j < ids.length; j++) {
      const i = ids[j]
      const [rx, ry] = rot(ox[j], oy[j], k)
      this.x[i] = px + rx + (keep[j][0] - px - rx) * land
      this.y[i] = py + ry + (keep[j][1] - py - ry) * land
      this.r[i] = mod4(r0[j] + k)
    }
    try {
      draw(px, py)
    } finally {
      for (let j = 0; j < ids.length; j++) [this.x[ids[j]], this.y[ids[j]], this.r[ids[j]]] = keep[j]
    }
  }

  // Other players' pointers, each with their name in a tag of their colour.
  // A ring and a few sparks growing out of each new seam, fading as they go. White with a soft
  // shadow, so they show on any picture.
  drawPops() {
    if (!this.livePops().length) return
    this.dirty = true
    this.paintPops(this.ctx, this.cam, this.vw, this.vh, this.pops, this.dpr)
  }

  // The bursts that are still showing.
  livePops() {
    const now = performance.now()
    return (this.pops = this.pops.filter((p) => now - p.t0 < POP_MS))
  }

  // Paints bursts (pops, or the spectator's own) on ctx for a view of vw by vh with camera cam.
  paintPops(ctx, cam, vw, vh, pops, dpr = this.dpr, scale = 1) {
    const now = performance.now()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
    ctx.shadowBlur = 4
    ctx.strokeStyle = '#fff'
    ctx.fillStyle = '#fff'
    const size = Math.max(8, Math.min(44, this.geo.S * cam.z * 0.4)) * scale
    for (const p of pops) {
      const t = (now - p.t0) / POP_MS
      if (t < 0) continue
      const e = 1 - (1 - t) ** 3
      const sx = (p.x - cam.x) * cam.z + vw / 2
      const sy = (p.y - cam.y) * cam.z + vh / 2
      ctx.globalAlpha = (1 - t) ** 1.5
      ctx.lineWidth = 2.5 * (1 - t) + 0.5
      ctx.beginPath()
      ctx.arc(sx, sy, size * (0.25 + 0.75 * e), 0, Math.PI * 2)
      ctx.stroke()
      const d = size * (0.35 + 1.05 * e)
      const r = 2.2 * (1 - t) + 0.4
      for (let k = 0; k < 6; k++) {
        const a = p.a + (k * Math.PI) / 3
        ctx.beginPath()
        ctx.arc(sx + Math.cos(a) * d, sy + Math.sin(a) * d, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'
  }

  // What the pointer is over, for showing buttons: 'ref:<id>', 'tray:<id>' or null.
  hoverKey({ rh, th }) {
    return rh ? `ref:${rh.ref.id}` : th ? `tray:${th.tray.id}` : null
  }

  setHovered(key) {
    if (this.hovered === key) return
    this.hovered = key
    this.invalidate()
  }

  // The context menu opened (kind, id) or closed (null) on a tray or image.
  setMenuFor(kind, id) {
    this.menuFor = kind === 'tray' || kind === 'ref' ? `${kind}:${id}` : null
    this.invalidate()
  }

  // Moves each tray's and image's buttons a frame's worth towards shown (hovered) or hidden.
  stepButtons() {
    const now = performance.now()
    const dt = Math.min(64, now - (this.btnT || now))
    this.btnT = now
    for (const key of [this.hovered, this.menuFor]) if (key && !this.btnShow.has(key)) this.btnShow.set(key, 0)
    let moving = false
    for (const [key, v] of this.btnShow) {
      const to = key === this.hovered || key === this.menuFor ? 1 : 0
      const next = to ? Math.min(1, v + dt / BTN_MS) : Math.max(0, v - dt / BTN_MS)
      if (!next && !to) this.btnShow.delete(key)
      else this.btnShow.set(key, next)
      if (next !== to) moving = true
    }
    if (moving) this.invalidate()
    else this.btnT = 0
  }

  // How shown a tray's or image's buttons are: { a, s }, the opacity and scale to draw them at, eased.
  // Null when hidden.
  buttonLook(key) {
    const v = this.btnShow.get(key)
    if (!v) return null
    const e = 1 - (1 - v) ** 3
    return { a: e, s: 0.75 + 0.25 * e }
  }

  // Sets octx to draw at scale s around the screen point (cx, cy).
  scaleAbout(octx, s, cx, cy) {
    const d = this.dpr
    octx.setTransform(d * s, 0, 0, d * s, d * cx * (1 - s), d * cy * (1 - s))
  }

  // Each image's menu button: three dots on a chip in the table's colour, so it reads on any image.
  drawRefButtons() {
    const octx = this.octx
    const { vw, vh } = this
    for (const ref of this.refs) {
      const look = this.buttonLook(`ref:${ref.id}`)
      const b = look && this.refButton(ref)
      if (!b) continue
      if (b[0] > vw || b[1] > vh || b[2] < 0 || b[3] < 0) continue
      this.drawMenuButton(b, look)
    }
    octx.globalAlpha = 1
    octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  // A menu button, the same on trays and images as on notes (.note-menu): three dots on a card.
  drawMenuButton([x0, y0, x1, y1], look) {
    const octx = this.octx
    const tag = x1 - x0
    this.scaleAbout(octx, look.s, (x0 + x1) / 2, (y0 + y1) / 2)
    octx.globalAlpha = look.a
    octx.beginPath()
    octx.roundRect(x0, y0, tag, y1 - y0, tag * 0.28)
    octx.shadowColor = 'rgba(0, 0, 0, 0.15)'
    octx.shadowBlur = tag * 0.28 * this.dpr
    octx.shadowOffsetY = tag * 0.08 * this.dpr
    octx.fillStyle = this.colors.card || this.colors.bg
    octx.fill()
    octx.shadowColor = 'transparent'
    octx.lineWidth = Math.max(1, tag * 0.056)
    octx.strokeStyle = this.colors.edge || 'rgba(0, 0, 0, 0.1)'
    octx.stroke()
    octx.fillStyle = this.colors.muted || '#888'
    for (const k of [-1, 0, 1]) {
      octx.beginPath()
      octx.arc((x0 + x1) / 2 + k * tag * 0.236, (y0 + y1) / 2, tag * 0.0625, 0, Math.PI * 2)
      octx.fill()
    }
  }

  // A tray's number, name and buttons along its top edge, above the notes and trays. They scale with
  // the zoom like everything on the table, but never get too small to read.
  drawTrayTags() {
    const octx = this.octx
    const { dpr, cam, vw, vh } = this
    const tag = Math.max(14, this.geo.S * 0.4 * cam.z)
    const gap = tag * 0.3
    // Names cut short to fit, by tray id: { rect, text }, so hovering one shows it in full.
    this.trayNames = new Map()
    const shown = this.trays.filter((t) => this.trayTagsFit(t))
    for (const t of shown) {
      const x = (t.x - cam.x) * cam.z + vw / 2
      const y = (t.y - cam.y) * cam.z + vh / 2
      if (x > vw || y > vh || x + t.w * cam.z < 0 || y + t.h * cam.z < 0) continue
      const color = TRAY_COLORS[t.color] || TRAY_COLORS.gray
      octx.setTransform(dpr, 0, 0, dpr, 0, 0)
      octx.textBaseline = 'middle'
      // The number and the name, each in a tag in the tray's colour on its top left corner, standing
      // out over the edges a little like the buttons on the right.
      const y0 = y - tag * BTN_OUT
      const mid = y0 + tag / 2 + tag * 0.03
      let x0 = x - tag * BTN_OUT
      if (t.num) {
        octx.beginPath()
        octx.roundRect(x0, y0, tag, tag, tag * 0.3)
        octx.fillStyle = color
        octx.fill()
        octx.fillStyle = '#fff'
        octx.font = `700 ${Math.round(tag * 0.6)}px system-ui, -apple-system, sans-serif`
        octx.textAlign = 'center'
        octx.fillText(String(t.num), x0 + tag / 2, mid)
        octx.textAlign = 'start'
        x0 += tag + gap * 0.6
      }
      const name = t.name?.trim()
      if (!name) continue
      const pad = tag * 0.3
      const x1 = this.trayButtons(t).auto[0] - gap * 0.6
      octx.font = `600 ${Math.round(tag * 0.55)}px system-ui, -apple-system, sans-serif`
      const text = fitText(octx, name, x1 - x0 - pad * 2)
      if (!text) continue
      const w = octx.measureText(text).width + pad * 2
      octx.beginPath()
      octx.roundRect(x0, y0, w, tag, tag * 0.3)
      octx.fillStyle = color
      octx.fill()
      octx.fillStyle = '#fff'
      octx.fillText(text, x0 + pad, mid)
      if (text !== name) this.trayNames.set(t.id, { rect: [x0, y0, x0 + w, y0 + tag], text: name })
    }
    for (const t of shown) {
      const look = this.buttonLook(`tray:${t.id}`)
      if (!look) continue
      const b = this.trayButtons(t)
      const [x0, y0, x1, y1] = b.auto
      const right = b.menu[2]
      if (x0 > vw || y0 > vh || right < 0 || y1 < 0) continue
      const color = TRAY_COLORS[t.color] || TRAY_COLORS.gray
      // Both buttons grow and fade in together: the switch from the middle of the two, the menu button
      // from its own.
      this.scaleAbout(octx, look.s, (x0 + right) / 2, (y0 + y1) / 2)
      // The auto sort switch beside it, on a solid background as it sits on the tray's border:
      // filled when on, an outline when off.
      octx.globalAlpha = look.a
      octx.fillStyle = this.colors.card || this.colors.bg
      octx.beginPath()
      octx.roundRect(x0, y0, x1 - x0, y1 - y0, tag * 0.3)
      octx.fill()
      octx.beginPath()
      octx.roundRect(x0, y0, x1 - x0, y1 - y0, tag * 0.3)
      if (t.auto) {
        octx.fillStyle = color
        octx.fill()
      } else {
        octx.globalAlpha = 0.7 * look.a
        octx.lineWidth = 1.25
        octx.strokeStyle = color
        octx.stroke()
        octx.globalAlpha = look.a
      }
      // A little grid of four squares: the pieces laid out.
      octx.fillStyle = t.auto ? '#fff' : color
      const pad = tag * 0.24
      const gap = tag * 0.1
      const cell = (tag - 2 * pad - gap) / 2
      for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        octx.beginPath()
        octx.roundRect(x0 + pad + cx * (cell + gap), y0 + pad + cy * (cell + gap), cell, cell, cell * 0.25)
        octx.fill()
      }
      // The menu button in the corner, like every menu button.
      this.drawMenuButton(b.menu, look)
    }
    octx.globalAlpha = 1
    octx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  drawCursors() {
    const ctx = this.octx
    if (!ctx) return
    if (this.cursorsDrawn) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, this.overlay.width, this.overlay.height)
    }
    this.cursorsDrawn = this.cursors.size > 0 || this.trays.length > 0 || this.refs.length > 0
    this.stepButtons()
    this.drawRefButtons()
    this.drawTrayTags()
    if (!this.cursors.size) return
    this.paintCursors(ctx, this.cam, this.vw, this.vh)
  }

  // Paints other players' pointers and selection boxes on ctx for a view of vw by vh with camera cam.
  paintCursors(ctx, cam, vw, vh, dpr = this.dpr) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = '600 11px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    // Selection boxes other players are dragging out, in their colours.
    for (const c of this.cursors.values()) {
      if (!c.box) continue
      const [ax, ay, bx, by] = c.box
      const x = (Math.min(ax, bx) - cam.x) * cam.z + vw / 2
      const y = (Math.min(ay, by) - cam.y) * cam.z + vh / 2
      const w = Math.abs(bx - ax) * cam.z
      const h = Math.abs(by - ay) * cam.z
      ctx.globalAlpha = 0.1
      ctx.fillStyle = c.color
      ctx.fillRect(x, y, w, h)
      ctx.globalAlpha = 1
      ctx.lineWidth = 1
      ctx.strokeStyle = c.color
      ctx.strokeRect(x + 0.5, y + 0.5, w, h)
    }
    for (const c of this.cursors.values()) {
      const x = (c.x - cam.x) * cam.z + vw / 2
      const y = (c.y - cam.y) * cam.z + vh / 2
      if (x < -150 || y < -40 || x > vw + 10 || y > vh + 10) continue
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x, y + 16)
      ctx.lineTo(x + 4.2, y + 12.2)
      ctx.lineTo(x + 7.2, y + 18.6)
      ctx.lineTo(x + 9.6, y + 17.5)
      ctx.lineTo(x + 6.7, y + 11.2)
      ctx.lineTo(x + 12, y + 11.2)
      ctx.closePath()
      ctx.fillStyle = c.color
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = '#fff'
      ctx.stroke()
      const tw = ctx.measureText(c.name).width
      const lx = x + 12
      const ly = y + 18
      ctx.beginPath()
      ctx.roundRect(lx, ly, tw + 12, 18, 5)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(c.name, lx + 6, ly + 9.5)
    }
  }
}
