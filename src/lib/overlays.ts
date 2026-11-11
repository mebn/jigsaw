import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'

// Everything open over the page that Escape closes: windows (modal: they keep the keyboard, and the
// player counts as away from the table) and lighter things such as menus and the draw mode. The last
// one opened is on top, and Escape closes it alone. With nothing open, Escape goes to the fallbacks
// (see useEscapeFallback), such as the table clearing its selection or the settings opening.

interface Overlay {
  close: () => void
  modal: boolean
  // Escape in a text field leaves it open, so a half filled form isn't lost.
  keepTyping: boolean
}

interface Fallback {
  // Handles an Escape nothing open took; returns whether it did anything with it.
  run: (e: KeyboardEvent) => boolean
  order: number
}

const stack: Overlay[] = []
const fallbacks: Fallback[] = []
const watchers = new Set<() => void>()
const changed = () => watchers.forEach((fn) => fn())

export const isTyping = (e: Event) => !!(e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
// Whether the window point (x, y) is on the table, not on the toolbars or the players over it.
export function onTable(x: number, y: number) {
  const el = document.elementFromPoint(x, y)
  return !!el && !el.closest('.float, .players')
}

// A key pressed on its own: no Ctrl, Cmd or Alt, and not held down.
export const isPlainKey = (e: KeyboardEvent) => !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey

export const overlays = {
  // A window is open over the page.
  modalOpen: () => stack.some((o) => o.modal),
  count: () => stack.length,
  // Calls fn whenever something opens or closes; returns a function that stops it.
  watch: (fn: () => void) => {
    watchers.add(fn)
    return () => {
      watchers.delete(fn)
    }
  },
}

// First, before anything else on the page sees the key.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return
    const top = stack.at(-1)
    if (top) {
      if (top.keepTyping && isTyping(e)) return
      top.close()
    } else if (isTyping(e) || !fallbacks.some((f) => f.run(e))) return
    e.preventDefault()
    e.stopImmediatePropagation()
  },
  true,
)

// Puts something on the overlay stack while open. Returns a function that says whether it is on top
// (the last one opened), for keys of its own that should only work then.
export function useOverlay(open: boolean, onClose: () => void, { modal = false, keepTyping = false } = {}) {
  const close = useRef(onClose)
  close.current = onClose
  const entry = useRef<Overlay | null>(null)
  useEffect(() => {
    if (!open) return
    const o: Overlay = { close: () => close.current(), modal, keepTyping }
    stack.push(o)
    entry.current = o
    changed()
    return () => {
      stack.splice(stack.indexOf(o), 1)
      entry.current = null
      changed()
    }
  }, [open, modal, keepTyping])
  return useCallback(() => !!entry.current && stack.at(-1) === entry.current, [])
}

// Handles Escape when nothing is open over the page; fallbacks with a higher order go first.
export function useEscapeFallback(run: ((e: KeyboardEvent) => boolean) | null, order: number) {
  const fn = useRef(run)
  fn.current = run
  const on = !!run
  useEffect(() => {
    if (!on) return
    const f: Fallback = { run: (e) => !!fn.current?.(e), order }
    fallbacks.push(f)
    fallbacks.sort((a, b) => b.order - a.order)
    return () => {
      fallbacks.splice(fallbacks.indexOf(f), 1)
    }
  }, [on, order])
}

// A menu or pop-up: on the overlay stack while open, and closed by a press outside the elements in
// inside, and with closeOnScroll by the wheel or the window losing focus too.
export function useMenu(open: boolean, onClose: () => void, inside: RefObject<Element | null>[], { closeOnScroll = true } = {}) {
  const close = useRef(onClose)
  close.current = onClose
  const within = useRef(inside)
  within.current = inside
  useEffect(() => {
    if (!open) return
    const shut = () => close.current()
    const away = (e: PointerEvent) => !within.current.some((r) => r.current?.contains(e.target as Node)) && shut()
    window.addEventListener('pointerdown', away, true)
    if (closeOnScroll) {
      window.addEventListener('wheel', shut, true)
      window.addEventListener('blur', shut)
    }
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('wheel', shut, true)
      window.removeEventListener('blur', shut)
    }
  }, [open, closeOnScroll])
  return useOverlay(open, onClose)
}
