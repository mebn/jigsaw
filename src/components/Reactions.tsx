import { useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Engine } from '../lib/engine.ts'
import type { RoomMessage } from '../lib/api.ts'

const KIND = 'party'
const EMOJI = '👍'

// While the pointer is held down, this many reactions are thrown every TICK_MS.
const TICK_MS = 60
const PER_TICK = 1
// Upper bound on reactions in the air at once, so a crowd can't bog the page down.
const MAX = 240

// One reaction, thrown up and outwards from (sx, sy) and falling back under gravity.
function spawn(layer: HTMLElement, emoji: string, sx: number, sy: number) {
  if (layer.childElementCount >= MAX) return
  const el = document.createElement('span')
  el.className = 'reaction'
  el.textContent = emoji
  layer.appendChild(el)
  const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6
  const v = 260 + Math.random() * 260
  const vx = Math.cos(a) * v
  const vy = Math.sin(a) * v
  const ms = 1100 + Math.random() * 500
  const spin = (Math.random() - 0.5) * 540
  const size = 0.7 + Math.random() * 0.7
  const frames: Keyframe[] = []
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    const s = (t * ms) / 1000
    const x = sx + vx * s
    const y = sy + vy * s + 450 * s * s
    frames.push({
      transform: `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${spin * t}deg) scale(${i ? size : size * 0.3})`,
      opacity: t > 0.7 ? (1 - t) / 0.3 : 1,
    })
  }
  el.animate(frames, { duration: ms }).onfinish = () => el.remove()
}

// Header button that turns the celebration on. While it is on, pressing on the board pours confetti
// out of the pointer, for everyone in the room.
// A reaction thrown by another player, at (x, y) on the table.
export type ReactMessage = Extract<RoomMessage, { type: 'react' }>

interface ReactionsProps {
  engine: Engine
  busRef: RefObject<((msg: ReactMessage) => void) | null>
  hint?: ReactNode
}

export default function Reactions({ engine, busRef, hint }: ReactionsProps) {
  const [on, setOn] = useState(false)
  const layer = useRef<HTMLDivElement>(null)
  const host = engine.canvas.parentElement!

  const burst = (sx: number, sy: number) => {
    if (!layer.current) return
    for (let i = 0; i < PER_TICK; i++) spawn(layer.current, EMOJI, sx, sy)
  }

  useEffect(() => {
    busRef.current = (msg) => {
      for (const [x, y] of engine.spotsOf(msg.x, msg.y)) burst(x, y)
    }
    return () => {
      busRef.current = null
    }
  }, [engine, busRef])

  // R turns reactions on or off, unless a tray is selected: then it renames the tray (see the engine).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'r' && e.key !== 'R') return
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable]')) return
      if (document.querySelector('.modal-bg')) return
      if (engine?.traySel && !engine.sel.size) return
      setOn((v) => !v)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [engine])

  // While on, a left press on the board pours it instead of reaching the engine.
  useEffect(() => {
    if (!on) return
    const c = engine.canvas
    let stop: (() => void) | null = null
    const down = (e: PointerEvent) => {
      if (e.target !== c || e.button !== 0 || !e.isPrimary || stop) return
      e.stopPropagation()
      e.preventDefault()
      // On the canvas, across both panes of a split screen.
      const at = (ev: PointerEvent) => [ev.clientX - engine.rect.left, ev.clientY - engine.rect.top]
      let [sx, sy] = at(e)
      const move = (ev: PointerEvent) => {
        if (ev.pointerId === e.pointerId) [sx, sy] = at(ev)
      }
      const up = (ev: PointerEvent) => ev.pointerId === e.pointerId && stop!()
      const emit = () => {
        burst(sx, sy)
        const [x, y] = engine.worldAt(sx, sy)
        engine.send({ type: 'react', kind: KIND, x: Math.round(x), y: Math.round(y) })
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
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOn(false)
    host.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      host.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
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
        {hint}
      </button>
      {createPortal(<div ref={layer} className="reactions" />, host)}
    </span>
  )
}
