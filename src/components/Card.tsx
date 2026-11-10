import type { MouseEvent } from 'react'
import { Check, Clock, Lock, Piece, Trash } from './icons.tsx'
import { formatTime } from '../lib/time.ts'

// A jigsaw as the list and a player's window get it from the server.
export interface RoomCard {
  id: string
  thumb: string
  // Share of the pieces connected, 0 to 1.
  progress: number
  done: boolean
  seconds?: number
  // Pieces.
  n: number
  private?: number | boolean
  owner?: string | null
}

interface CardProps {
  r: RoomCard
  mine?: boolean
  onOpen: (id: string) => void
  onDelete?: (e: MouseEvent<HTMLButtonElement>, r: RoomCard) => void
}

// A jigsaw in the list: its picture in a frame, with how far along it is, the time and the pieces
// under it.
export function Card({ r, mine, onOpen, onDelete }: CardProps) {
  const pct = Math.round(r.progress * 100)
  return (
    <a
      className={`card${r.done ? ' done' : ''}`}
      href={`/r/${r.id}`}
      onClick={(e) => {
        // Modified clicks still open the jigsaw in a new tab or window.
        if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        onOpen(r.id)
      }}
    >
      <span className="card-pic">
        <img className="thumb" src={r.thumb} alt="" loading="lazy" />
      </span>
      <span className="progress" title="Pieces connected">
        <span style={{ width: `${r.done ? 100 : pct}%` }} />
      </span>
      <span className="card-stats">
        <span title="Total time spent">
          <Clock />
          {formatTime(r.seconds || 0)}
        </span>
        <span title="Pieces">
          <Piece />
          {r.n}
        </span>
        {!!r.private && (
          <span title="Private room: only people with the link can see it">
            <Lock />
          </span>
        )}
        {r.done ? (
          <span className="pct" title="Complete">
            <Check />
            Done
          </span>
        ) : (
          <span className="pct" title="Pieces connected">
            {pct}%
          </span>
        )}
      </span>
      {mine && (
        <button className="icon-btn del" onClick={(e) => onDelete!(e, r)} aria-label="Delete" title="Delete jigsaw">
          <Trash />
        </button>
      )}
    </a>
  )
}

// Grey stand-ins for cards while the jigsaws load, shimmering, with a bar where the numbers go.
// className sets out the cards, a grid by default. With caption, each has a line under it as well,
// as in a player's window (see PlayerDialog.tsx), so nothing moves when the cards come.
export function CardGhosts({ count = 6, className = 'grid', caption = false }: { count?: number; className?: string; caption?: boolean }) {
  const ghost = (k?: number) => (
    <div key={k} className="card ghost" aria-hidden="true">
      <span className="card-pic" />
      <span className="ghost-bar stats" />
    </div>
  )
  return (
    <div className={className} aria-busy="true" aria-label="Loading jigsaws">
      {Array.from({ length: count }, (_, k) =>
        caption ? (
          <div key={k} className="profile-room" aria-hidden="true">
            {ghost()}
            <span className="profile-share">
              <span className="ghost-bar caption" />
            </span>
          </div>
        ) : (
          ghost(k)
        ),
      )}
    </div>
  )
}
