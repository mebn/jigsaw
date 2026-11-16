import { useState } from 'react'
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { api } from '../lib/api.ts'
import { formatDuration, plural } from '../lib/format.ts'
import { paths } from '../lib/router.ts'
import { Lock } from './icons.tsx'

// What a jigsaw's picture and the line under it need, from the jigsaws page or a player's window.
interface ArtRoom {
  id: string
  thumb: string
  private: number
  // How many pieces it has.
  n: number
  seconds: number
  progress: number
  done: boolean
  finished: number
}

const finishedOn = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

// A jigsaw's picture, the small one first and the full one over it once loaded.
export function Art({ r, w, h }: { r: ArtRoom; w: number; h: number }) {
  const [full, setFull] = useState(false)
  return (
    <span className="art-pic" style={{ width: w, height: h }}>
      <img src={r.thumb} alt="" draggable={false} />
      <img className={`full${full ? ' on' : ''}`} src={api.imageUrl(r.id)} alt="" draggable={false} loading="lazy" decoding="async" onLoad={() => setFull(true)} />
    </span>
  )
}

// The line under a jigsaw's picture: how long it took when finished, or how far along it is, and
// how many pieces it has.
export function ArtInfo({ r }: { r: ArtRoom }) {
  return r.done ? (
    <span className="art-info">
      <span title="Time it took">{formatDuration(r.seconds)}</span>
      {r.finished > 0 && (
        <>
          <span className="dot" aria-hidden="true">·</span>
          <span title="Finished on">{finishedOn(r.finished)}</span>
        </>
      )}
    </span>
  ) : (
    <span className="art-info">
      <span title="Pieces connected">{Math.round(r.progress * 100)}% done</span>
      <span className="dot" aria-hidden="true">·</span>
      <span>{plural(r.n, 'piece')}</span>
      {!!r.private && <Lock aria-label="Private" />}
    </span>
  )
}

// The jigsaw under the pointer tilts towards it, with a soft light where it is.
function tilt(e: ReactPointerEvent<HTMLElement>) {
  if (e.pointerType !== 'mouse' || e.buttons) return
  const el = e.currentTarget
  const pic = el.querySelector<HTMLElement>('.pic')!
  const b = pic.getBoundingClientRect()
  const px = (e.clientX - b.left) / b.width
  const py = (e.clientY - b.top) / b.height
  el.style.setProperty('--ry', `${(px - 0.5) * 6}deg`)
  el.style.setProperty('--rx', `${(0.5 - py) * 4}deg`)
  el.style.setProperty('--mx', `${px * 100}%`)
  el.style.setProperty('--my', `${py * 100}%`)
}
function untilt(e: ReactPointerEvent<HTMLElement>) {
  const el = e.currentTarget
  el.style.setProperty('--ry', '0deg')
  el.style.setProperty('--rx', '0deg')
}

interface TileProps {
  r: ArtRoom & { done: boolean; progress: number }
  i: number
  onPick: (e: MouseEvent<HTMLAnchorElement>, id: string) => void
  children: ReactNode
  below?: ReactNode
  extra?: ReactNode
}

// A jigsaw as a picture on the wall, as on the jigsaws page: it lifts and tilts towards the pointer,
// with what's below under it. extra goes over it (the delete button).
export function Tile({ r, i, onPick, children, below, extra }: TileProps) {
  return (
    <a
      className="tile art"
      href={paths.room(r.id)}
      draggable={false}
      style={{ '--i': Math.min(i, 14) } as CSSProperties}
      onClick={(e) => onPick(e, r.id)}
      onPointerMove={tilt}
      onPointerLeave={untilt}
      aria-label={r.done ? 'Finished jigsaw' : `Jigsaw, ${Math.round(r.progress * 100)}% done`}
    >
      <span className="pic">{children}</span>
      {below}
      {extra}
    </a>
  )
}
