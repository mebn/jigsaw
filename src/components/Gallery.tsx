import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { RoomSummary } from '../../shared/protocol.ts'
import { navigate } from '../lib/router.ts'
import { infoLines } from './Card.tsx'
import { isTyping, overlays } from '../lib/overlays.ts'

// Fetches the jigsaw page's code ahead (App.tsx loads it lazily), so a jigsaw opened from here
// doesn't wait for it: once the page is idle, or as soon as the pointer is over a jigsaw.
let roomCode: Promise<unknown> | null = null
export const preloadRoom = () => {
  roomCode ??= import('../pages/Room.tsx').catch(() => {
    roomCode = null
  })
}

// The jigsaws page's gallery: a canvas that drags and scrolls up and down (but doesn't zoom), the
// jigsaws' pictures in columns, in sections under their headings, each section's list perhaps
// followed by a link to the whole of it. The jigsaws drift a little with the pointer, each by its own
// amount, and the one under it tilts towards it. A jigsaw's picture loads once it's near the screen.

// The canvas's columns and the gaps between them (CSS px), on wider screens and narrower ones.
const COL = 250
const COL_SMALL = 150
const GAP = 64
const GAP_SMALL = 28
// On narrower screens the columns widen to fill the screen, up to this (CSS px).
const COL_SMALL_MAX = 220
// The widest the columns spread on a wide screen, so they stay together in the middle (CSS px).
const MAX_WIDTH = 1600
// The caption under each jigsaw: the gap above it, and each of its lines (CSS px, see .art-info).
const CAPTION_TOP = 13
const CAPTION_LINE = 17
// A section's heading, with the room under it, and the extra room between the sections (CSS px).
const HEADING = 44
const BETWEEN = 72
// A link to a section's whole list under it: the room above it, and its height (CSS px).
const MORE_TOP = 8
const MORE_H = 36
// Room at the top of the screen for the bar and tabs, and at the bottom (CSS px).
const TOP = 112
const BOTTOM = 56
// How far the jigsaws drift with the pointer, at most (CSS px).
const DRIFT = 6
const SMALL = '(max-width: 600px)'

// Plain clicks open in place; modified clicks still open the jigsaw in a new tab or window.
export const plainClick = (e: MouseEvent) => !(e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)

export function useSmall() {
  const [small, setSmall] = useState(() => window.matchMedia(SMALL).matches)
  useEffect(() => {
    const m = window.matchMedia(SMALL)
    const on = () => setSmall(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return small
}

// A jigsaw's place on the canvas, its picture's size, and how much it drifts with the pointer.
export interface Placed {
  r: RoomSummary
  x: number
  y: number
  w: number
  h: number
  // Its caption's height.
  cap: number
  depth: number
  // Its place in the list, for coming in one after another.
  i: number
}

// How tall a jigsaw's picture is in a column col wide: as its shape, within reason.
const tallness = (r: RoomSummary, col: number) => col * Math.min(1.5, Math.max(0.55, r.height / (r.width || 1)))

// A section of the gallery: its heading, how many jigsaws it has in all (n), the ones shown, and
// where the whole list is when it has more than are shown.
export interface Section {
  title: string
  n: number
  rooms: RoomSummary[]
  more?: { label: string; path: string }
}

// A section's heading on the canvas, or the link to its whole list under it (more, w wide): where it
// starts, and what it says.
interface Label {
  x: number
  y: number
  title: string
  n: number
  w?: number
  more?: string
}

// The jigsaws in columns, as many as fit in width, section after section, each under its heading:
// the first level along the top, the next ones below the lowest jigsaw before them, every other
// column a little lower. A section with fewer jigsaws than columns uses only as many columns as it
// has jigsaws, in the middle, so a few don't spread out across the page. Each section's first row
// goes left to right, then each jigsaw goes in the shortest column so far. Columns are at least col
// wide, widening up to maxCol to fill the width. Each jigsaw's caption takes as many lines as it needs
// to fit under its picture. A section with more jigsaws than it shows has a link to them under it.
// Centred on 0, 0.
function layout(sections: Section[], minCol: number, maxCol: number, gap: number, width: number) {
  const fit = Math.max(1, Math.floor((width + gap) / (minCol + gap)))
  const col = Math.max(minCol, Math.min(maxCol, Math.floor((width - (fit - 1) * gap) / fit)))
  const step = col + gap
  const cols = Math.max(1, Math.min(fit, Math.max(0, ...sections.map((s) => s.rooms.length))))
  const w = cols * step - gap
  const stagger = (c: number) => (c % 2 ? step * 0.45 : 0)
  const labels: Label[] = []
  const placed: Placed[] = []
  // Where the next section starts.
  let bottom = 0
  sections.forEach((s, k) => {
    const n = s.rooms.length
    const top = k ? bottom + BETWEEN : 0
    const left = ((cols - Math.min(cols, n)) * step) / 2
    labels.push({ x: left, y: top, title: s.title, n: s.n })
    const heights = Array.from({ length: Math.min(cols, n) }, (_, c) => top + HEADING + (k ? stagger(c) : 0))
    s.rooms.forEach((r, j) => {
      const c = j < heights.length ? j : heights.indexOf(Math.min(...heights))
      const h = tallness(r, col)
      const cap = CAPTION_TOP + infoLines(r, col).length * CAPTION_LINE
      const i = placed.length
      placed.push({ r, x: left + c * step, y: heights[c], w: col, h, cap, depth: 0.4 + ((i * 7) % 10) / 10, i })
      heights[c] += h + cap + gap
    })
    bottom = Math.max(top + HEADING, ...heights) - gap
    if (s.more) {
      labels.push({ x: 0, y: bottom + MORE_TOP, title: s.more.label, n: 0, w, more: s.more.path })
      bottom += MORE_TOP + MORE_H
    }
  })
  for (const p of [...placed, ...labels]) {
    p.x -= w / 2
    p.y -= bottom / 2
  }
  return { placed, labels, w, h: bottom }
}

// Scrolling eases to where it's sent with this time constant (ms), so it glides to a stop, also at
// either end.
const EASE_MS = 70

// The canvas: scrolled, moved with the arrow keys, or on a touch screen dragged with a finger (with
// a little glide after), up and down only, and not zoomed. The mouse doesn't drag it. The jigsaws are in the middle across, and when they don't fit on the
// screen they can be moved until a gap past their top or bottom reaches the screen's. Scrolling eases
// smoothly to where it's sent, never past either end.
// render(p) makes the jigsaw for each place. It starts at the top again when start changes; jigsaws
// added at the end leave it where it is. onNearEnd is called while it's within a screen of its end, to
// add more.
// Memoised, so it only renders again when what it shows changes.
export const Canvas = memo(function Canvas({
  sections,
  start,
  render,
  onNearEnd,
}: {
  sections: Section[]
  start: string
  render: (p: Placed) => ReactNode
  onNearEnd?: () => void
}) {
  const small = useSmall()
  const col = small ? COL_SMALL : COL
  const maxCol = small ? COL_SMALL_MAX : COL
  const gap = small ? GAP_SMALL : GAP
  const field = useRef<HTMLDivElement>(null)
  // Everything on the canvas, moved as one as it scrolls; each jigsaw in it moves only to drift.
  const world = useRef<HTMLDivElement>(null)
  const cells = useRef<(HTMLDivElement | null)[]>([])
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight })
  const width = Math.min(view.w - 2 * gap, MAX_WIDTH)
  const { placed, labels, h: H } = useMemo(() => layout(sections, col, maxCol, gap, width), [sections, col, maxCol, gap, width])
  const heads = useRef<(HTMLElement | null)[]>([])
  const nearEnd = useRef(onNearEnd)
  nearEnd.current = onNearEnd
  // The jigsaws whose pictures have been asked for.
  const loaded = useRef(new WeakSet<HTMLDivElement>())

  // The canvas point in the middle of the screen, where it's easing to (ty), and how fast a finger's
  // glide carries it (px per ms). The pointer, from -1 to 1 across the screen, and where the jigsaws
  // have drifted to so far (following it).
  const cam = useRef({ x: 0, y: 0, ty: 0, vy: 0 })
  const mouse = useRef({ x: 0, y: 0, sx: 0, sy: 0 })
  const frame = useRef(0)
  // Where the canvas and each jigsaw and heading on it were last put, and whether a jigsaw was off
  // the screen, so only what changed is written.
  const shown = useRef(new WeakMap<HTMLElement, { x: number; y: number; hidden: boolean }>())
  const place = useRef<() => boolean>(() => false)
  place.current = () => {
    const el = field.current
    const all = world.current
    if (!el || !all) return false
    const vw = el.clientWidth
    const vh = el.clientHeight
    const c = cam.current
    const m = mouse.current
    m.sx += (m.x - m.sx) * 0.08
    m.sy += (m.y - m.sy) * 0.08
    // The canvas's middle on the screen.
    const ox = vw / 2 - c.x
    const oy = TOP + (vh - TOP - BOTTOM) / 2 - c.y
    const was = shown.current.get(all)
    if (!was || was.x !== ox || was.y !== oy) {
      all.style.transform = `translate3d(${ox}px, ${oy}px, 0)`
      shown.current.set(all, { x: ox, y: oy, hidden: false })
    }
    placed.forEach((p, k) => {
      const cell = cells.current[k]
      if (!cell) return
      // Rounded to a twentieth of a pixel, so the very end of a drift writes nothing.
      const x = Math.round((p.x - m.sx * DRIFT * p.depth) * 20) / 20
      const y = Math.round((p.y - m.sy * DRIFT * p.depth) * 20) / 20
      const sx = ox + x
      const sy = oy + y
      const hidden = sx > vw + 40 || sy > vh + 40 || sx + p.w < -40 || sy + p.h + p.cap < -40
      // Its picture loads once it's within a screen of being seen.
      if (!loaded.current.has(cell) && sy < 2 * vh && sy + p.h + p.cap > -vh) {
        loaded.current.add(cell)
        const img = cell.querySelector<HTMLImageElement>('img[data-src]')
        if (img && !img.getAttribute('src')) img.src = img.dataset.src!
      }
      let was = shown.current.get(cell)
      if (!was) {
        was = { x: NaN, y: NaN, hidden: !hidden }
        shown.current.set(cell, was)
      }
      if (was.hidden !== hidden) {
        cell.style.visibility = hidden ? 'hidden' : ''
        was.hidden = hidden
      }
      if (hidden || (was.x === x && was.y === y)) return
      cell.style.transform = `translate3d(${x}px, ${y}px, 0)`
      was.x = x
      was.y = y
    })
    labels.forEach((hd, k) => {
      const el = heads.current[k]
      const was = el && shown.current.get(el)
      if (!el || (was && was.x === hd.x && was.y === hd.y)) return
      el.style.transform = `translate3d(${hd.x}px, ${hd.y}px, 0)`
      shown.current.set(el, { x: hd.x, y: hd.y, hidden: false })
    })
    if (nearEnd.current && c.ty >= range().y[1] - vh) nearEnd.current()
    // Still drifting towards the pointer.
    return Math.abs(m.x - m.sx) + Math.abs(m.y - m.sy) > 0.002
  }
  const range = () => {
    const el = field.current
    const vh = (el?.clientHeight || view.h) - TOP - BOTTOM
    const side = (size: number, room: number) => (size + 2 * gap <= room ? [0, 0] : [-(size / 2 + gap) + room / 2, size / 2 + gap - room / 2])
    return { x: [0, 0], y: side(H, vh) }
  }
  const clamp = () => {
    const c = cam.current
    const r = range()
    c.x = Math.min(r.x[1], Math.max(r.x[0], c.x))
    c.y = Math.min(r.y[1], Math.max(r.y[0], c.y))
    c.ty = Math.min(r.y[1], Math.max(r.y[0], c.ty))
  }
  // The latest of each, for the handlers set up once below.
  const clampRef = useRef(clamp)
  clampRef.current = clamp
  const rangeRef = useRef(range)
  rangeRef.current = range
  const draw = useCallback(() => {
    cancelAnimationFrame(frame.current)
    const tick = () => {
      if (place.current()) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [])

  // A new set of jigsaws starts at the top, in the middle. The canvas is centred on its middle, so as
  // it grows (more jigsaws at the end) what's on the screen stays put by moving with half the growth.
  const height = useRef(H)
  useLayoutEffect(() => {
    cam.current = { x: 0, y: range().y[0], ty: range().y[0], vy: 0 }
    height.current = H
    place.current()
  }, [start, col])
  useLayoutEffect(() => {
    const c = cam.current
    const d = (H - height.current) / 2
    height.current = H
    c.y -= d
    c.ty -= d
    clampRef.current()
    place.current()
  }, [H, placed])

  useEffect(() => {
    const el = field.current!
    const ro = new ResizeObserver(() => {
      setView((v) => (v.w === el.clientWidth && v.h === el.clientHeight ? v : { w: el.clientWidth, h: el.clientHeight }))
      clampRef.current()
      place.current()
    })
    ro.observe(el)
    // Scrolling moves where the canvas is going (ty), never past either end, and it eases there each
    // frame. A finger moves it directly, and its glide after carries on the same way, ending at an end.
    let down: { id: number; x: number; y: number; t: number; moved: boolean } | null = null
    let dragged = false
    let gliding = false
    let raf = 0
    let last = 0
    const ends = () => rangeRef.current().y
    const move = (dy: number) => {
      const c = cam.current
      const [lo, hi] = ends()
      c.ty = Math.min(hi, Math.max(lo, c.ty + dy))
      run()
    }
    const step = (now: number) => {
      raf = 0
      const dt = Math.min(40, now - last)
      last = now
      const c = cam.current
      if (gliding) {
        const was = c.ty
        c.vy *= Math.pow(0.994, dt)
        move(c.vy * dt)
        // Stopped at an end, or slowed to nothing.
        if (c.ty === was || Math.abs(c.vy) < 0.02) gliding = false
      }
      c.y = down ? c.ty : c.y + (c.ty - c.y) * (1 - Math.exp(-dt / EASE_MS))
      if (Math.abs(c.ty - c.y) < 0.3) c.y = c.ty
      if (place.current()) draw()
      if (gliding || c.y !== c.ty) run()
    }
    const run = () => {
      if (raf) return
      if (!last || performance.now() - last > 100) last = performance.now()
      raf = requestAnimationFrame(step)
    }
    // A pinch on a trackpad comes as a wheel with ctrl: it does nothing here, rather than zoom the page.
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey) return
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      gliding = false
      cam.current.vy = 0
      move(e.deltaY * k)
    }
    const pointerdown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || e.button || (e.target as Element).closest('button')) return
      gliding = false
      cam.current.vy = 0
      // Caught mid-glide or mid-ease, it stays where it's shown.
      cam.current.ty = cam.current.y
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false }
      dragged = false
    }
    const pointermove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        mouse.current.x = (e.clientX / el.clientWidth) * 2 - 1
        mouse.current.y = (e.clientY / el.clientHeight) * 2 - 1
        if (!down) draw()
      }
      if (!down || e.pointerId !== down.id) return
      const dx = e.clientX - down.x
      const dy = e.clientY - down.y
      if (!down.moved && Math.hypot(dx, dy) < 5) return
      if (!down.moved) {
        down.moved = dragged = true
        el.setPointerCapture(e.pointerId)
        el.classList.add('dragging')
      }
      const now = performance.now()
      const dt = Math.max(1, now - down.t)
      const c = cam.current
      c.vy = c.vy * 0.6 + (-dy / dt) * 0.4
      down = { ...down, x: e.clientX, y: e.clientY, t: now }
      move(-dy)
    }
    const pointerup = (e: PointerEvent) => {
      if (!down || e.pointerId !== down.id) return
      const moved = down.moved
      // Held still for a moment before letting go: no glide.
      if (performance.now() - down.t > 80) cam.current.vy = 0
      down = null
      el.classList.remove('dragging')
      if (moved && cam.current.vy) gliding = true
      run()
    }
    // A drag doesn't open the jigsaw it started on.
    const click = (e: globalThis.MouseEvent) => {
      if (!dragged) return
      e.preventDefault()
      e.stopPropagation()
      dragged = false
    }
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || overlays.modalOpen() || isTyping(e)) return
      const d = ({ ArrowUp: -1, ArrowDown: 1, PageUp: -4, PageDown: 4 } as Record<string, number>)[e.key]
      if (!d) return
      e.preventDefault()
      gliding = false
      move(d * 160)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('pointerdown', pointerdown)
    el.addEventListener('pointermove', pointermove)
    el.addEventListener('pointerup', pointerup)
    el.addEventListener('pointercancel', pointerup)
    el.addEventListener('click', click, true)
    window.addEventListener('keydown', key)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      cancelAnimationFrame(frame.current)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('pointerdown', pointerdown)
      el.removeEventListener('pointermove', pointermove)
      el.removeEventListener('pointerup', pointerup)
      el.removeEventListener('pointercancel', pointerup)
      el.removeEventListener('click', click, true)
      window.removeEventListener('keydown', key)
    }
  }, [draw])

  return (
    <div ref={field} className="canvas" onPointerOver={preloadRoom} onPointerDown={preloadRoom}>
      <div ref={world} className="canvas-world">
        {placed.map((p, k) => (
          <div
            key={p.r.id}
            ref={(el) => {
              cells.current[k] = el
            }}
            className="cell"
            style={{ width: p.w }}
          >
            {render(p)}
          </div>
        ))}
        {labels.map((hd, k) =>
          hd.more ? (
            <a
              key={`more ${hd.more}`}
              ref={(el) => {
                heads.current[k] = el
              }}
              href={hd.more}
              className="cell canvas-more"
              style={{ width: hd.w }}
              onClick={(e) => {
                if (!plainClick(e)) return
                e.preventDefault()
                navigate(hd.more!)
              }}
            >
              <span>{hd.title}</span>
            </a>
          ) : (
            <div
              key={`${k} ${hd.title}`}
              ref={(el) => {
                heads.current[k] = el
              }}
              className="cell canvas-heading"
            >
              {hd.title}
              <span className="n">{hd.n}</span>
            </div>
          ),
        )}
      </div>
    </div>
  )
})
