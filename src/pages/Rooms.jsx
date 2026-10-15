import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { navigate, store, useApp } from '../App.jsx'
import { Check, Clock, Lock, Piece, Plus, Trash } from '../components/icons.jsx'
import Dialog, { Tabs } from '../components/Dialog.jsx'
import NewRoom from './NewRoom.jsx'
import Confirm from '../components/Confirm.jsx'
import { formatTime } from '../lib/time.js'

// A jigsaw in the list: its picture in a frame, with how far along it is, the time and the pieces
// under it.
export function Card({ r, mine, onOpen, onDelete }) {
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
        <button className="icon-btn del" onClick={(e) => onDelete(e, r)} aria-label="Delete" title="Delete jigsaw">
          <Trash />
        </button>
      )}
    </a>
  )
}

// Grey stand-ins for cards while the jigsaws load, shimmering, with a bar where the numbers go.
// className sets out the cards, a grid by default. With caption, each has a line under it as well,
// as in a player's window (see PlayerDialog.jsx), so nothing moves when the cards come.
export function CardGhosts({ count = 6, className = 'grid', caption = false }) {
  const ghost = (k) => (
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

const TABS = [
  { key: 'all', title: 'All', hint: 'All jigsaws', test: () => true },
  { key: 'public', title: 'Public', hint: 'Public jigsaws', test: (r) => !r.private },
  { key: 'private', title: 'Private', hint: 'Private jigsaws', test: (r) => !!r.private },
]

const SECTIONS = [
  { title: 'In progress', test: (r) => !r.done },
  { title: 'Finished', test: (r) => r.done },
]

// One window for the jigsaw list and the new jigsaw form: view is 'rooms' or 'new', and New
// switches it in place, with a back button, rather than opening another window. Without onClose
// it can't be dismissed (there is no jigsaw behind it to go back to).
export default function RoomsDialog({ view, setView, closing, onClose }) {
  const { roomId, openRoom, player, playerId, openLogin } = useApp()
  const [rooms, setRooms] = useState(null)
  const [tab, setTabState] = useState(() =>
    TABS.some((t) => t.key === store.get('roomsTab')) ? store.get('roomsTab') : 'all',
  )
  const setTab = (key) => {
    store.set('roomsTab', key)
    setTabState(key)
  }
  const shown = TABS.find((t) => t.key === tab).test

  const load = () =>
    api
      .rooms(player?.passphrase)
      .then(setRooms)
      .catch(() => setRooms([]))
  useEffect(() => {
    load()
  }, [player?.passphrase])

  // The jigsaw waiting for a yes in the delete dialog.
  const [doomed, setDoomed] = useState(null)
  const keep = useCallback(() => setDoomed(null), [])
  const ask = (e, room) => {
    e.preventDefault()
    e.stopPropagation()
    setDoomed(room)
  }

  const remove = async (room) => {
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
  const [bar, setBar] = useState(null)
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
