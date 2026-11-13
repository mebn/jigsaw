import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { cursorColor } from '../lib/colors.ts'
import { formatTime, plural, timeAgo } from '../lib/format.ts'
import { useLinger } from '../lib/linger.ts'
import { Clock, Crown, Piece, Users } from './icons.tsx'
import PlayerDialog from './PlayerDialog.tsx'
import { useMenu } from '../lib/overlays.ts'
import type { LiveSeconds, Times } from '../lib/times.ts'

// At most this many circles in the header; everyone is in the menu behind the players button.
const SHOWN = 5
// How long the pointer rests on a circle before its card shows (ms).
const HOVER_MS = 250
const NONE: Record<string, number> = {}

// A player with what they've done in this jigsaw.
export interface RankedPlayer {
  id: string
  name: string
  connections: number
  seconds: number
}

// How many connections a player made (one for every join of two pieces or groups), by player id.
export type Stats = Map<string, number>

export type NameOf = (id: string | null | undefined) => string

interface RankInput {
  stats: Stats
  times: Times
  nameOf: NameOf
}

// Everyone who has done something in this jigsaw, most connections first, then most time.
// Players are kept apart by id, since two of them can share a name.
export function rankPlayers({ stats, times, nameOf }: RankInput) {
  const map = new Map<string, RankedPlayer>()
  const get = (id: string) => {
    if (!map.has(id)) map.set(id, { id, name: nameOf(id), connections: 0, seconds: 0 })
    return map.get(id)!
  }
  for (const [id, n] of stats) if (n > 0) get(id).connections = n
  for (const [id, seconds] of Object.entries(times)) if (seconds > 0) get(id).seconds = seconds

  return [...map.values()].sort(
    (a, b) =>
      b.connections - a.connections ||
      b.seconds - a.seconds ||
      a.name.localeCompare(b.name),
  )
}


// A player's circle: the first two letters of their name on their cursor colour, ringed while
// they're here. With you, it carries a You tag.
interface DotProps {
  p: { id: string; name: string }
  here: boolean
  big?: boolean
  you?: boolean
}

export function Dot({ p, here, big = false, you = false }: DotProps) {
  return (
    <span
      className={`player-dot${here ? ' online' : ''}${big ? ' big' : ''}${you ? ' you' : ''}`}
      style={{ '--c': cursorColor(p.id) } as CSSProperties}
      aria-hidden="true"
    >
      {[...p.name].slice(0, 2).join('')}
    </span>
  )
}

// This player's own time, counting up each second (see useTimes), with plus more seconds added.
export function LiveTime({ live, plus = 0 }: { live: LiveSeconds; plus?: number }) {
  return formatTime(plus + useSyncExternalStore(live.subscribe, live.get))
}

// The time a player spent: counting up when it's this player's own.
export function Spent({ p, me, myTime }: { p: RankedPlayer; me: string | null | undefined; myTime?: LiveSeconds }) {
  return p.id === me && myTime ? <LiveTime live={myTime} /> : formatTime(p.seconds)
}

// Where someone is: here now, or when they were last online (seen, ms), if known, as "20 minutes ago".
export function presence(here: boolean, seen: number | null | undefined) {
  if (here) return 'Here now'
  if (!seen) return 'Away'
  const t = timeAgo(seen)
  return t[0].toUpperCase() + t.slice(1)
}

// What shows while the pointer rests on a player: who they are and what they've done here. seen is
// when they were last here. With at ({ top, left }), it's placed there in the window, beside a row
// of the players list.
interface HoverCardProps {
  p: RankedPlayer
  here: boolean
  seen: number | undefined
  owner: string | null | undefined
  me: string | null | undefined
  myTime?: LiveSeconds
  at?: { top: number; right: number }
}

function HoverCard({ p, here, seen, owner, me, myTime, at }: HoverCardProps) {
  return (
    <div className={`player-card${at ? ' side' : ''}`} role="tooltip" style={at}>
      <div className="player-card-head">
        <Dot p={p} here={here} />
        <div>
          <div className="player-card-name">
            {p.name}
            {p.id === me && <span className="you-label"> (you)</span>}
          </div>
          <div className="player-card-sub">
            <span className={`presence${here ? ' here' : ''}`} />
            {presence(here, seen)}
          </div>
        </div>
      </div>
      {p.id === owner && (
        <div className="player-card-row owner">
          <Crown />
          Made this jigsaw
        </div>
      )}
      <div className="player-card-row">
        <Piece />
        {plural(p.connections, 'connection')} made
      </div>
      <div className="player-card-row">
        <Clock />
        <Spent p={p} me={me} myTime={myTime} /> spent
      </div>
    </div>
  )
}

// The players in the header: those here now as circles, by rank. The players button opens a list of
// everyone, here now and away, and a circle or a name opens that player's window.
// owner is the id of the player who made the jigsaw, online a Set of the player ids here now.
// seen is when each player was last here (ms by id). onAccount opens your account (in the settings).
interface PlayersProps {
  stats: Stats
  times: Times
  // This player's own time, counting up (see useTimes): times only has it as last saved.
  myTime?: LiveSeconds
  me: string | null | undefined
  owner: string | null | undefined
  nameOf: NameOf
  online: Set<string>
  seen?: Record<string, number>
  openRef?: RefObject<(() => void) | null>
  onAccount?: () => void
}

// Kept as it is while the room draws again for something else.
export default memo(function Players({ stats, times, myTime, me, owner, nameOf, online, seen = NONE, openRef, onAccount }: PlayersProps) {
  const [open, setOpen] = useState(false)
  const [menuShown, menuClosing] = useLinger(open)
  // P opens and closes the list (see Room).
  useEffect(() => {
    if (!openRef) return
    openRef.current = () => setOpen((o) => !o)
    return () => {
      openRef.current = null
    }
  }, [openRef])
  const [hover, setHover] = useState<string | null>(null)
  const [profile, setProfile] = useState<RankedPlayer | null>(null)
  const [profileShown, profileClosing] = useLinger(profile)
  const closeProfile = useCallback(() => setProfile(null), [])
  // Your own window has a button to your account.
  const openAccount = useCallback(() => {
    setProfile(null)
    onAccount?.()
  }, [onAccount])
  const wrap = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  const ranked = rankPlayers({ stats, times, nameOf })
  for (const id of online) {
    if (!ranked.some((p) => p.id === id)) ranked.push({ id, name: nameOf(id), connections: 0, seconds: 0 })
  }
  // You come first among those here.
  const here = ranked.filter((p) => online.has(p.id)).sort((a, b) => Number(b.id === me) - Number(a.id === me))
  const away = ranked.filter((p) => !online.has(p.id))
  const list = [...here, ...away]
  const shown = here.slice(0, SHOWN)

  useMenu(open, () => setOpen(false), [wrap], { closeOnScroll: false })
  useEffect(() => () => clearTimeout(timer.current), [])

  const show = (id: string, now = false) => {
    clearTimeout(timer.current)
    if (now) setHover(id)
    else timer.current = setTimeout(() => setHover(id), HOVER_MS)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setHover(null)
  }
  // The card beside a row of the players list, which scrolls, so it's placed in the window: to the
  // left of the list, level with the row.
  const [rowHover, setRowHover] = useState<{ p: RankedPlayer; at: { top: number; right: number } } | null>(null)
  const showRow = (p: RankedPlayer, row: HTMLElement) => {
    clearTimeout(timer.current)
    const r = row.getBoundingClientRect()
    const menu = row.closest('.players-menu')!.getBoundingClientRect()
    const at = { top: Math.max(8, r.top - 6), right: window.innerWidth - menu.left + 12 }
    if (rowHover) setRowHover({ p, at })
    else timer.current = setTimeout(() => setRowHover({ p, at }), HOVER_MS)
  }
  const hideRow = () => {
    clearTimeout(timer.current)
    setRowHover(null)
  }
  useEffect(() => {
    if (!open) setRowHover(null)
  }, [open])
  const openProfile = (p: RankedPlayer) => {
    hide()
    hideRow()
    setOpen(false)
    setProfile(p)
  }
  // The window keeps up with the player's numbers here while it's open.
  const current = profileShown && (list.find((p) => p.id === profileShown.id) || profileShown)

  // Everyone else's time together: this player's own counts up beside it.
  const others = list.reduce((t, p) => t + (myTime && p.id === me ? 0 : p.seconds), 0)

  if (!list.length) return null
  return (
    <div className="players" ref={wrap}>
      <ul className="player-dots" aria-label="Players here now">
        {shown.map((p) => (
          <li key={p.id}>
            <button
              className="player-btn"
              onClick={() => openProfile(p)}
              onPointerEnter={(e) => e.pointerType === 'mouse' && show(p.id)}
              onPointerLeave={hide}
              onFocus={(e) => e.target.matches(':focus-visible') && show(p.id, true)}
              onBlur={hide}
              aria-label={`${p.name}${p.id === me ? ' (you)' : ''}`}
            >
              <Dot p={p} here={online.has(p.id)} you={p.id === me} />
            </button>
            {hover === p.id && !open && <HoverCard p={p} here={online.has(p.id)} seen={seen[p.id]} owner={owner} me={me} myTime={myTime} />}
          </li>
        ))}
      </ul>
      <button
        className={`icon-btn more-btn${open ? ' on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="All players"
        aria-expanded={open}
        aria-keyshortcuts="P"
        data-tip={`All players (${list.length})`}
        data-key="P"
      >
        <Users />
      </button>
      {menuShown && (
        <div className={`players-menu${menuClosing ? ' closing' : ''}`}>
          <p className="players-total" title="Time spent by all players together">
            <Clock />
            Total time{' '}
            {myTime && list.some((p) => p.id === me) ? <LiveTime live={myTime} plus={others} /> : formatTime(others)}
          </p>
          <div className="players-list">
            {(
              [
                ['Here now', here],
                ['Away', away],
              ] as const
            ).map(
              ([title, group]) =>
                group.length > 0 && (
                  <section key={title}>
                    <h2 className="label">
                      {title}
                      <span className="n">{group.length}</span>
                    </h2>
                    {group.map((p) => (
                      <button
                        key={p.id}
                        className={`players-row${p.id === me ? ' me' : ''}`}
                        onClick={() => openProfile(p)}
                        onPointerEnter={(e) => e.pointerType === 'mouse' && showRow(p, e.currentTarget)}
                        onPointerLeave={hideRow}
                        onFocus={(e) => e.target.matches(':focus-visible') && showRow(p, e.currentTarget)}
                        onBlur={hideRow}
                      >
                        <Dot p={p} here={online.has(p.id)} />
                        <span className="pname">
                          {p.name}
                          {p.id === me && <span className="you-label"> you</span>}
                          {p.id === owner && (
                            <span className="powner">
                              <Crown />
                            </span>
                          )}
                        </span>
                        <span className="pstat">
                          <Piece />
                          {p.connections}
                        </span>
                        <span className="pstat ptime">
                          <Clock />
                          <Spent p={p} me={me} myTime={myTime} />
                        </span>
                      </button>
                    ))}
                  </section>
                ),
            )}
          </div>
        </div>
      )}
      {open && rowHover && (
        <HoverCard
          p={rowHover.p}
          here={online.has(rowHover.p.id)}
          seen={seen[rowHover.p.id]}
          owner={owner}
          me={me}
          myTime={myTime}
          at={rowHover.at}
        />
      )}
      {current && (
        <PlayerDialog
          p={current}
          here={online.has(current.id)}
          owner={owner}
          me={me}
          myTime={myTime}
          seen={seen[current.id]}
          onAccount={openAccount}
          onClose={closeProfile}
          closing={profileClosing}
        />
      )}
    </div>
  )
})
