import { useCallback, useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { api } from '../lib/api.ts'
import { navigate, store, useApp } from '../App.tsx'
import type { RoomsView } from '../App.tsx'
import { Check, Clock, Lock, Piece, Plus, Trash } from '../components/icons.tsx'
import Dialog, { Tabs } from '../components/Dialog.tsx'
import NewRoom from './NewRoom.tsx'
import Confirm from '../components/Confirm.tsx'
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

type TabKey = 'all' | 'public' | 'private'
const TABS: { key: TabKey; title: string; hint: string; test: (r: RoomCard) => boolean }[] = [
  { key: 'all', title: 'All', hint: 'All jigsaws', test: () => true },
  { key: 'public', title: 'Public', hint: 'Public jigsaws', test: (r) => !r.private },
  { key: 'private', title: 'Private', hint: 'Private jigsaws', test: (r) => !!r.private },
]

const SECTIONS: { title: string; test: (r: RoomCard) => boolean }[] = [
  { title: 'In progress', test: (r) => !r.done },
  { title: 'Finished', test: (r) => r.done },
]

// One window for the jigsaw list and the new jigsaw form: view is 'rooms' or 'new', and New
// switches it in place, with a back button, rather than opening another window. Without onClose
// it can't be dismissed (there is no jigsaw behind it to go back to).
interface RoomsDialogProps {
  view: RoomsView
  setView: (view: RoomsView) => void
  closing: boolean
  onClose: (() => void) | null
}

export default function RoomsDialog({ view, setView, closing, onClose }: RoomsDialogProps) {
  const { roomId, openRoom, player, playerId, openLogin } = useApp()
  const [rooms, setRooms] = useState<RoomCard[] | null>(null)
  const [tab, setTabState] = useState(() =>
    TABS.some((t) => t.key === store.get('roomsTab')) ? (store.get('roomsTab') as TabKey) : 'all',
  )
  const setTab = (key: TabKey) => {
    store.set('roomsTab', key)
    setTabState(key)
  }
  const shown = TABS.find((t) => t.key === tab)!.test

  const load = () =>
    api
      .rooms(player?.passphrase)
      .then(setRooms)
      .catch(() => setRooms([]))
  useEffect(() => {
    load()
  }, [player?.passphrase])

  // The jigsaw waiting for a yes in the delete dialog.
  const [doomed, setDoomed] = useState<RoomCard | null>(null)
  const keep = useCallback(() => setDoomed(null), [])
  const ask = (e: MouseEvent<HTMLButtonElement>, room: RoomCard) => {
    e.preventDefault()
    e.stopPropagation()
    setDoomed(room)
  }

  const remove = async (room: RoomCard) => {
    setDoomed(null)
    try {
      await api.remove(room.id, player?.passphrase)
    } catch {
      return load()
    }
    if (store.get('lastRoom') === room.id) store.set('lastRoom', null)
    if (roomId === room.id) navigate('/rooms')
    load()
  }

  const listing = view === 'rooms'
  // The bar under the title. The new jigsaw form puts its Create button in it (see NewRoom).
  const [bar, setBar] = useState<HTMLDivElement | null>(null)
  return (
    <Dialog
      title={listing ? 'Jigsaws' : 'New jigsaw'}
      className="sheet"
      bg="sheet-bg"
      onBack={listing ? null : () => setView('rooms')}
      backTitle="Back to all jigsaws"
      onClose={onClose}
      closing={closing}
      keepTyping
      actions={
        listing &&
        !player && (
          <button className="secondary small" onClick={openLogin} title="Log in">
            Log in
          </button>
        )
      }
      bar={
        <div className="rooms-bar" ref={setBar}>
          {listing && <Tabs tabs={TABS} value={tab} onChange={setTab} label="Show jigsaws" />}
          {listing && (
            <button className="primary new-btn" onClick={() => setView('new')} title="New jigsaw">
              <span>New jigsaw</span>
              <Plus />
            </button>
          )}
        </div>
      }
    >
      {listing && !rooms ? (
        <section className="rooms-section">
          <h2 className="label">
            <span className="ghost-bar label-bar" />
          </h2>
          <CardGhosts />
        </section>
      ) : listing ? (
        SECTIONS.map(({ title, test }) => {
          const list = rooms?.filter((r) => shown(r) && test(r)) || []
          if (!list.length) return null
          return (
            <section key={title} className="rooms-section">
              <h2 className="label">
                {title}
                <span className="n">{list.length}</span>
              </h2>
              <div className="grid">
                {list.map((r) => (
                  <Card key={r.id} r={r} mine={!!playerId && r.owner === playerId} onOpen={openRoom} onDelete={ask} />
                ))}
              </div>
            </section>
          )
        })
      ) : (
        <NewRoom bar={bar} />
      )}
      {doomed && (
        <Confirm
          title="Delete this jigsaw?"
          text="The jigsaw and everything on its table goes for everyone. This can't be undone."
          action="Delete"
          danger
          onCancel={keep}
          onConfirm={() => remove(doomed)}
        />
      )}
    </Dialog>
  )
}
