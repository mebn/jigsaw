import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// How long the pointer rests on a button before its card shows (ms). Once one is showing, moving to
// the next button shows its card straight away.
const DELAY_MS = 350
const GAP = 8

// Hover cards for buttons, in place of the browser's own tooltips: any element with data-tip gets
// a small card under it (over it near the bottom of the window) with that text, and data-key as its
// shortcut. Shows for the mouse and for keyboard focus, not for touch.
interface Tip {
  el: HTMLElement
  text: string | undefined
  key: string | undefined
  rect: DOMRect
}

export default function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    let timer = 0
    let cur: HTMLElement | null = null
    let shown = false
    const read = (el: HTMLElement): Tip => ({ el, text: el.dataset.tip, key: el.dataset.key, rect: el.getBoundingClientRect() })
    const show = (el: HTMLElement, now: boolean) => {
      clearTimeout(timer)
      const go = () => {
        if (!el.isConnected || !el.dataset.tip) return
        shown = true
        setTip(read(el))
      }
      if (now) go()
      else timer = setTimeout(go, DELAY_MS)
    }
    const hide = () => {
      clearTimeout(timer)
      cur = null
      shown = false
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const el = (e.target as Element).closest?.<HTMLElement>('[data-tip]') || null
      if (el === cur) return
      if (!el) return hide()
      cur = el
      show(el, shown)
    }
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element).closest?.<HTMLElement>('[data-tip]')
      if (el && (e.target as Element).matches(':focus-visible')) {
        cur = el
        show(el, true)
      }
    }
    // The text can change while the card shows, as when a button is switched on with its shortcut.
    const mo = new MutationObserver(() => cur && shown && setTip(read(cur)))
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-tip', 'data-key'] })
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', hide)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      clearTimeout(timer)
      mo.disconnect()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', hide)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
    }
  }, [])

  // Under the button and centred on it, kept inside the window.
  useLayoutEffect(() => {
    if (!tip || !card.current) return setPos(null)
    const { width, height } = card.current.getBoundingClientRect()
    const r = tip.rect
    const below = r.bottom + GAP + height <= window.innerHeight - GAP
    const top = below ? r.bottom + GAP : r.top - GAP - height
    const left = Math.min(window.innerWidth - GAP - width, Math.max(GAP, r.left + r.width / 2 - width / 2))
    setPos({ top, left })
  }, [tip])

  if (!tip) return null
  return createPortal(
    <div
      ref={card}
      className="ui-tip"
      role="tooltip"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      <span>{tip.text}</span>
      {tip.key && <kbd>{tip.key}</kbd>}
    </div>,
    document.body,
  )
}
