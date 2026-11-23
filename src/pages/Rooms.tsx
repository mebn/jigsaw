import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { api } from '../lib/api.ts'
import type { RoomSort, RoomSummary } from '../../shared/protocol.ts'
import { useApp } from '../lib/app.ts'
import { lastRoom, store } from '../lib/storage.ts'
import { navigate, paths } from '../lib/router.ts'
import { Back, Plus, Trash } from '../components/icons.tsx'
import { Art, ArtInfo, Tile } from '../components/Card.tsx'
import { Canvas, plainClick, preloadRoom } from '../components/Gallery.tsx'
import type { Placed } from '../components/Gallery.tsx'
import Dialog from '../components/Dialog.tsx'
import Tabs from '../components/Tabs.tsx'
import Settings from '../components/Settings.tsx'
import Confirm from '../components/Confirm.tsx'
import SortButton from '../components/SortButton.tsx'
import { useRoomLists } from '../lib/roomLists.ts'
import type { RoomListDef } from '../lib/roomLists.ts'
import { useLinger } from '../lib/linger.ts'

const NewRoom = lazy(() => import('./NewRoom.tsx'))

// The jigsaws page: all public jigsaws, or the player's own (made, connected in, or private ones they
// opened), those in progress and then the finished ones, in the order picked, on a gallery canvas
// (see Gallery.tsx) that loads more as it nears the end. Opening a jigsaw, the page stays over it
// until its table is ready, then fades as the table zooms in (see App.tsx).

// How long the page takes to fade away over a jigsaw that opened (ms); matches the CSS.
export const GALLERY_OUT_MS = 450

type TabKey = 'public' | 'mine' | 'playing' | 'done'
const TABS: { key: TabKey; title: string; hint: string }[] = [
  { key: 'public', title: 'All', hint: 'All public jigsaws' },
  { key: 'mine', title: 'Mine', hint: 'Jigsaws you made or played' },
  { key: 'playing', title: 'In progress', hint: 'Public jigsaws in progress' },
  { key: 'done', title: 'Finished', hint: 'Finished public jigsaws' },
]
// The lists each tab shows, one after another.
const PLAYING: RoomListDef = { kind: 'public', title: 'In progress' }
const DONE: RoomListDef = { kind: 'publicFinished', title: 'Finished' }
const LISTS: Record<TabKey, RoomListDef[]> = {
  public: [PLAYING, DONE],
  mine: [
    { kind: 'mine', title: 'In progress' },
    { kind: 'finished', title: 'Finished' },
  ],
  playing: [PLAYING],
  done: [DONE],
}
// The orders the jigsaws can be in. Finished ones are always newest finished first, but by size when
// sorted by that.
const SORTS: { key: RoomSort; title: string }[] = [
  { key: 'recent', title: 'Recent' },
  { key: 'nearly', title: 'Nearly done' },
  { key: 'pieces', title: 'Biggest' },
]

interface GalleryProps {
  // On the jigsaws page (false while it waits over a jigsaw that is opening).
  here: boolean
  closing: boolean
  // The new jigsaw form is open over it (/new).
  newOpen: boolean
}

export default function Gallery({ here, closing, newOpen }: GalleryProps) {
  const { player, playerId, openLogin } = useApp()
  // WebGPU starts now, so a jigsaw opened from here shows sooner. Its code is loaded with the
  // jigsaw page's, not with this page's.
  useEffect(() => {
    import('../lib/gpu.ts')
      .then((gpu) => gpu.warmGpu())
      .catch(() => {})
    if (!window.requestIdleCallback) {
      const t = setTimeout(preloadRoom, 1000)
      return () => clearTimeout(t)
    }
    const idle = window.requestIdleCallback(preloadRoom, { timeout: 2000 })
    return () => window.cancelIdleCallback(idle)
  }, [])
  // The jigsaw to go back to, as it was when the page opened: it stays while the page fades over a
  // jigsaw that is opening, so the bar in the top left doesn't change before it goes.
  const [last, setLast] = useState(lastRoom.get)
  // Which jigsaws show, kept in this browser; all of them at first.
  const [tab, setTabState] = useState<TabKey>(() => TABS.find((t) => t.key === store.get('roomsTab'))?.key ?? 'public')
  const setTab = (key: TabKey) => {
    store.set('roomsTab', key)
    setTabState(key)
  }
  // The order they're in, kept in this browser.
  const [sort, setSortState] = useState<RoomSort>(() => SORTS.find((o) => o.key === store.get('roomsSort'))?.key ?? 'recent')
  const setSort = (key: RoomSort) => {
    store.set('roomsSort', key)
    setSortState(key)
  }
  const { loading, failed, shown, sections, more, reload, drop } = useRoomLists(LISTS[tab], sort, player?.passphrase)

  // A jigsaw was clicked: the page fades and its table zooms in (see App.tsx and Room.tsx).
  const pick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>, id: string) => {
      if (!plainClick(e)) return
      e.preventDefault()
      if (here) navigate(paths.room(id))
    },
    [here],
  )

  // The jigsaw waiting for a yes in the delete dialog.
  const [doomed, setDoomed] = useState<RoomSummary | null>(null)
  const keep = useCallback(() => setDoomed(null), [])
  const remove = async (room: RoomSummary) => {
    setDoomed(null)
    try {
      await api.remove(room.id, player?.passphrase)
    } catch {
      return reload()
    }
    lastRoom.forget(room.id)
    if (last === room.id) setLast(null)
    drop(room.id)
  }

  const closeNew = useCallback(() => navigate(paths.rooms), [])
  const [newShown, newClosing] = useLinger(newOpen)
  // Where in the new jigsaw window's header its Create button goes (see NewRoom).
  const [createSlot, setCreateSlot] = useState<HTMLDivElement | null>(null)

  // Each jigsaw's picture, with how long it took under it when finished, or how far along it is.
  const render = useCallback(
    (p: Placed) => (
      <Tile
        r={p.r}
        i={p.i}
        onPick={pick}
        below={<ArtInfo r={p.r} width={p.w} />}
        extra={
          !!playerId &&
          p.r.owner === playerId && (
            <button
              className="icon-btn del"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDoomed(p.r)
              }}
              aria-label="Delete"
              data-tip="Delete jigsaw"
            >
              <Trash />
            </button>
          )
        }
      >
        <Art r={p.r} w={p.w} h={p.h} lazy />
      </Tile>
    ),
    [pick, playerId],
  )

  return (
    <div className={`gallery${!here ? ' going' : ''}${closing ? ' closing' : ''}`}>
      <header className="gallery-head">
        <div className="float">
          {last && (
            <button className="icon-btn" onClick={() => navigate(paths.room(last))} aria-label="Back to the jigsaw" data-tip="Back to the jigsaw">
              <Back />
            </button>
          )}
          <Settings />
        </div>
        <h1>Jigsaws</h1>
        <div className="gallery-actions">
          {!player && (
            <button className="secondary small" onClick={openLogin}>
              Log in
            </button>
          )}
          <button className="primary new-btn" onClick={() => navigate(paths.new)}>
            <span>New jigsaw</span>
            <Plus />
          </button>
        </div>
      </header>

      <div className="gallery-tabs">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Show jigsaws" />
        <SortButton sorts={SORTS} value={sort} onChange={setSort} />
      </div>
      {loading ? (
        <div className="gallery-empty" aria-busy="true" aria-label="Loading jigsaws">
          <span className="spin" />
        </div>
      ) : failed ? (
        <section className="gallery-empty">
          <p>Couldn't load the jigsaws.</p>
          <button className="secondary" onClick={reload}>
            Try again
          </button>
        </section>
      ) : sections.length ? (
        <Canvas sections={sections} start={shown} render={render} onNearEnd={more} />
      ) : tab !== 'mine' ? (
        <section className="gallery-empty">
          <p>{tab === 'playing' ? 'No public jigsaws in progress.' : tab === 'done' ? 'No finished public jigsaws yet.' : 'No public jigsaws yet.'}</p>
          <button className="primary" onClick={() => navigate(paths.new)}>
            Make one
          </button>
        </section>
      ) : (
        <section className="gallery-empty">
          <p>{player ? "You haven't made or played any jigsaws yet." : 'Log in to see the jigsaws you made and played.'}</p>
          <div className="row">
            {player ? (
              <button className="primary" onClick={() => navigate(paths.new)}>
                New jigsaw
              </button>
            ) : (
              <button className="primary" onClick={openLogin}>
                Log in
              </button>
            )}
            <button className="secondary" onClick={() => setTab('public')}>
              All jigsaws
            </button>
          </div>
        </section>
      )}

      {newShown && (
        <Dialog
          title="New jigsaw"
          className="sheet new-sheet"
          bg="sheet-bg"
          onClose={closeNew}
          closing={newClosing}
          keepTyping
          actions={<div className="create-slot" ref={setCreateSlot} />}
        >
          <Suspense fallback={<span className="spin" />}>
            <NewRoom slot={createSlot} />
          </Suspense>
        </Dialog>
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
    </div>
  )
}
