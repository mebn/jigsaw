import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { formatTime } from '../lib/time.js'
import { Clock, Piece, Share } from './icons.jsx'

// Places in the order they stand, left to right: second, first, third.
const STANDS = [1, 0, 2]
// How far the podium turns towards the pointer at most, in degrees.
const TILT = 16

// The little podium drawn on the button that opens the real one.
export function PodiumIcon() {
  return (
    <span className="podium-icon" aria-hidden="true">
      <span className="p2">2</span>
      <span className="p1">1</span>
      <span className="p3">3</span>
    </span>
  )
}

// The top three players of a finished jigsaw, as a sticker: no dialog box, no dimmed background.
// Clicking anywhere or Escape puts it away; the button under it opens sharing (onShare), over it
// (covered: Escape is left to that). It turns a little towards the pointer.
export default function Podium({ ranked, closing, covered, onClose, onShare }) {
  const box = useRef(null)
  const stands = useRef(null)

  useEffect(() => {
    if (closing || covered) return
    const key = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose, closing, covered])

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const move = (e) => {
      const el = stands.current
      if (!el || !box.current) return
      // Measured on the box around it, which doesn't turn: the stands' own box changes as they
      // turn, which would change how far they turn, and they would shake.
      const b = box.current.getBoundingClientRect()
      // Where the pointer is from the podium's centre, as a share of a third of the window: -1 to 1,
      // so it turns all the way well before the pointer reaches the edge.
      const dx = Math.max(-1, Math.min(1, (e.clientX - (b.left + b.width / 2)) / (window.innerWidth / 3)))
      const dy = Math.max(-1, Math.min(1, (e.clientY - (b.top + b.height / 2)) / (window.innerHeight / 3)))
      el.style.transform = `perspective(700px) rotateX(${(-dy * TILT).toFixed(2)}deg) rotateY(${(dx * TILT).toFixed(2)}deg)`
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [])

  const top = ranked.slice(0, 3)
  return createPortal(
    <div className={`modal-bg podium-bg${closing ? ' closing' : ''}`} onPointerDown={onClose}>
      <div className="podium" role="dialog" aria-label="Podium" ref={box}>
        <div className="podium-stands" ref={stands}>
          {STANDS.filter((place) => top[place]).map((place) => {
            const p = top[place]
            return (
              <div key={p.id} className={`stand place-${place + 1}`}>
                <span className="stand-name" title={p.name}>
                  {p.name}
                </span>
                <div className="stand-block">
                  <span className="stand-rank">{place + 1}</span>
                  <span className="stand-stat" title="Pieces connected">
                    <Piece />
                    {p.pieces}
                  </span>
                  <span className="stand-stat" title="Time spent">
                    <Clock />
                    {formatTime(p.seconds)}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        {onShare && (
          <button className="podium-share" onPointerDown={(e) => e.stopPropagation()} onClick={onShare}>
            <Share />
            Share
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}
