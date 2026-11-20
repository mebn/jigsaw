import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import { api } from '../lib/api.ts'
import type { HomeRooms, RoomListKind, RoomSummary } from '../../shared/protocol.ts'
import { useApp } from '../lib/app.ts'
import { lastRoom, store } from '../lib/storage.ts'
import { navigate, paths } from '../lib/router.ts'
import { Back, Plus, Trash } from '../components/icons.tsx'
import { Art, ArtInfo, Tile } from '../components/Card.tsx'
import { Canvas, plainClick, preloadRoom } from '../components/Gallery.tsx'
import type { Placed, Section } from '../components/Gallery.tsx'
import Dialog from '../components/Dialog.tsx'
import Tabs from '../components/Tabs.tsx'
import Settings from '../components/Settings.tsx'
import Confirm from '../components/Confirm.tsx'
import RoomList, { LIST_TITLES } from './RoomList.tsx'
import { useLinger } from '../lib/linger.ts'

const NewRoom = lazy(() => import('./NewRoom.tsx'))

// The jigsaws page: the player's own jigsaws (made, connected in, or private ones they opened), those
// in progress and the latest finished, or the public ones in progress that were played last, on a
// gallery canvas (see Gallery.tsx). Each list that's longer than shown links to the whole of it, on
// a page of its own under /home (list, see RoomList). Opening a jigsaw, the page stays over it until
// its table is ready, then fades as the table zooms in (see App.tsx).

// How long the page takes to fade away over a jigsaw that opened (ms); matches the CSS.
export const GALLERY_OUT_MS = 450

type TabKey = 'mine' | 'public'
const TABS: { key: TabKey; title: string; hint: string }[] = [
  { key: 'mine', title: 'My jigsaws', hint: 'Jigsaws you made or played' },
  { key: 'public', title: 'Public', hint: 'Public jigsaws in progress' },
]

interface GalleryProps {
  // On the jigsaws page (false while it waits over a jigsaw that is opening).
  here: boolean
  closing: boolean
  // The new jigsaw form is open over it (/new).
  newOpen: boolean
  // The whole list it shows instead of its tabs, if any.
  list: RoomListKind | null
}

export default function Gallery({ here, closing, newOpen, list: listHere }: GalleryProps) {
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
  // The whole list shown: it stays while the page fades over a jigsaw that is opening.
  const [list, setList] = useState(listHere)
  if (here && listHere !== list) setList(listHere)
  // The jigsaws, null while they load, or 'failed'.
  const [rooms, setRooms] = useState<HomeRooms | 'failed' | null>(null)
  // The jigsaw to go back to, as it was when the page opened: it stays while the page fades over a
  // jigsaw that is opening, so the bar in the top left doesn't change before it goes.
  const [last, setLast] = useState(lastRoom.get)
  // Which jigsaws show, kept in this browser. Without a player there are none of their own.
  const [tab, setTabState] = useState<TabKey>(() => (store.get('roomsTab') === 'public' || !player ? 'public' : 'mine'))
  const setTab = (key: TabKey) => {
    store.set('roomsTab', key)
    setTabState(key)
  }
  // Counts up when a jigsaw is deleted, so a whole list loads again.
  const [version, setVersion] = useState(0)

  const load = useCallback(
    () =>
      api
        .home(player?.passphrase)
        .then(setRooms)
        .catch(() => setRooms('failed')),
    [player?.passphrase],
  )
  useEffect(() => {
    load()
  }, [load])

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
      return load()
    }
    lastRoom.forget(room.id)
    if (last === room.id) setLast(null)
    setVersion((v) => v + 1)
    load()
  }

  const closeNew = useCallback(() => navigate(paths.rooms), [])
  const [newShown, newClosing] = useLinger(newOpen)
  // Where in the new jigsaw window's header its Create button goes (see NewRoom).
  const [createSlot, setCreateSlot] = useState<HTMLDivElement | null>(null)

  // The sections the tab shows, each linking to its whole list when it has more.
  const sections = useMemo((): Section[] => {
    if (!rooms || rooms === 'failed') return []
    const all: Section[] =
      tab === 'mine'
        ? [
            {
              title: 'In progress',
              n: rooms.mineTotal,
              rooms: rooms.mine,
              more: rooms.mineTotal > rooms.mine.length ? { label: `See all ${rooms.mineTotal}`, path: paths.lists.mine } : undefined,
            },
            {
              title: 'Finished',
              n: rooms.finishedTotal,
              rooms: rooms.finished,
              more: rooms.finishedTotal > rooms.finished.length ? { label: `See all ${rooms.finishedTotal}`, path: paths.lists.finished } : undefined,
            },
          ]
        : [{ title: 'In progress', n: rooms.publicTotal, rooms: rooms.public, more: { label: 'Browse all', path: paths.lists.public } }]
    return all.filter((s) => s.rooms.length)
  }, [rooms, tab])

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
          {list ? (
            <button className="icon-btn" onClick={() => navigate(paths.rooms)} aria-label="Back to the jigsaws" data-tip="Back to the jigsaws">
              <Back />
            </button>
          ) : (
            last && (
              <button className="icon-btn" onClick={() => navigate(paths.room(last))} aria-label="Back to the jigsaw" data-tip="Back to the jigsaw">
                <Back />
              </button>
            )
          )}
          <Settings />
        </div>
        <h1>{list ? LIST_TITLES[list] : 'Jigsaws'}</h1>
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

      {list ? (
        <RoomList key={list} kind={list} render={render} version={version} />
      ) : (
        <>
          <div className="gallery-tabs">
            <Tabs tabs={TABS} value={tab} onChange={setTab} label="Show jigsaws" />
          </div>
          {!rooms ? (
            <div className="gallery-empty" aria-busy="true" aria-label="Loading jigsaws">
              <span className="spin" />
            </div>
          ) : rooms === 'failed' ? (
            <section className="gallery-empty">
              <p>Couldn't load the jigsaws.</p>
              <button className="secondary" onClick={load}>
                Try again
              </button>
            </section>
          ) : sections.length ? (
            <Canvas sections={sections} start={tab} render={render} />
          ) : tab === 'public' ? (
            <section className="gallery-empty">
              <p>No public jigsaws in progress.</p>
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
                  Public jigsaws
                </button>
              </div>
            </section>
          )}
        </>
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
