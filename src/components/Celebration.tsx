import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const EMOJI = '🎉'
// Emojis shot from each bottom corner.
const CANNON = 70
const MS = 4200

// One emoji following a thrown arc: starts at (x, y) with velocity (vx, vy) px/s under gravity g.
interface Arc {
  x: number
  y: number
  vx: number
  vy: number
  g: number
  ms: number
  delay: number
  size: number
  spin: number
}

function arc(layer: HTMLElement, { x, y, vx, vy, g, ms, delay, size, spin }: Arc) {
  const el = document.createElement('span')
  el.className = 'reaction'
  el.textContent = EMOJI
  layer.appendChild(el)
  const frames: Keyframe[] = []
  for (let i = 0; i <= 16; i++) {
    const t = i / 16
    const s = (t * ms) / 1000
    frames.push({
      transform: `translate(${x + vx * s}px, ${y + vy * s + (g * s * s) / 2}px) translate(-50%, -50%) rotate(${spin * t}deg) scale(${size})`,
      opacity: t > 0.85 ? (1 - t) / 0.15 : 1,
    })
  }
  const anim = el.animate(frames, { duration: ms, delay, fill: 'backwards' })
  anim.onfinish = () => el.remove()
}

// A full screen burst of party poppers, played once when a jigsaw is finished.
interface CelebrationProps {
  onDone: () => void
}

export default function Celebration({ onDone }: CelebrationProps) {
  const layer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = layer.current!
    const W = window.innerWidth
    const H = window.innerHeight
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const k = calm ? 0.25 : 1
    const g = H * 1.1
    for (const side of [-1, 1]) {
      for (let i = 0; i < CANNON * k; i++) {
        // Aim up and in towards the middle, high enough to reach most of the screen.
        const a = -Math.PI / 2 - side * (0.15 + Math.random() * 0.55)
        const v = Math.sqrt(2 * g * H * (0.55 + Math.random() * 0.45))
        arc(el, {
          x: side < 0 ? 0 : W,
          y: H,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          g,
          ms: 2200 + Math.random() * 900,
          delay: Math.random() * 700,
          size: 0.9 + Math.random() * 1.1,
          spin: (Math.random() - 0.5) * 900,
        })
      }
    }
    const timer = setTimeout(onDone, MS)
    return () => clearTimeout(timer)
  }, [onDone])

  return createPortal(<div ref={layer} className="celebration" aria-hidden="true" />, document.body)
}
