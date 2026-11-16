import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { api } from '../lib/api.ts'
import type { PlayerProfile } from '../../shared/protocol.ts'
import { useApp } from '../lib/app.ts'
import { learnAvatars } from '../lib/avatars.ts'
import { navigate, paths } from '../lib/router.ts'
import { plural } from '../lib/format.ts'
import type { PlayerRoom } from '../../shared/protocol.ts'
import { Art, Tile } from './Card.tsx'
import Dialog from './Dialog.tsx'
import { Dot, Spent, presence } from './Players.tsx'
import type { RankedPlayer } from './Players.tsx'
import type { LiveTimes } from '../lib/times.ts'
import { Clock, Crown, Piece, User } from './icons.tsx'

// Their jigsaws' pictures are all this tall, as wide as the picture is, in a row (smaller on a phone).
function artSize(r: PlayerRoom) {
  const h = window.matchMedia('(max-width: 480px)').matches ? 120 : 150
  const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 4 / 3
  return { w: Math.round(h * Math.min(2, Math.max(0.6, aspect))), h }
}

// A player's window, from their circle in the header: who they are, what they did in this jigsaw,
// and the other jigsaws they've played. Private jigsaws only show if this player has them too (the
// server checks). p is the player as the header knows them: { id, name, connections, seconds }. Your own
// window has a button to your account (onAccount). seen is when they were last in this jigsaw.
interface PlayerDialogProps {
  p: RankedPlayer
  here: boolean
  owner: string | null | undefined
  me: string | null | undefined
  live?: LiveTimes
  seen: number | undefined
  onAccount?: () => void
  onClose: () => void
  closing: boolean
}

export default function PlayerDialog({ p, here, owner, me, live, seen, onAccount, onClose, closing }: PlayerDialogProps) {
  const { player, roomId } = useApp()
  const [info, setInfo] = useState<PlayerProfile | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let dead = false
    setInfo(null)
    setFailed(false)
    api
      .player(p.id, player?.passphrase)
      .then((d) => {
        if (dead) return
        learnAvatars([d])
        setInfo(d)
      })
      .catch(() => !dead && setFailed(true))
    return () => {
      dead = true
    }
  }, [p.id, player?.passphrase])

  const others = info?.rooms.filter((r) => r.id !== roomId) || []
  // Last online: the latest of here and the jigsaws of theirs you can see.
  const last = Math.max(seen || 0, ...(info?.rooms.map((r) => r.seen || 0) || []))
  const since = info?.created ? new Date(info.created).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''
  const open = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    // Modified clicks still open the jigsaw in a new tab or window.
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onClose()
    navigate(paths.room(id))
  }

  return (
    <Dialog title={p.name} label={`${p.name}, player`} className="profile" onClose={onClose} closing={closing}>
      <div className="profile-head">
        <Dot p={p} here={here} big you={p.id === me} />
        <div className="profile-who">
          <span className="profile-status">
            <span className={`presence${here ? ' here' : ''}`} />
            {presence(here, last)}
            {p.id === me && ' · you'}
          </span>
          {since && <span className="profile-since">Playing since {since}</span>}
        </div>
        {p.id === me && onAccount && (
          <button className="secondary small profile-account" onClick={onAccount}>
            <User />
            Account
          </button>
        )}
      </div>

      <section>
        <h2 className="label">This jigsaw</h2>
        <div className="profile-stats">
          {p.id === owner && (
            <span className="profile-stat owner">
              <Crown />
              Made it
            </span>
          )}
          <span className="profile-stat">
            <Piece />
            {plural(p.connections, 'connection')} made
          </span>
          <span className="profile-stat">
            <Clock />
            <Spent p={p} live={live} /> spent
          </span>
        </div>
      </section>

      <section>
        <h2 className="label">
          Other jigsaws
          {info && <span className="n">{others.length}</span>}
        </h2>
        {failed ? (
          <p className="profile-empty">Couldn't load their other jigsaws.</p>
        ) : !info ? (
          <div className="profile-empty" aria-busy="true" aria-label="Loading jigsaws">
            <span className="spin" />
          </div>
        ) : !others.length ? (
          <p className="profile-empty">No other jigsaws you can see.</p>
        ) : (
          <div className="profile-rooms">
            {others.map((r, i) => {
              const { w, h } = artSize(r)
              return (
              <div key={r.id} className="profile-room" style={{ width: w }}>
                <Tile r={r} i={i} onPick={open}>
                  <Art r={r} w={w} h={h} />
                </Tile>
              </div>
              )
            })}
          </div>
        )}
      </section>
    </Dialog>
  )
}
