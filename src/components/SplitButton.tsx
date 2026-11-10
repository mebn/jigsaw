import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Chevron, Split, Split3, Split4 } from './icons.tsx'

// How a split screen is cut up: in halves, a half and two quarters, or quarters (see the engine).
export type SplitPanes = 2 | 3 | 4

const LAYOUTS: { panes: SplitPanes; label: string; Icon: typeof Split }[] = [
  { panes: 2, label: '50% | 50%', Icon: Split },
  { panes: 3, label: '50% | 25% / 25%', Icon: Split3 },
  { panes: 4, label: '25% / 25% | 25% / 25%', Icon: Split4 },
]

interface SplitButtonProps {
  on: boolean
  panes: SplitPanes
  onToggle: () => void
  // A layout picked from the menu, which also turns split screen on.
  onPanes: (panes: SplitPanes) => void
}

// The split screen button: a click turns it on or off, the arrow beside it (or a right click on
// either) opens a menu of layouts, on the page itself since the toolbar would place it.
export default function SplitButton({ on, panes, onToggle, onPanes }: SplitButtonProps) {
  const group = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const Icon = LAYOUTS.find((l) => l.panes === panes)!.Icon

  // Below the button and its arrow, kept on screen.
  useLayoutEffect(() => {
    const b = group.current?.getBoundingClientRect()
    const m = menu.current
    if (!open || !b || !m) return setPos(null)
    setPos({
      left: Math.max(4, Math.min(b.left, window.innerWidth - m.offsetWidth - 4)),
      top: Math.min(b.bottom + 6, window.innerHeight - m.offsetHeight - 4),
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const away = (e: PointerEvent) => !menu.current?.contains(e.target as Node) && !group.current?.contains(e.target as Node) && close()
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      close()
      btn.current?.focus()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('blur', close)
    requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('blur', close)
    }
  }, [open])

  return (
    <span
      ref={group}
      className="split-btn"
      onContextMenu={(e) => {
        e.preventDefault()
        setOpen((v) => !v)
      }}
    >
      <button
        ref={btn}
        className={`icon-btn${on ? ' on' : ''}`}
        onClick={() => {
          setOpen(false)
          onToggle()
        }}
        aria-pressed={on}
        aria-label="Split screen"
        aria-keyshortcuts="X"
        data-tip={open ? undefined : 'Split screen'}
        data-key="X"
      >
        <Icon />
      </button>
      <button
        className={`icon-btn split-arrow${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Split screen layout"
        data-tip={open ? undefined : 'Split screen layout'}
      >
        <Chevron />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="context-menu split-menu"
            role="menu"
            aria-label="Split screen layout"
            style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
              e.preventDefault()
              const items = [...menu.current!.querySelectorAll<HTMLElement>('button')]
              const k = items.indexOf(document.activeElement as HTMLElement)
              items[(k + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
            }}
          >
            {LAYOUTS.map(({ panes: n, label, Icon: I }) => (
              <button
                key={n}
                role="menuitemradio"
                aria-checked={n === panes}
                onClick={() => {
                  setOpen(false)
                  onPanes(n)
                }}
              >
                <I className="split-menu-icon" />
                <span>{label}</span>
                <span className="split-menu-check" aria-hidden="true">
                  {n === panes ? '✓' : ''}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  )
}
