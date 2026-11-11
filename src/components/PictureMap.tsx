import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { isPlainKey, isTyping, useOverlay } from '../lib/overlays.ts'
import { store } from '../lib/storage.ts'
import { Close, Hand, Pencil, Trash } from './icons.tsx'

// The jigsaw's picture over the table, like a map: Q opens and closes it (see Room). It belongs to
// this player only. Wheel or pinch zooms, dragging pans, and with the pencil on dragging draws on the
// picture instead. Drawings are kept per jigsaw in this browser, until cleared.
//
// It is a window over the page (see overlays.ts), so the table and its shortcuts leave the keyboard to it.
// Its own keys: Q and Escape close, E switches between panning and drawing, C fits the picture to the
// screen, Cmd/Ctrl+Z undoes a line or a clear, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes it, with the
// map's own undo queue (see histories).

// One line drawn on the picture: points in the picture's pixels, flat as x, y, x, y, and its width
// in those pixels (so it grows and shrinks with the picture).
interface Line {
  pts: number[]
  w: number
}

// Where the picture is: its top left corner on the screen and how many screen pixels per picture pixel.
interface View {
  x: number
  y: number
  s: number
}

interface PictureMapProps {
  roomId: string
  src: string
  color: string
  closing?: boolean
  onClose: () => void
}

// The line width on the screen when drawn, and how much room the picture leaves around it when fit.
const LINE_PX = 3
const MARGIN = 48
const MAX_SCALE = 12

// The view until the picture has loaded and been placed; never remembered.
const UNPLACED: View = { x: 0, y: 0, s: 1 }

const key = (roomId: string) => `map:${roomId}`

// Undo and redo for the drawings, by jigsaw: the drawings before and after each change. Its own
// queue, apart from the table's undo (see the engine), and kept while the page is open, so closing
// and opening the map again can still undo.
interface History {
  undo: Line[][]
  redo: Line[][]
}
const histories = new Map<string, History>()

// Where the map was left, by jigsaw, kept in this browser: the point of the picture in the middle of
// the screen (in its pixels) and the zoom as a multiple of fitting it, so it holds when the window
// has changed size since.
interface Spot {
  cx: number
  cy: number
  z: number
}
const spotKey = (roomId: string) => `mapView:${roomId}`
function loadSpot(roomId: string): Spot | null {
  const v = store.json<Partial<Spot>>(spotKey(roomId))
  return v && [v.cx, v.cy, v.z].every((n) => typeof n === 'number' && isFinite(n)) && v.z! > 0 ? (v as Spot) : null
}
const historyOf = (roomId: string) => {
  let h = histories.get(roomId)
  if (!h) histories.set(roomId, (h = { undo: [], redo: [] }))
  return h
}

function loadLines(roomId: string): Line[] {
  const v = store.json<unknown>(key(roomId))
  return Array.isArray(v) ? (v as Line[]).filter((l) => Array.isArray(l?.pts) && typeof l.w === 'number') : []
}

const path = (pts: number[]) => {
  if (pts.length < 2) return ''
  let d = `M${pts[0]} ${pts[1]}`
  // A dot when the pointer didn't move.
  if (pts.length === 2) return `${d}h0.01`
  for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`
  return d
}

export default function PictureMap({ roomId, src, color, closing, onClose }: PictureMapProps) {
  const bg = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<View>(UNPLACED)
  const viewRef = useRef(view)
  viewRef.current = view
  const [draw, setDraw] = useState(false)
  const [lines, setLinesState] = useState<Line[]>(() => loadLines(roomId))
  const linesRef = useRef(lines)
  const hist = useRef(historyOf(roomId))
  const setLines = useCallback((next: Line[]) => {
    hist.current.undo.push(linesRef.current)
    hist.current.redo.length = 0
    linesRef.current = next
    setLinesState(next)
  }, [])
  const step = useCallback((back: boolean) => {
    const h = hist.current
    const prev = (back ? h.undo : h.redo).pop()
    if (!prev) return
    ;(back ? h.redo : h.undo).push(linesRef.current)
    linesRef.current = prev
    setLinesState(prev)
  }, [])
  // The line being drawn, in a ref too so letting go sees its last point before a render.
  const [cur, setCurState] = useState<Line | null>(null)
  const curRef = useRef<Line | null>(null)
  const setCur = (l: Line | null) => {
    curRef.current = l
    setCurState(l)
  }

  useEffect(() => {
    store.setJson(key(roomId), lines.length ? lines : null)
  }, [roomId, lines])

  // The view that fits the whole picture on the screen.
  const fitView = useCallback((): View | null => {
    const el = bg.current
    if (!el || !size) return null
    const W = el.clientWidth
    const H = el.clientHeight
    const s = Math.min((W - MARGIN * 2) / size.w, (H - MARGIN * 2) / size.h)
    return { x: (W - size.w * s) / 2, y: (H - size.h * s) / 2, s }
  }, [size])
  const fit = useCallback(() => {
    const v = fitView()
    if (v) setView(v)
  }, [fitView])
  // Opens where it was left, or fitted the first time.
  useLayoutEffect(() => {
    const fv = fitView()
    const el = bg.current
    if (!fv || !el) return
    const spot = loadSpot(roomId)
    if (!spot) return setView(fv)
    const s = fv.s * spot.z
    setView({ x: el.clientWidth / 2 - spot.cx * s, y: el.clientHeight / 2 - spot.cy * s, s })
  }, [fitView, roomId])
  // Remembers where it is, once the picture is shown.
  useEffect(() => {
    const fv = fitView()
    const el = bg.current
    if (!fv || !el || view === UNPLACED) return
    const spot: Spot = {
      cx: Math.round((el.clientWidth / 2 - view.x) / view.s),
      cy: Math.round((el.clientHeight / 2 - view.y) / view.s),
      z: Math.round((view.s / fv.s) * 1000) / 1000,
    }
    store.setJson(spotKey(roomId), spot)
  }, [view, fitView, roomId])

  // Zooms by f around a point on the screen (relative to the overlay), within limits.
  const zoomAt = useCallback(
    (f: number, px: number, py: number) => {
      const fv = fitView()
      if (!fv) return
      setView((v) => {
        const s = Math.min(Math.max(v.s * f, fv.s * 0.5), Math.max(MAX_SCALE, fv.s))
        const k = s / v.s
        return { x: px - (px - v.x) * k, y: py - (py - v.y) * k, s }
      })
    },
    [fitView],
  )

  useOverlay(!closing, onClose, { modal: true })
  useEffect(() => {
    if (closing) return
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return
      const k = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === 'z' || k === 'y')) {
        e.preventDefault()
        step(k === 'z' && !e.shiftKey)
        return
      }
      if (!isPlainKey(e)) return
      if (k === 'q') onClose()
      else if (k === 'e') setDraw((d) => !d)
      else if (k === 'c') fit()
      else if (k === '+' || k === '=' || k === '-' || k === '_') {
        const el = bg.current!
        zoomAt(k === '+' || k === '=' ? 1.4 : 1 / 1.4, el.clientWidth / 2, el.clientHeight / 2)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closing, onClose, fit, zoomAt, step])

  // Wheel zooms around the pointer; not passive, so the page doesn't scroll or zoom.
  useEffect(() => {
    const el = bg.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [zoomAt])

  // Pointers on the overlay, by id: where each is, for panning and pinching.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  // What the current gesture does, and whether it moved (a click outside the picture closes it).
  const gesture = useRef<{ kind: 'pan' | 'draw'; moved: boolean; outside: boolean } | null>(null)

  const local = (e: ReactPointerEvent) => {
    const r = bg.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const toPicture = (p: { x: number; y: number }) => {
    const v = viewRef.current
    return [Math.round(((p.x - v.x) / v.s) * 10) / 10, Math.round(((p.y - v.y) / v.s) * 10) / 10]
  }
  const onPicture = (p: { x: number; y: number }) => {
    const v = viewRef.current
    return !!size && p.x >= v.x && p.y >= v.y && p.x <= v.x + size.w * v.s && p.y <= v.y + size.h * v.s
  }

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('.map-tools')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = local(e)
    pointers.current.set(e.pointerId, p)
    if (pointers.current.size > 1) {
      // A second finger: pinch, and drop the line just started.
      setCur(null)
      gesture.current = { kind: 'pan', moved: true, outside: false }
      return
    }
    const drawing = draw && e.button === 0
    gesture.current = { kind: drawing ? 'draw' : 'pan', moved: false, outside: !onPicture(p) }
    if (drawing) setCur({ pts: toPicture(p), w: LINE_PX / viewRef.current.s })
  }

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId)
    const g = gesture.current
    if (!prev || !g) return
    const p = local(e)
    if (Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) > 0) g.moved = true
    if (pointers.current.size > 1) {
      // Pinch: the middle of the two fingers pans, their distance zooms.
      const [a, b] = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId).map(([, q]) => q)
      const other = a ?? b
      pointers.current.set(e.pointerId, p)
      if (!other) return
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y)
      const d1 = Math.hypot(p.x - other.x, p.y - other.y)
      const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 }
      const m1 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 }
      setView((v) => ({ ...v, x: v.x + m1.x - m0.x, y: v.y + m1.y - m0.y }))
      if (d0 > 0) zoomAt(d1 / d0, m1.x, m1.y)
      return
    }
    pointers.current.set(e.pointerId, p)
    if (g.kind === 'draw') {
      const [x, y] = toPicture(p)
      const c = curRef.current
      if (c) setCur({ ...c, pts: [...c.pts, x, y] })
    } else setView((v) => ({ ...v, x: v.x + p.x - prev.x, y: v.y + p.y - prev.y }))
  }

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return
    const g = gesture.current
    if (pointers.current.size) return
    gesture.current = null
    const line = curRef.current
    if (g?.kind === 'draw' && line) setLines([...linesRef.current, line])
    setCur(null)
    if (g && !g.moved && g.outside && g.kind === 'pan' && e.type === 'pointerup') onClose()
  }

  return createPortal(
    <div
      ref={bg}
      className={`modal-bg map-bg${draw ? ' drawing' : ''}${closing ? ' closing' : ''}`}
      role="dialog"
      aria-label="The picture"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="map-picture"
        style={{
          width: size?.w,
          height: size?.h,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          visibility: view === UNPLACED ? 'hidden' : 'visible',
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
        {size && (
          <svg viewBox={`0 0 ${size.w} ${size.h}`} width={size.w} height={size.h} aria-hidden="true">
            {[...lines, ...(cur ? [cur] : [])].map((l, i) => (
              <path key={i} d={path(l.pts)} stroke={color} strokeWidth={l.w} />
            ))}
          </svg>
        )}
      </div>
      <div className="float map-tools">
        <button
          className={`icon-btn${draw ? '' : ' on'}`}
          onClick={() => setDraw(false)}
          aria-pressed={!draw}
          aria-label="Move"
          data-tip="Move: drag to move the picture"
          data-key="E"
        >
          <Hand />
        </button>
        <button
          className={`icon-btn${draw ? ' on' : ''}`}
          onClick={() => setDraw(true)}
          aria-pressed={draw}
          aria-label="Draw"
          data-tip="Draw on the picture, only you see it"
          data-key="E"
        >
          <Pencil />
        </button>
        <button
          className="icon-btn"
          onClick={() => setLines([])}
          disabled={!lines.length}
          aria-label="Clear drawing"
          data-tip="Clear the drawing"
        >
          <Trash />
        </button>
        <span className="bar-sep" />
        <button className="icon-btn" onClick={onClose} aria-label="Close" data-tip="Close" data-key="Q">
          <Close />
        </button>
      </div>
    </div>,
    document.body,
  )
}
