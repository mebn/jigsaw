import { useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'

// A toolbar button that makes something on the table: drag it onto the board to put it there, or
// click to put it in the middle. onPlace(clientX, clientY) gets null for the middle. ghost is the
// class of what follows the pointer while dragging.
interface PlaceButtonProps {
  onPlace: (clientX: number | null, clientY: number | null) => void
  ghost: string
  label?: string
  shortcut?: string
  title?: string
  children?: ReactNode
}

export default function PlaceButton({ onPlace, ghost, label, shortcut, title, children }: PlaceButtonProps) {
  const [at, setAt] = useState<[number, number] | null>(null)

  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = [e.clientX, e.clientY]
    let moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) > 4) moved = true
      if (moved) setAt([ev.clientX, ev.clientY])
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setAt(null)
      if (!moved) return onPlace(null, null)
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      if (el && !el.closest('.float')) onPlace(ev.clientX, ev.clientY)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      <button className="icon-btn" onPointerDown={down} aria-label={label} aria-keyshortcuts={shortcut} data-tip={title} data-key={shortcut}>
        {children}
      </button>
      {at &&
        createPortal(<div className={ghost} style={{ transform: `translate(${at[0]}px, ${at[1]}px)` }} />, document.body)}
    </>
  )
}
