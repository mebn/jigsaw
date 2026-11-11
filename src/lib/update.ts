// After a deploy, open pages keep running the code they loaded: the socket reconnects to the new
// server, but nothing reloads. The server says which build it serves (the script its page loads,
// named after its contents); a page running another one reloads itself as soon as that loses
// nothing: with no button held, no dialog open and no text field focused, right away in a
// background tab and otherwise once the player has been idle for a moment.

import { overlays } from './overlays.ts'

// How long (ms) without a press, key, wheel or pointer move counts as idle.
const IDLE_MS = 3000

// Kept from the start, so a press that began before a new build was announced still counts.
let last = performance.now()
let down = false
const opts = { capture: true, passive: true }
const touch = () => (last = performance.now())
for (const t of ['keydown', 'wheel']) window.addEventListener(t, touch, opts)
window.addEventListener('pointerdown', () => ((down = true), touch()), opts)
// A move says whether a button is still held, in case it was let go outside the window.
window.addEventListener('pointermove', (e) => ((down = e.buttons !== 0), touch()), opts)
for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, () => (down = false), opts)
window.addEventListener('blur', () => (down = false))

const busy = () => {
  const a = document.activeElement
  return down || overlays.modalOpen() || (a as HTMLElement | null)?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a?.tagName || '')
}

let pending = false

export function newBuild(build: string) {
  const own = document.querySelector('script[type="module"][src]')?.getAttribute('src')
  if (pending || !build || !own || build === own) return
  pending = true
  setInterval(() => {
    if (!busy() && (document.hidden || performance.now() - last > IDLE_MS)) location.reload()
  }, 1000)
}
