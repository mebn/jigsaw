import { Fragment } from 'react'
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
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

// A jigsaw's picture. The thumbnail is sharp enough for a tile even on a high density screen.
export function Art({ r, w, h }: { r: ArtRoom; w: number; h: number }) {
  return (
    <span className="art-pic" style={{ width: w, height: h }}>
      <img src={r.thumb} alt="" draggable={false} decoding="async" />
    </span>
  )
}

// What the line under a jigsaw's picture says: how long it took and when it was finished, or how far
// along it is, and how many pieces it has.
function infoParts(r: ArtRoom) {
  const pieces = { text: plural(r.n, 'piece'), title: '' }
  return r.done
    ? [{ text: formatDuration(r.seconds), title: 'Time it took' }, ...(r.finished > 0 ? [{ text: finishedOn(r.finished), title: 'Finished on' }] : []), pieces]
    : [{ text: `${Math.round(r.progress * 100)}% done`, title: 'Pieces connected' }, pieces]
}

// The caption's text and the room between its parts and around its dots (CSS px, see .art-info).
const INFO_FONT_PX = 12
const INFO_SPACING = 0.02 * INFO_FONT_PX
const INFO_GAP = 6
const LOCK_PX = 12
let measure: CanvasRenderingContext2D | null = null
const textWidth = (text: string) => {
  if (!measure) {
    measure = document.createElement('canvas').getContext('2d')!
    measure.font = `${INFO_FONT_PX}px ${getComputedStyle(document.body).fontFamily}`
  }
  return measure.measureText(text).width + text.length * INFO_SPACING
}

// The caption's parts in lines that fit in width (CSS px): all on one line when they fit, else as
// many as fit on each line, a part never split. With no width, one line.
export function infoLines(r: ArtRoom, width = Infinity) {
  const parts = infoParts(r)
  const dot = INFO_GAP + textWidth('·') + INFO_GAP
  const lines: (typeof parts)[] = []
  let used = 0
  parts.forEach((p, k) => {
    // The lock follows the last part.
    const w = textWidth(p.text) + (k === parts.length - 1 && !r.done && r.private ? INFO_GAP + LOCK_PX : 0)
    if (lines.length && used + dot + w <= width) {
      lines[lines.length - 1].push(p)
      used += dot + w
    } else {
      lines.push([p])
      used = w
    }
  })
  return lines
}

// The caption under a jigsaw's picture, in lines that fit in width (see infoLines).
export function ArtInfo({ r, width }: { r: ArtRoom; width?: number }) {
  const lines = infoLines(r, width)
  return (
    <span className="art-info">
      {lines.map((line, l) => (
        <span className="art-line" key={l}>
          {line.map((p, k) => (
            <Fragment key={k}>
              {k > 0 && (
                <span className="dot" aria-hidden="true">
                  ·
                </span>
              )}
              <span title={p.title || undefined}>{p.text}</span>
            </Fragment>
          ))}
          {l === lines.length - 1 && !r.done && !!r.private && <Lock aria-label="Private" />}
        </span>
      ))}
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
