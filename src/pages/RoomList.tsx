import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api.ts'
import type { RoomListKind, RoomPage, RoomSort } from '../../shared/protocol.ts'
import { useApp } from '../lib/app.ts'
import { store } from '../lib/storage.ts'
import { Canvas } from '../components/Gallery.tsx'
import type { Placed, Section } from '../components/Gallery.tsx'
import Tabs from '../components/Tabs.tsx'

// A whole list of jigsaws the jigsaws page shows the start of (/home/playing, /home/finished and
// /home/browse): a page at a time, the next as the end of the last comes near, in the order picked
// at the top.

// The page's title for each list, and its section's heading.
export const LIST_TITLES: Record<RoomListKind, string> = { mine: 'My jigsaws', finished: 'Finished', public: 'Public jigsaws' }
const HEADINGS: Record<RoomListKind, string> = { mine: 'In progress', finished: 'Finished', public: 'In progress' }

// The orders each list can be in, the first its default (see ORDERS in server/rooms.ts), and where
// the one picked is kept in this browser.
type Sort = { key: RoomSort; title: string; hint: string }
const NEW: Sort = { key: 'newest', title: 'New', hint: 'Newest first' }
const NEARLY: Sort = { key: 'nearly', title: 'Nearly done', hint: 'Furthest along first' }
const BIGGEST: Sort = { key: 'pieces', title: 'Biggest', hint: 'Most pieces first' }
const SORTS: Record<RoomListKind, Sort[]> = {
  mine: [{ key: 'recent', title: 'Recent', hint: 'You played most recently' }, NEW, NEARLY, BIGGEST],
  finished: [
    { key: 'finished', title: 'Recent', hint: 'Finished most recently' },
    { key: 'share', title: 'Your share', hint: 'Most of the connections made by you' },
    BIGGEST,
  ],
  public: [{ key: 'recent', title: 'Recent', hint: 'Played most recently' }, NEW, NEARLY, BIGGEST],
}
const SORT_KEYS: Record<RoomListKind, string> = { mine: 'playingSort', finished: 'finishedSort', public: 'browseSort' }

interface Props {
  kind: RoomListKind
  // Makes each jigsaw (see the jigsaws page).
  render: (p: Placed) => ReactNode
  // Changes when a jigsaw was deleted, to load the list again.
  version: number
}

export default function RoomList({ kind, render, version }: Props) {
  const { player, openLogin } = useApp()
  const passphrase = player?.passphrase
  const sorts = SORTS[kind]
  const [sort, setSortState] = useState<RoomSort>(() => {
    const s = store.get(SORT_KEYS[kind])
    return sorts.find((o) => o.key === s)?.key ?? sorts[0].key
  })
  const setSort = (s: RoomSort) => {
    store.set(SORT_KEYS[kind], s)
    setSortState(s)
  }
  // What has loaded so far, null while the first page loads, or 'failed'.
  const [got, setGot] = useState<RoomPage | 'failed' | null>(null)
  // The latest request, so an answer to an older one (another order) is left out.
  const asked = useRef(0)
  const loading = useRef(false)
  const fetchPage = useCallback(
    (start: number) => {
      const n = ++asked.current
      loading.current = true
      api
        .list(kind, { sort, start }, passphrase)
        .then((p) => {
          if (n !== asked.current) return
          setGot((was) => (start && was && was !== 'failed' ? { ...p, rooms: [...was.rooms, ...p.rooms] } : p))
        })
        .catch(() => n === asked.current && setGot('failed'))
        .finally(() => {
          if (n === asked.current) loading.current = false
        })
    },
    [kind, sort, passphrase],
  )
  useEffect(() => {
    setGot(null)
    fetchPage(0)
  }, [fetchPage, version])
  const more = useCallback(() => {
    if (loading.current || !got || got === 'failed' || got.next === null) return
    fetchPage(got.next)
  }, [got, fetchPage])

  const sections = useMemo(
    (): Section[] => (got && got !== 'failed' && got.rooms.length ? [{ title: HEADINGS[kind], n: got.total, rooms: got.rooms }] : []),
    [got, kind],
  )

  return (
    <>
      {(kind === 'public' || player) && (
        <div className="gallery-tabs">
          <Tabs tabs={sorts} value={sort} onChange={setSort} label="Order" />
        </div>
      )}
      {kind !== 'public' && !player ? (
        <section className="gallery-empty">
          <p>Log in to see the jigsaws you made and played.</p>
          <button className="primary" onClick={openLogin}>
            Log in
          </button>
        </section>
      ) : got === null ? (
        <div className="gallery-empty" aria-busy="true" aria-label="Loading jigsaws">
          <span className="spin" />
        </div>
      ) : got === 'failed' ? (
        <section className="gallery-empty">
          <p>Couldn't load the jigsaws.</p>
          <button className="secondary" onClick={() => fetchPage(0)}>
            Try again
          </button>
        </section>
      ) : sections.length ? (
        <Canvas sections={sections} start={`${kind} ${sort}`} render={render} onNearEnd={more} />
      ) : (
        <section className="gallery-empty">
          <p>No jigsaws here yet.</p>
        </section>
      )}
    </>
  )
}
