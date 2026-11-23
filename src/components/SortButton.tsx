import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMenu } from '../lib/overlays.ts'
import { Chevron } from './icons.tsx'

// A button showing the order picked, opening a menu of the orders to pick another.
export default function SortButton<K extends string>({
  sorts,
  value,
  onChange,
}: {
  sorts: readonly { key: K; title: string }[]
  value: K
  onChange: (key: K) => void
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Below the button, kept on screen.
  useLayoutEffect(() => {
    const b = btn.current?.getBoundingClientRect()
    const m = menu.current
    if (!open || !b || !m) return setPos(null)
    setPos({ left: Math.max(4, Math.min(b.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 4)), top: b.bottom + 6 })
  }, [open])

  useMenu(open, () => setOpen(false), [menu, btn])
  // Focus goes to the chosen order once the menu is in place, and back to the button as it closes.
  const placed = !!pos
  useEffect(() => {
    if (!open || !placed) return
    const m = menu.current
    m?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    const b = btn.current
    return () => {
      if (m?.contains(document.activeElement)) b?.focus()
    }
  }, [open, placed])

  return (
    <div className="tabs">
      <button
        ref={btn}
        type="button"
        className={`tab sort-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Order: ${sorts.find((s) => s.key === value)?.title}`}
      >
        {sorts.find((s) => s.key === value)?.title}
        <Chevron />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="context-menu sort-menu"
            role="menu"
            aria-label="Order"
            style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
              e.preventDefault()
              const items = [...menu.current!.querySelectorAll<HTMLElement>('button')]
              const k = items.indexOf(document.activeElement as HTMLElement)
              items[(k + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
            }}
          >
            {sorts.map((s) => (
              <button
                key={s.key}
                role="menuitemradio"
                aria-checked={s.key === value}
                onClick={() => {
                  setOpen(false)
                  onChange(s.key)
                }}
              >
                {s.title}
                <span className="sort-menu-check" aria-hidden="true">
                  {s.key === value ? '✓' : ''}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
