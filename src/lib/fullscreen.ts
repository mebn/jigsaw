import { useEffect, useState } from 'react'

// The prefixed fullscreen API and the keyboard lock, which the DOM types leave out.
type WebkitDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | undefined }
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void> | undefined }
type KeyboardNavigator = Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void } }

// Fullscreen for the whole page (Safari still only has the prefixed version).
export const fullscreenEl = () => document.fullscreenElement || (document as WebkitDocument).webkitFullscreenElement || null
export const canFullscreen = () => {
  const el: WebkitElement = document.documentElement
  return !!(el.requestFullscreen || el.webkitRequestFullscreen)
}
export function toggleFullscreen() {
  if (fullscreenEl()) return (document.exitFullscreen || (document as WebkitDocument).webkitExitFullscreen)?.call(document)
  const el: WebkitElement = document.documentElement
  const go = el.requestFullscreen || el.webkitRequestFullscreen
  const done = go?.call(el, { navigationUI: 'hide' })
  // Normally Escape always leaves fullscreen. Where the browser lets us keep it (Chrome, Edge),
  // Escape does what it does outside fullscreen, and holding it down leaves fullscreen.
  done?.then?.(() => (navigator as KeyboardNavigator).keyboard?.lock?.(['Escape']).catch(() => {}), () => {})
}

// Browsers report no safe area for the notch on MacBooks, even in fullscreen. Those screens are
// 16:10 plus a strip at the top for the notch (1512x982 is 1512x945 and 37 more, at any scaling),
// so on a Mac the extra height over 16:10, if it is a few percent, is the notch.
function notchHeight() {
  if (!/Mac/.test(navigator.platform) || navigator.maxTouchPoints > 1) return 0
  const extra = screen.height - screen.width / 1.6
  return extra > screen.height * 0.025 && extra < screen.height * 0.055 ? Math.round(extra) : 0
}

export function useFullscreen() {
  const [on, setOn] = useState(() => !!fullscreenEl())
  useEffect(() => {
    const change = () => {
      setOn(!!fullscreenEl())
      if (!fullscreenEl()) (navigator as KeyboardNavigator).keyboard?.unlock?.()
    }
    document.addEventListener('fullscreenchange', change)
    document.addEventListener('webkitfullscreenchange', change)
    return () => {
      document.removeEventListener('fullscreenchange', change)
      document.removeEventListener('webkitfullscreenchange', change)
    }
  }, [])
  return on
}

// The notch's height in px while in fullscreen on a MacBook that has one, otherwise 0.
export function useNotch() {
  return useFullscreen() ? notchHeight() : 0
}
