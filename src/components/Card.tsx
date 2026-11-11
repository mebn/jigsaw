import { Check, Clock, Lock, Piece } from './icons.tsx'
import { formatTime } from '../lib/format.ts'
import { paths } from '../lib/router.ts'
import type { PlayerRoom } from '../../shared/protocol.ts'

interface CardProps {
  r: PlayerRoom
  onOpen: (id: string) => void
}

// A jigsaw in a player's window: its picture in a frame, with how far along it is, the time and the
// pieces under it.
export function Card({ r, onOpen }: CardProps) {
  const pct = Math.round(r.progress * 100)
  return (
    <a
      className={`card${r.done ? ' done' : ''}`}
      href={paths.room(r.id)}
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
          {formatTime(r.seconds)}
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
    </a>
  )
}

// Grey stand-ins for cards while the jigsaws load, shimmering, with a bar where the numbers go and
// a line under each, so nothing moves when the cards come.
export function CardGhosts({ count }: { count: number }) {
  return (
    <div className="profile-rooms" aria-busy="true" aria-label="Loading jigsaws">
      {Array.from({ length: count }, (_, k) => (
        <div key={k} className="profile-room" aria-hidden="true">
          <div className="card ghost">
            <span className="card-pic" />
            <span className="ghost-bar stats" />
          </div>
          <span className="profile-share">
            <span className="ghost-bar caption" />
          </span>
        </div>
      ))}
    </div>
  )
}
