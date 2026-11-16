import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

// The smallest a pane can be dragged to, in CSS pixels.
const MIN_PANE = 120

// Where the lines between split screen panes are, as fractions of the table: down at x, across at y.
export interface SplitCut {
  x: number
  y: number
}

// The lines between the panes of split screen (see Engine.setCut()), each dragged to make the panes
// beside it bigger or smaller. A double click puts it back in the middle. The line across shows with
// three or four panes. Place them with the room's --cut-x and --cut-y.
export default function SplitLines({ across, cut, onCut }: { across: boolean; cut: SplitCut; onCut: (cut: SplitCut) => void }) {
  const drag = useRef<{ pointer: number; axis: 'x' | 'y'; rect: DOMRect } | null>(null)

  const down = (axis: 'x' | 'y') => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const room = e.currentTarget.parentElement
    if (!room) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { pointer: e.pointerId, axis, rect: room.getBoundingClientRect() }
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointer) return
    const size = d.axis === 'x' ? d.rect.width : d.rect.height
    const at = d.axis === 'x' ? e.clientX - d.rect.left : e.clientY - d.rect.top
    const min = Math.min(0.5, MIN_PANE / Math.max(1, size))
    const f = Math.min(1 - min, Math.max(min, at / Math.max(1, size)))
    onCut({ ...cut, [d.axis]: f })
  }
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null
  }
  const line = (axis: 'x' | 'y') => (
    <div
      className={`split-line${axis === 'y' ? ' across' : ''}`}
      onPointerDown={down(axis)}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDoubleClick={() => onCut({ ...cut, [axis]: 0.5 })}
    />
  )
  return (
    <>
      {line('x')}
      {across && line('y')}
    </>
  )
}
