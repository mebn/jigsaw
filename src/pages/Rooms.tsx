import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { api } from '../lib/api.ts'
import type { RoomSummary } from '../../shared/protocol.ts'
import { useApp } from '../lib/app.ts'
import { lastRoom, store } from '../lib/storage.ts'
import { navigate, paths } from '../lib/router.ts'
import { Back, Plus, Trash } from '../components/icons.tsx'
import { Art, ArtInfo, infoLines, Tile } from '../components/Card.tsx'
import Dialog from '../components/Dialog.tsx'
import Tabs from '../components/Tabs.tsx'
import Settings from '../components/Settings.tsx'
import Confirm from '../components/Confirm.tsx'
import NewRoom from './NewRoom.tsx'
import { useLinger } from '../lib/linger.ts'
import { warmGpu } from '../lib/gpu.ts'
import { isTyping, overlays } from '../lib/overlays.ts'

// The jigsaws page: a gallery on a canvas that drags and scrolls up and down (but doesn't zoom), the
// jigsaws' pictures in columns. Jigsaws in progress come first, with how far along they are under
// them; finished ones follow, with how long they took. The
// jigsaws drift a little with the pointer, each by its own amount, and the one under it tilts
// towards it. Opening a jigsaw, the page stays over it until its table is ready,
// then fades as the table zooms in (see App.tsx).

// How long the page takes to fade away over a jigsaw that opened (ms); matches the CSS.
export const GALLERY_OUT_MS = 450

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
// Room at the top of the screen for the bar and tabs, and at the bottom (CSS px).
const TOP = 112
const BOTTOM = 56
// How far the jigsaws drift with the pointer, at most (CSS px).
const DRIFT = 6
const SMALL = '(max-width: 600px)'

// Plain clicks open in place; modified clicks still open the jigsaw in a new tab or window.
const plainClick = (e: MouseEvent) => !(e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)

function useSmall() {
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
interface Placed {
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

// A section's heading on the canvas: where it starts, and what it says.
interface Heading {
  x: number
  y: number
  title: string
  n: number
}

// The jigsaws in columns, as many as fit in width. Those in progress come first under their
// heading, level along the top; the finished ones start under theirs, below the lowest of them,
// every other column a little lower. A section with fewer jigsaws than columns uses only as many
// columns as it has jigsaws, in the middle, so a few don't spread out across the page. Each
// section's first row goes left to right, then each jigsaw goes in the shortest column so far.
// Columns are at least col wide, widening up to maxCol to fill the width. Each jigsaw's caption
// takes as many lines as it needs to fit under its picture. Centred on 0, 0.
function layout(list: RoomSummary[], minCol: number, maxCol: number, gap: number, width: number) {
  const count = (done: boolean) => list.filter((o) => o.done === done).length
  const fit = Math.max(1, Math.floor((width + gap) / (minCol + gap)))
  const col = Math.max(minCol, Math.min(maxCol, Math.floor((width - (fit - 1) * gap) / fit)))
  const step = col + gap
  const cols = Math.max(1, Math.min(fit, Math.max(count(false), count(true))))
  const stagger = (c: number) => (c % 2 ? step * 0.45 : 0)
  let heights: number[] = []
  let left = 0
  let start = 0
  const headings: Heading[] = []
  const section = (done: boolean, i: number) => {
    const n = count(done)
    const top = headings.length ? Math.max(...heights) - gap + BETWEEN : 0
    left = ((cols - Math.min(cols, n)) * step) / 2
    start = i
    headings.push({ x: left, y: top, title: done ? 'Finished' : 'In progress', n })
    heights = Array.from({ length: Math.min(cols, n) }, (_, c) => top + HEADING + (done ? stagger(c) : 0))
  }
  const placed: Placed[] = list.map((r, i) => {
    if (!i || r.done !== list[i - 1].done) section(r.done, i)
    const c = i - start < heights.length ? i - start : heights.indexOf(Math.min(...heights))
    const h = tallness(r, col)
    const cap = CAPTION_TOP + infoLines(r, col).length * CAPTION_LINE
    const at = { r, x: left + c * step, y: heights[c], w: col, h, cap, depth: 0.4 + ((i * 7) % 10) / 10, i }
    heights[c] += h + cap + gap
    return at
  })
  const w = cols * step - gap
  const h = Math.max(...heights) - gap
  for (const p of [...placed, ...headings]) {
    p.x -= w / 2
    p.y -= h / 2
  }
  return { placed, headings, w, h }
}

type TabKey = 'all' | 'public' | 'private'
const TABS: { key: TabKey; title: string; hint: string; test: (r: RoomSummary) => boolean }[] = [
  { key: 'all', title: 'All', hint: 'All jigsaws', test: () => true },
  { key: 'public', title: 'Public', hint: 'Public jigsaws', test: (r) => !r.private },
  { key: 'private', title: 'Private', hint: 'Private jigsaws', test: (r) => !!r.private },
]

// Scrolling eases to where it's sent with this time constant (ms), so it glides to a stop, also at
// either end.
const EASE_MS = 70

// The canvas: scrolled, moved with the arrow keys, or on a touch screen dragged with a finger (with
// a little glide after), up and down only, and not zoomed. The mouse doesn't drag it. The jigsaws are in the middle across, and when they don't fit on the
// screen they can be moved until a gap past their top or bottom reaches the screen's. Scrolling eases
// smoothly to where it's sent, never past either end.
// render(p) makes the jigsaw for each place.
function Canvas({ list, col, maxCol, gap, render }: { list: RoomSummary[]; col: number; maxCol: number; gap: number; render: (p: Placed) => ReactNode }) {
  const field = useRef<HTMLDivElement>(null)
  const cells = useRef<(HTMLDivElement | null)[]>([])
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight })
  const { placed, headings, w: W, h: H } = layout(list, col, maxCol, gap, Math.min(view.w - 2 * gap, MAX_WIDTH))
  const heads = useRef<(HTMLDivElement | null)[]>([])
  const key = list.map((r) => r.id).join() + col + W

  // The canvas point in the middle of the screen, where it's easing to (ty), and how fast a finger's
  // glide carries it (px per ms). The pointer, from -1 to 1 across the screen, and where the jigsaws
  // have drifted to so far (following it).
  const cam = useRef({ x: 0, y: 0, ty: 0, vy: 0 })
  const mouse = useRef({ x: 0, y: 0, sx: 0, sy: 0 })
  const frame = useRef(0)
  const place = useRef<() => boolean>(() => false)
  place.current = () => {
    const el = field.current
    if (!el) return false
    const vw = el.clientWidth
    const vh = el.clientHeight
    const cx = vw / 2
    const cy = TOP + (vh - TOP - BOTTOM) / 2
    const c = cam.current
    const m = mouse.current
    m.sx += (m.x - m.sx) * 0.08
    m.sy += (m.y - m.sy) * 0.08
    placed.forEach((p, k) => {
      const cell = cells.current[k]
      if (!cell) return
      const sx = cx + p.x - c.x - m.sx * DRIFT * p.depth
      const sy = cy + p.y - c.y - m.sy * DRIFT * p.depth
      cell.style.transform = `translate3d(${sx}px, ${sy}px, 0)`
      cell.style.visibility = sx > vw + 40 || sy > vh + 40 || sx + p.w < -40 || sy + p.h + p.cap < -40 ? 'hidden' : ''
    })
    headings.forEach((hd, k) => {
      const el = heads.current[k]
      if (el) el.style.transform = `translate3d(${cx + hd.x - c.x}px, ${cy + hd.y - c.y}px, 0)`
    })
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
  const clampRef = useRef(clamp)
  clampRef.current = clamp
  const draw = useCallback(() => {
    cancelAnimationFrame(frame.current)
    const tick = () => {
      if (place.current()) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [])

  // A new set of jigsaws starts at the top, in the middle.
  useLayoutEffect(() => {
    cam.current = { x: 0, y: range().y[0], ty: range().y[0], vy: 0 }
    place.current()
  }, [key])

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
    const ends = () => range().y
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
    <div ref={field} className="canvas">
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
      {headings.map((hd, k) => (
        <div
          key={hd.title}
          ref={(el) => {
            heads.current[k] = el
          }}
          className="cell canvas-heading"
        >
          {hd.title}
          <span className="n">{hd.n}</span>
        </div>
      ))}
    </div>
  )
}

interface GalleryProps {
  // On the jigsaws page (false while it waits over a jigsaw that is opening).
  here: boolean
  closing: boolean
  // The new jigsaw form is open over it (/new).
  newOpen: boolean
}

export default function Gallery({ here, closing, newOpen }: GalleryProps) {
  const { player, playerId, openLogin } = useApp()
  // WebGPU starts now, so a jigsaw opened from here shows sooner.
  useEffect(() => {
    warmGpu().catch(() => {})
  }, [])
  // The jigsaws, null while they load, or 'failed'.
  const [rooms, setRooms] = useState<RoomSummary[] | 'failed' | null>(null)
  const small = useSmall()
  // The jigsaw to go back to, as it was when the page opened: it stays while the page fades over a
  // jigsaw that is opening, so the bar in the top left doesn't change before it goes.
  const [last, setLast] = useState(lastRoom.get)
  // Which jigsaws show, kept in this browser.
  const [tab, setTabState] = useState(() =>
    TABS.some((t) => t.key === store.get('roomsTab')) ? (store.get('roomsTab') as TabKey) : 'all',
  )
  const setTab = (key: TabKey) => {
    store.set('roomsTab', key)
    setTabState(key)
  }
  const shown = TABS.find((t) => t.key === tab)!.test

  const load = useCallback(
    () =>
      api
        .rooms(player?.passphrase)
        .then(setRooms)
        .catch(() => setRooms('failed')),
    [player?.passphrase],
  )
  useEffect(() => {
    load()
  }, [load])

  // A jigsaw was clicked: the page fades and its table zooms in (see App.tsx and Room.tsx).
  const pick = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (!plainClick(e)) return
    e.preventDefault()
    if (here) navigate(paths.room(id))
  }

  // The jigsaw waiting for a yes in the delete dialog.
  const [doomed, setDoomed] = useState<RoomSummary | null>(null)
  const keep = useCallback(() => setDoomed(null), [])
  const remove = async (room: RoomSummary) => {
    setDoomed(null)
    try {
      await api.remove(room.id, player?.passphrase)
    } catch {
      return load()
    }
    lastRoom.forget(room.id)
    if (last === room.id) setLast(null)
    load()
  }

  const closeNew = useCallback(() => navigate(paths.rooms), [])
  const [newShown, newClosing] = useLinger(newOpen)
  // Where in the new jigsaw window's header its Create button goes (see NewRoom).
  const [createSlot, setCreateSlot] = useState<HTMLDivElement | null>(null)

  const list = Array.isArray(rooms) ? rooms : []
  const progress = list.filter((r) => shown(r) && !r.done)
  const finished = list.filter((r) => shown(r) && r.done)
  const col = small ? COL_SMALL : COL
  const gap = small ? GAP_SMALL : GAP
  // Each jigsaw's picture, with how long it took under it when finished, or how far along it is.
  const render = (p: Placed) => (
    <Tile
      r={p.r}
      i={p.i}
      onPick={pick}
      below={<ArtInfo r={p.r} width={p.w} />}
      extra={
        !!playerId &&
        p.r.owner === playerId && (
          <button
            className="icon-btn del"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDoomed(p.r)
            }}
            aria-label="Delete"
            data-tip="Delete jigsaw"
          >
            <Trash />
          </button>
        )
      }
    >
      <Art r={p.r} w={p.w} h={p.h} />
    </Tile>
  )

  return (
    <div className={`gallery${!here ? ' going' : ''}${closing ? ' closing' : ''}`}>
      <header className="gallery-head">
        <div className="float">
          {last && (
            <button className="icon-btn" onClick={() => navigate(paths.room(last))} aria-label="Back to the jigsaw" data-tip="Back to the jigsaw">
              <Back />
            </button>
          )}
          <Settings />
        </div>
        <h1>Jigsaws</h1>
        <div className="gallery-actions">
          {!player && (
            <button className="secondary small" onClick={openLogin}>
              Log in
            </button>
          )}
          <button className="primary new-btn" onClick={() => navigate(paths.new)}>
            <span>New jigsaw</span>
            <Plus />
          </button>
        </div>
      </header>
      <div className="gallery-tabs">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Show jigsaws" />
      </div>

      {!rooms ? (
        <div className="gallery-empty" aria-busy="true" aria-label="Loading jigsaws">
          <span className="spin" />
        </div>
      ) : rooms === 'failed' ? (
        <section className="gallery-empty">
          <p>Couldn't load the jigsaws.</p>
          <button className="secondary" onClick={load}>
            Try again
          </button>
        </section>
      ) : !rooms.length ? (
        <section className="gallery-empty">
          <p>No jigsaws yet.</p>
          <button className="primary" onClick={() => navigate(paths.new)}>
            Make the first one
          </button>
        </section>
      ) : !progress.length && !finished.length ? (
        <section className="gallery-empty">
          <p>No {tab} jigsaws.</p>
        </section>
      ) : (
        <Canvas list={[...progress, ...finished]} col={col} maxCol={small ? COL_SMALL_MAX : COL} gap={gap} render={render} />
      )}

      {newShown && (
        <Dialog
          title="New jigsaw"
          className="sheet new-sheet"
          bg="sheet-bg"
          onClose={closeNew}
          closing={newClosing}
          keepTyping
          actions={<div className="create-slot" ref={setCreateSlot} />}
        >
          <NewRoom slot={createSlot} />
        </Dialog>
      )}
      {doomed && (
        <Confirm
          title="Delete this jigsaw?"
          text="The jigsaw and everything on its table goes for everyone. This can't be undone."
          action="Delete"
          danger
          onCancel={keep}
          onConfirm={() => remove(doomed)}
        />
      )}
    </div>
  )
}
