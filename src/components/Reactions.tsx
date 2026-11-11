import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Engine } from '../lib/engine.ts'
import type { RoomSocket } from '../lib/api.ts'
import { fling } from '../lib/fling.ts'
import { isPlainKey, isTyping, overlays, useOverlay } from '../lib/overlays.ts'

const EMOJI = '👍'

// While the pointer is held down, a reaction is thrown every TICK_MS.
const TICK_MS = 60
// Upper bound on reactions in the air at once, so a crowd can't bog the page down.
const MAX = 240

// One reaction, thrown up and outwards from (sx, sy) and falling back under gravity.
function spawn(layer: HTMLElement, sx: number, sy: number) {
  if (layer.childElementCount >= MAX) return
  const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6
  const v = 260 + Math.random() * 260
  fling(layer, EMOJI, {
    x: sx,
    y: sy,
    vx: Math.cos(a) * v,
    vy: Math.sin(a) * v,
    g: 900,
    ms: 1100 + Math.random() * 500,
    size: 0.7 + Math.random() * 0.7,
    spin: (Math.random() - 0.5) * 540,
    fade: 0.3,
    from: 0.3,
  })
}

// Header button that turns reactions on. While they are on, pressing on the board throws them out of
// the pointer, for everyone in the room.
interface ReactionsProps {
  engine: Engine
  sock: RoomSocket
}

export default function Reactions({ engine, sock }: ReactionsProps) {
  const [on, setOn] = useState(false)
  const layer = useRef<HTMLDivElement>(null)
  const host = engine.canvas.parentElement!

  const burst = (sx: number, sy: number) => {
    if (layer.current) spawn(layer.current, sx, sy)
  }

  // A reaction thrown by another player, at (x, y) on the table.
  useEffect(() => sock.on('react', (msg) => engine.spotsOf(msg.x, msg.y).forEach(([x, y]) => burst(x, y))), [engine, sock])

  // R turns reactions on or off, unless a tray is selected: then it renames the tray (see the engine).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'r' || !isPlainKey(e) || isTyping(e) || overlays.modalOpen() || engine.renamesOnR()) return
      setOn((v) => !v)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [engine])

  useOverlay(on, () => setOn(false), { keepTyping: true })

  // While on, a left press on the board pours it instead of reaching the engine.
  useEffect(() => {
    if (!on) return
    const c = engine.canvas
    let stop: (() => void) | null = null
    const down = (e: PointerEvent) => {
      if (e.target !== c || e.button !== 0 || !e.isPrimary || stop) return
      e.stopPropagation()
      e.preventDefault()
      // On the canvas, across all the panes of a split screen.
      const at = (ev: PointerEvent) => engine.canvasPoint(ev.clientX, ev.clientY)
      let [sx, sy] = at(e)
      const move = (ev: PointerEvent) => {
        if (ev.pointerId === e.pointerId) [sx, sy] = at(ev)
      }
      const up = (ev: PointerEvent) => ev.pointerId === e.pointerId && stop!()
      const emit = () => {
        burst(sx, sy)
        const [x, y] = engine.worldAt(sx, sy)
        sock.send({ type: 'react', x: Math.round(x), y: Math.round(y) })
      }
      emit()
      const timer = setInterval(emit, TICK_MS)
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
      stop = () => {
        clearInterval(timer)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        stop = null
      }
    }
    host.addEventListener('pointerdown', down, true)
    return () => {
      host.removeEventListener('pointerdown', down, true)
      stop?.()
    }
  }, [engine, host, on])

  return (
    <span className="react-pick">
      <button
        className={`icon-btn${on ? ' on' : ''}`}
        onClick={() => setOn((v) => !v)}
        aria-label="Celebrate"
        aria-pressed={on}
        aria-keyshortcuts="R"
        data-tip={on ? 'Celebrate: press on the board to throw confetti. Click to stop' : 'Celebrate'}
        data-key="R"
      >
        <span className="react-emoji">{EMOJI}</span>
      </button>
      {createPortal(<div ref={layer} className="reactions" />, host)}
    </span>
  )
}
