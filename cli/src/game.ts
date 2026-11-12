// A jigsaw being played: the table, the room's socket, and what the mouse and keys do. Joins the
// room like any page does, so everyone in it plays together.
import { cursorColor } from '../../src/lib/colors.ts'
import { mod4, rot } from '../../src/lib/geometry.ts'
import type { ClientMessage, PieceMove, RoomDetails, ServerMessage } from '../../shared/protocol.ts'
import { LoginDialog } from './dialog.ts'
import type { InputEvent } from './input.ts'
import { C, hex } from './screen.ts'
import type { Cells, Rgb, Scene, Terminal } from './screen.ts'
import type { Session } from './session.ts'
import { Table } from './table.ts'
import { View } from './view.ts'
import type { Marks, Picture } from './view.ts'

// What another page is carrying: the pieces, where each lies from their pointer, and how each was turned.
interface RemoteDrag {
  ids: number[]
  ox: number[]
  oy: number[]
  r0: number[]
  until: number
}

interface Drag {
  ids: number[]
  ox: number[]
  oy: number[]
  r0: number[]
  k: number
  // Where they were, for Esc.
  from: PieceMove[]
  mouse: boolean
  // Moved since it was picked up: only then does the edge of the screen move the table, so pressing
  // on a piece near the edge doesn't.
  moved?: boolean
}

const HELP = [
  'Mouse          drag pieces (right click turns them, the edge',
  '               of the screen moves the table), drag the table',
  '               to move around, wheel to zoom',
  'Arrows, WASD   move the pointer (Shift: faster)',
  'Enter or E     pick up / put down',
  'Space or R     turn (Shift+R: the other way)',
  'Esc            put back what you hold',
  'Tab            go to the next loose piece',
  '+ and -        zoom      F  see everything',
  'C              centre on the pointer',
  'L              log in or out',
  'Q              back to the jigsaws',
]

const r2 = (v: number) => Math.round(v * 100) / 100

// Holding a piece with the mouse this close to the edge of the screen (in cells) moves the table,
// as in the browser: PAN_SPEED cells a second, up to PAN_BOOST times as fast after PAN_RAMP ms.
const EDGE_COLS = 4
const EDGE_ROWS = 2
const PAN_SPEED = 40
const PAN_BOOST = 3.5
const PAN_RAMP = 1000

export class Game implements Scene {
  private term: Terminal
  private session: Session
  private room: RoomDetails
  private onExit: () => void
  private table: Table
  private view: View
  private clientId = Math.random().toString(36).slice(2)
  private px: number
  private py: number
  private drag: Drag | null = null
  private pan: { col: number; row: number; cx: number; cy: number } | null = null
  private help = false
  private flash = ''
  private flashUntil = 0
  private connected = false
  private lastTab = -1
  private remote = new Map<string, RemoteDrag>()
  private cursors = new Map<string, { x: number; y: number; name: string; color: Rgb; t: number }>()
  private ws: WebSocket | null = null
  private retry = 0
  private closed = false
  private queue: ClientMessage[] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private unlisten: () => void
  private cursorSent = 0
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  // Where the mouse is, in cells, and since when (and when last) the table was moved by the edge.
  private mouseAt: { col: number; row: number } | null = null
  private edgeSince = 0
  private edgeLast = 0

  constructor(term: Terminal, session: Session, room: RoomDetails, picture: Picture, onExit: () => void) {
    this.term = term
    this.session = session
    this.room = room
    this.onExit = onExit
    this.table = new Table(room)
    this.table.toTop(Array.from({ length: this.table.n }, (_, i) => i))
    this.view = new View(this.table, picture)
    this.view.cols = term.cols
    this.view.rows = term.rows
    this.view.fit()
    this.px = this.view.cx
    this.py = this.view.cy
    // Others' carried pieces count as dropped once they've gone quiet (see remoteHeld).
    this.timers.push(setInterval(() => term.invalidate(), 1000))
    this.timers.push(setInterval(() => this.edgePan(), 16))
    // A login (or logout) tells the room who's here now.
    this.unlisten = session.listen(() => this.send({ type: 'hello', passphrase: session.passphrase }))
    if (!session.me) this.say('Playing as a guest: press L to log in')
    this.open(false)
  }

  // Leaves the room.
  close() {
    if (this.closed) return
    if (this.drag) this.putDown()
    this.send({ type: 'cursor', hide: true })
    this.closed = true
    this.unlisten()
    for (const t of this.timers) clearInterval(t)
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    // Give what was just sent a moment to go out.
    const ws = this.ws
    setTimeout(() => ws?.close(), 100)
  }

  private say(text: string) {
    this.flash = text
    this.flashUntil = Date.now() + 3000
    this.term.invalidate()
    setTimeout(() => this.term.invalidate(), 3100)
  }

  // ---- the socket ----

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
    else if (msg.type === 'moves') this.queue.push(msg)
  }

  private open(again: boolean) {
    const ws = new WebSocket(`${this.session.origin.replace(/^http/, 'ws')}/api/ws?room=${encodeURIComponent(this.room.id)}&client=${this.clientId}`)
    this.ws = ws
    ws.onopen = async () => {
      this.retry = 0
      this.connected = true
      this.send({ type: 'hello', passphrase: this.session.passphrase })
      for (const msg of this.queue.splice(0)) this.send(msg)
      if (again) {
        // Catch up on what happened while away.
        try {
          const fresh = await this.session.room(this.room.id)
          if (!this.drag) this.table.load(fresh)
        } catch {}
      }
      this.term.invalidate()
    }
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMessage)
      } catch {}
    }
    ws.onclose = () => {
      this.connected = false
      this.term.invalidate()
      if (!this.closed) setTimeout(() => !this.closed && this.open(true), Math.min(5000, 300 * 2 ** this.retry++))
    }
  }

  // Groups others are carrying right now: nothing snaps onto them, and they're edged in their colour.
  private remoteHeld() {
    const now = Date.now()
    const m = new Map<number, Rgb>()
    for (const [client, d] of this.remote) {
      if (d.until < now) continue
      const c = this.cursors.get(client)?.color || hex(cursorColor(client))
      for (const i of d.ids) m.set(this.table.g[i], c)
    }
    return m
  }

  private onMessage(msg: ServerMessage) {
    if (msg.client === this.clientId) return
    const t = this.table
    const mine = new Set(this.drag?.ids || [])
    switch (msg.type) {
      case 'moves': {
        if (!msg.fix) this.remote.delete(msg.client)
        const list = (msg.pieces || []).filter((p) => !mine.has(p.i))
        for (const p of list) t.place(p)
        t.toTop(list.map((p) => p.i))
        if (t.groupCount() === 1) this.say('The jigsaw is finished!')
        break
      }
      case 'grab': {
        const n = msg.ids?.length
        if (!n || msg.ox?.length !== n || msg.oy?.length !== n || msg.r0?.length !== n) return
        if (!msg.ids!.every((i) => Number.isInteger(i) && i >= 0 && i < t.n)) return
        const d = { ids: msg.ids!, ox: msg.ox, oy: msg.oy, r0: msg.r0, until: 0 }
        this.remote.set(msg.client, d)
        t.toTop(d.ids)
        this.remoteLive(d, msg.px, msg.py, msg.k ?? 0, mine)
        break
      }
      case 'live': {
        const d = this.remote.get(msg.client)
        if (d) this.remoteLive(d, msg.px, msg.py, msg.k ?? 0, mine)
        break
      }
      case 'cursor':
        if (msg.hide) this.cursors.delete(msg.client)
        else if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
          const player = typeof msg.player === 'string' && msg.player ? msg.player : msg.client
          this.cursors.set(msg.client, { x: msg.x!, y: msg.y!, name: String(msg.name || '').slice(0, 32) || 'Guest', color: hex(cursorColor(player)), t: Date.now() })
        }
        break
      case 'gone':
        this.cursors.delete(msg.client)
        this.remote.delete(msg.client)
        break
      case 'player':
        t.learnPlayer(msg.player)
        break
      case 'presence':
        t.online = msg.online
        break
      case 'tray':
        t.setTray(msg.tray)
        break
      case 'tray-delete':
        t.trays.delete(msg.id)
        break
      case 'deleted':
        this.close()
        this.onExit()
        return
      default:
        return
    }
    this.term.invalidate()
  }

  private remoteLive(d: RemoteDrag, x: number, y: number, k: number, mine: Set<number>) {
    d.until = Date.now() + 2500
    d.ids.forEach((i, j) => {
      if (mine.has(i)) return
      const [ox, oy] = rot(d.ox[j], d.oy[j], k)
      this.table.x[i] = x + ox
      this.table.y[i] = y + oy
      this.table.r[i] = mod4(d.r0[j] + k)
    })
  }

  // ---- what this player does ----

  private sendCursor() {
    if (this.cursorTimer) return
    const go = () => {
      this.cursorTimer = null
      this.cursorSent = Date.now()
      const me = this.session.me
      this.send({ type: 'cursor', x: Math.round(this.px), y: Math.round(this.py), name: me?.name || 'Terminal', player: me?.id || '' })
      if (this.drag) this.send({ type: 'live', px: Math.round(this.px), py: Math.round(this.py), k: this.drag.k })
    }
    const since = Date.now() - this.cursorSent
    if (since > 50) go()
    else this.cursorTimer = setTimeout(go, 50 - since)
  }

  // Moves what's held to follow the pointer.
  private follow() {
    const d = this.drag
    if (!d) return
    d.ids.forEach((i, j) => {
      const [ox, oy] = rot(d.ox[j], d.oy[j], d.k)
      this.table.x[i] = this.px + ox
      this.table.y[i] = this.py + oy
      this.table.r[i] = mod4(d.r0[j] + d.k)
    })
  }

  private moveTo(x: number, y: number) {
    this.px = x
    this.py = y
    this.follow()
    this.sendCursor()
    this.term.invalidate()
  }

  // Keeps the pointer on the screen, moving the view when it gets near an edge.
  private keepInView() {
    const v = this.view
    const s = v.scale
    const mx = Math.min(v.pw / 4, 8) * s
    const my = Math.min(v.ph / 4, 6) * s
    const hw = (v.pw / 2) * s
    const hh = (v.ph / 2) * s
    if (this.px < v.cx - hw + mx) v.cx = this.px + hw - mx
    if (this.px > v.cx + hw - mx) v.cx = this.px - hw + mx
    if (this.py < v.cy - hh + my) v.cy = this.py + hh - my
    if (this.py > v.cy + hh - my) v.cy = this.py - hh + my
  }

  // Asks a guest to log in, as the website does when they first touch a piece.
  private needLogin() {
    if (this.session.me) return false
    this.term.push(new LoginDialog(this.term, this.session, () => {}, 'Pick a name or log in to move pieces.'))
    return true
  }

  // Picks up the group under the pointer. False when there's nothing there to pick up.
  private pickUp(mouse: boolean) {
    const t = this.table
    const i = this.view.pieceAt(this.px, this.py)
    if (i < 0) return false
    if (this.needLogin()) return true
    if (this.remoteHeld().has(t.g[i])) {
      this.say('Someone else is holding that')
      return true
    }
    const ids = t.members(t.g[i])
    const d: Drag = {
      ids,
      ox: ids.map((j) => t.x[j] - this.px),
      oy: ids.map((j) => t.y[j] - this.py),
      r0: ids.map((j) => t.r[j]),
      k: 0,
      from: ids.map((j) => ({ i: j, x: t.x[j], y: t.y[j], r: t.r[j], g: t.g[j] })),
      mouse,
    }
    this.drag = d
    t.toTop(ids)
    this.send({ type: 'grab', ids, ox: d.ox.map(r2), oy: d.oy.map(r2), r0: d.r0, px: r2(this.px), py: r2(this.py) })
    this.term.invalidate()
    return true
  }

  private putDown() {
    if (!this.drag) return
    const t = this.table
    const ids = this.drag.ids
    this.drag = null
    const before = t.groupCount()
    const changed = t.snap(ids, this.session.me?.id || null, new Set(this.remoteHeld().keys()))
    const carried = new Set(ids)
    const pieces: PieceMove[] = [...changed].map((i) => ({
      i,
      x: r2(t.x[i]),
      y: r2(t.y[i]),
      r: t.r[i],
      g: t.g[i],
      by: t.by[i],
      // What's carried leaves whatever tray it was in.
      ...(carried.has(i) ? { t: null } : {}),
    }))
    this.send({ type: 'moves', pieces })
    const groups = t.groupCount()
    if (groups === 1) this.say('The jigsaw is finished!')
    else if (groups < before) this.say('Click!')
    this.term.invalidate()
  }

  private putBack() {
    if (!this.drag) return
    for (const p of this.drag.from) this.table.place(p)
    this.send({ type: 'moves', pieces: this.drag.from })
    this.drag = null
    this.term.invalidate()
  }

  // Turns what's held, or the group under the pointer, a quarter turn (d: 1 clockwise, -1 not).
  private turn(d: number) {
    if (this.drag) {
      this.drag.k += d
      this.follow()
      this.send({ type: 'live', px: Math.round(this.px), py: Math.round(this.py), k: this.drag.k })
      this.term.invalidate()
      return
    }
    if (!this.pickUp(false) || !this.drag) return
    const drag = this.drag as Drag
    drag.k += d
    this.follow()
    this.putDown()
  }

  // Jumps the pointer to the next loose piece: one that isn't joined to anything yet.
  private nextLoose() {
    const t = this.table
    for (let k = 1; k <= t.n; k++) {
      const i = (this.lastTab + k) % t.n
      if (t.g[i] === i && t.onePiece(t.members(i))) {
        this.lastTab = i
        this.moveTo(t.x[i], t.y[i])
        this.keepInView()
        return
      }
    }
    this.say('No loose pieces left')
  }

  // Moves the table while a piece held with the mouse is near the edge of the screen, and the piece
  // along with it.
  private edgePan() {
    const now = Date.now()
    const m = this.mouseAt
    const d = this.drag
    const v = this.view
    const dir = (at: number, size: number, edge: number) => (at < edge ? -1 : at >= size - edge ? 1 : 0)
    const dx = m && d?.mouse && d.moved ? dir(m.col, v.cols, EDGE_COLS) : 0
    // The last row is the status line: the table ends above it.
    const dy = m && d?.mouse && d.moved ? dir(m.row, v.rows - 1, EDGE_ROWS) : 0
    if (!dx && !dy) {
      this.edgeSince = 0
      return
    }
    if (!this.edgeSince) this.edgeSince = this.edgeLast = now
    const dt = Math.min(64, now - this.edgeLast) / 1000
    this.edgeLast = now
    const speed = PAN_SPEED * (1 + (PAN_BOOST - 1) * Math.min(1, (now - this.edgeSince) / PAN_RAMP))
    // Cells are twice as tall as wide: rows move half as many cells for the same distance.
    v.cx += dx * speed * dt * v.scale
    v.cy += dy * speed * dt * v.scale
    const [x, y] = v.toTable(m!.col, m!.row)
    this.moveTo(x, y)
  }

  private leave() {
    this.close()
    this.onExit()
  }

  input(e: InputEvent) {
    const v = this.view
    if (e.kind === 'wheel') {
      const [x, y] = v.toTable(e.col, e.row)
      v.zoomBy(e.dir === 1 ? -1 : 1, x, y)
      this.term.invalidate()
      return
    }
    if (e.kind === 'mouse') {
      const [x, y] = v.toTable(e.col, e.row)
      this.mouseAt = { col: e.col, row: e.row }
      if (e.type === 'down') {
        // Right click while holding with the mouse turns what's held, as in the browser.
        if (e.button === 2 && this.drag?.mouse) this.turn(1)
        else if (e.button === 0 && !this.drag) {
          this.moveTo(x, y)
          if (!this.pickUp(true)) this.pan = { col: e.col, row: e.row, cx: v.cx, cy: v.cy }
        } else if (e.button === 0 && this.drag) this.putDown()
        else if (!this.drag) this.pan = { col: e.col, row: e.row, cx: v.cx, cy: v.cy }
      } else if (e.type === 'up') {
        // Only letting go of the left button drops what's held (not the right one after a turn).
        if (this.drag?.mouse && e.button === 0) this.putDown()
        if (e.button !== 2 || !this.drag) this.pan = null
      } else if (this.pan) {
        const s = v.scale
        v.cx = this.pan.cx - (e.col - this.pan.col) * s
        v.cy = this.pan.cy - (e.row - this.pan.row) * 2 * s
        this.term.invalidate()
      } else {
        if (this.drag?.mouse && e.type === 'drag') this.drag.moved = true
        this.moveTo(x, y)
      }
      return
    }
    const k = e.key
    if (this.help) {
      this.help = false
      this.term.invalidate()
      if (k === 'escape' || k === 'h' || k === '?') return
    }
    const step = v.scale * 2 * (e.shift ? 6 : 1)
    const dirs: Record<string, [number, number]> = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0],
      w: [0, -1],
      s: [0, 1],
      a: [-1, 0],
      d: [1, 0],
    }
    const dir = dirs[k.toLowerCase()]
    if (dir && !e.ctrl) {
      this.moveTo(this.px + dir[0] * step, this.py + dir[1] * step)
      this.keepInView()
      return
    }
    switch (k) {
      case 'q':
        return this.leave()
      case 'enter':
      case 'e':
        if (this.drag) this.putDown()
        else this.pickUp(false)
        return
      case ' ':
      case 'r':
        return this.turn(1)
      case 'R':
        return this.turn(-1)
      case 'escape':
        return this.putBack()
      case 'tab':
        return this.nextLoose()
      case 'l':
      case 'L':
        if (this.session.me) {
          this.session.logout()
          this.say('Logged out')
        } else this.term.push(new LoginDialog(this.term, this.session, (ok) => ok && this.say(`Playing as ${this.session.me?.name}`)))
        return
      case '+':
      case '=':
        v.zoomBy(1, this.px, this.py)
        break
      case '-':
      case '_':
        v.zoomBy(-1, this.px, this.py)
        break
      case 'f':
        v.fit()
        break
      case 'c':
        v.cx = this.px
        v.cy = this.py
        break
      case 'h':
      case '?':
        this.help = true
        break
      default:
        return
    }
    this.term.invalidate()
  }

  // ---- drawing ----

  draw(c: Cells) {
    const v = this.view
    const t = this.table
    v.cols = c.w
    v.rows = c.h
    const hover = this.drag ? -1 : v.pieceAt(this.px, this.py)
    const marks: Marks = {
      held: new Set(this.drag ? [t.g[this.drag.ids[0]]] : []),
      hover: hover >= 0 ? t.g[hover] : null,
      remote: this.remoteHeld(),
    }
    v.render(c, marks)
    const now = Date.now()
    for (const cur of this.cursors.values()) {
      if (now - cur.t > 60000) continue
      const [col, row] = v.toCell(cur.x, cur.y)
      if (row >= c.h - 1) continue
      c.put(col, row, '●', cur.color)
      c.text(col + 1, row, ` ${cur.name} `, C.white, cur.color, true)
    }
    const [col, row] = v.toCell(this.px, this.py)
    if (row < c.h - 1) c.put(col, row, '+', this.drag ? C.accent : C.white, undefined, true)
    if (this.help) {
      const w = Math.max(...HELP.map((l) => l.length)) + 4
      const top = Math.max(0, Math.floor((c.h - 1 - HELP.length - 4) / 2))
      const left = Math.max(0, Math.floor((c.w - w) / 2))
      const box = { col: left, row: top, w, h: HELP.length + 4 }
      c.fill(box, C.panel)
      c.frame(box, C.dim)
      c.text(left + 2, top, ' Keys ', C.text, C.panel, true)
      HELP.forEach((l, k) => c.text(left + 2, top + 2 + k, l, C.text, C.panel))
    }
    // The status line.
    const me = this.session.me
    const others = t.online.filter((p) => p !== me?.id).length
    const parts = [` ${this.room.name || 'Jigsaw'}`, `${Math.round(t.progress() * 100)}% of ${t.n}`]
    // Only players who are logged in are known to be here, not guests.
    if (!this.connected) parts.push('reconnecting…')
    else if (others) parts.push(`${others} other player${others === 1 ? '' : 's'} here`)
    parts.push(me ? me.name : 'guest', 'H keys', 'Q back')
    const flash = this.flash && now < this.flashUntil
    if (flash) parts.push(this.flash)
    c.text(0, c.h - 1, parts.join('  ·  ').padEnd(c.w), C.black, flash ? C.accent : C.dim, false, c.w)
  }
}
