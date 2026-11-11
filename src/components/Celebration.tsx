import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { fling } from '../lib/fling.ts'
import { calmMotion } from '../lib/motion.ts'

const EMOJI = '🎉'
// Emojis shot from each bottom corner.
const CANNON = 70
// How long it plays: longer than the longest flight (see below), delay and all.
const MS = 4200

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
    const k = calmMotion() ? 0.25 : 1
    const g = H * 1.1
    for (const side of [-1, 1]) {
      for (let i = 0; i < CANNON * k; i++) {
        // Aim up and in towards the middle, high enough to reach most of the screen.
        const a = -Math.PI / 2 - side * (0.15 + Math.random() * 0.55)
        const v = Math.sqrt(2 * g * H * (0.55 + Math.random() * 0.45))
        fling(el, EMOJI, {
          x: side < 0 ? 0 : W,
          y: H,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          g,
          ms: 2200 + Math.random() * 900,
          delay: Math.random() * 700,
          size: 0.9 + Math.random() * 1.1,
          spin: (Math.random() - 0.5) * 900,
          fade: 0.15,
        })
      }
    }
    const timer = setTimeout(onDone, MS)
    return () => clearTimeout(timer)
  }, [onDone])

  return createPortal(<div ref={layer} className="celebration" aria-hidden="true" />, document.body)
}
