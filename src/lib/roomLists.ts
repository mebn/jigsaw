import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.ts'
import type { RoomListKind, RoomPage, RoomSort } from '../../shared/protocol.ts'
import type { Section } from '../components/Gallery.tsx'

export interface RoomListDef {
  kind: RoomListKind
  title: string
}

interface Shown {
  key: string
  lists: readonly RoomListDef[]
  pages: RoomPage[]
}

// Lists of jigsaws shown one after another, each under its heading, all in the order sort (a list
// that can't be sorted that way keeps its own, see ORDERS in server/rooms.ts). They load a page at a
// time: the first page of the first list, then more() (as the canvas nears its end) loads the next
// page, and once a list has all loaded, the first page of the list after it. So what's on the screen
// never moves down as more comes. Switching to other lists or another order, what was shown stays
// until they come, or lists seen before show at once while they load again.
export function useRoomLists(lists: readonly RoomListDef[], sort: RoomSort, passphrase: string | null | undefined) {
  // What's shown: which lists in which order (key), and the pages of each loaded so far (lists not
  // started yet aren't in it). null while the first loads, or 'failed'.
  const [got, setGot] = useState<Shown | 'failed' | null>(null)
  // The latest request, so an answer to an older one (another tab or order) is left out.
  const asked = useRef(0)
  const loading = useRef(false)
  // What each set of lists in each order had last, by key, for this player.
  const key = `${lists.map((l) => l.kind).join()} ${sort}`
  const seen = useRef(new Map<string, Shown>())
  const seenFor = useRef(passphrase)
  if (seenFor.current !== passphrase) {
    seenFor.current = passphrase
    seen.current.clear()
  }
  const show = useCallback(
    (pages: RoomPage[]) => {
      const shown = { key, lists, pages }
      seen.current.set(key, shown)
      setGot(shown)
    },
    [key, lists],
  )

  // What comes after pages: the next page of the list still loading, or the next list's first.
  // null when everything has loaded.
  const after = useCallback(
    async (pages: RoomPage[]): Promise<RoomPage[] | null> => {
      const k = pages.length - 1
      if (k >= 0 && pages[k].next !== null) {
        const p = await api.list(lists[k].kind, { sort, start: pages[k].next! }, passphrase)
        return pages.map((q, j) => (j === k ? { ...p, rooms: [...q.rooms, ...p.rooms] } : q))
      }
      if (pages.length >= lists.length) return null
      return [...pages, await api.list(lists[pages.length].kind, { sort }, passphrase)]
    },
    [lists, sort, passphrase],
  )

  // From the start: lists that are empty are passed over, so there's something to show if any has it.
  const load = useCallback(() => {
    const n = ++asked.current
    loading.current = true
    const before = seen.current.get(key)
    if (before) setGot(before)
    ;(async () => {
      let pages: RoomPage[] = []
      for (;;) {
        const next = await after(pages)
        if (!next) break
        pages = next
        if (pages.some((p) => p.rooms.length)) break
      }
      return pages
    })()
      .then((pages) => n === asked.current && show(pages))
      .catch(() => n === asked.current && !before && setGot('failed'))
      .finally(() => {
        if (n === asked.current) loading.current = false
      })
  }, [after, key, show])
  useEffect(load, [load])

  const more = useCallback(() => {
    if (loading.current || !got || got === 'failed' || got.key !== key) return
    const n = asked.current
    loading.current = true
    after(got.pages)
      .then((pages) => n === asked.current && pages && show(pages))
      .catch(() => {})
      .finally(() => {
        if (n === asked.current) loading.current = false
      })
  }, [got, key, after, show])

  // A jigsaw that was deleted goes from the lists without loading them again.
  const drop = useCallback((id: string) => {
    seen.current.clear()
    setGot((was) =>
      was && was !== 'failed'
        ? {
            ...was,
            pages: was.pages.map((p) => {
              const rooms = p.rooms.filter((r) => r.id !== id)
              return rooms.length < p.rooms.length ? { ...p, rooms, total: p.total - 1, next: p.next === null ? null : p.next - 1 } : p
            }),
          }
        : was,
    )
  }, [])

  const sections = useMemo(
    (): Section[] =>
      got && got !== 'failed'
        ? got.pages.flatMap((p, k) => (p.rooms.length ? [{ title: got.lists[k].title, n: p.total, rooms: p.rooms }] : []))
        : [],
    [got],
  )

  // shown is the key of what's shown, which changes when other lists or another order come.
  return { loading: got === null, failed: got === 'failed', shown: got && got !== 'failed' ? got.key : '', sections, more, reload: load, drop }
}
