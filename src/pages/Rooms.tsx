import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { api } from '../lib/api.ts'
import type { RoomSummary } from '../lib/api.ts'
import { navigate, store, useApp } from '../App.tsx'
import { Back, Lock, Plus, Trash } from '../components/icons.tsx'
import Dialog, { Tabs } from '../components/Dialog.tsx'
import Settings from '../components/Settings.tsx'
import Confirm from '../components/Confirm.tsx'
import NewRoom from './NewRoom.tsx'
import { buildPuzzle } from '../lib/geometry.ts'
import type { PuzzleGeometry } from '../lib/geometry.ts'
import { shapeOutline } from '../lib/sprites.ts'
import { useLinger } from '../lib/linger.ts'

// The jigsaws page: a gallery. Jigsaws in progress come first, each shown by its biggest group of
// connected pieces; finished ones hang on the wall below as pictures, with no frame, and only how
// long they took under them. Opening a jigsaw, the page stays over it until its table is ready,
// then fades as the table zooms in (see App.tsx).

// How long the page takes to fade away over a jigsaw that opened (ms); matches the CSS.
export const GALLERY_OUT_MS = 450

// Finished pictures sit in rows of about this height (CSS px), wider screens and narrower ones.
const ROW_H = 250
const ROW_H_SMALL = 150
// The room a group of pieces in progress gets (CSS px), wider screens and narrower ones.
const BOX: [number, number] = [230, 190]
const BOX_SMALL: [number, number] = [140, 120]
const SMALL = '(max-width: 600px)'

// Plain clicks open in place; modified clicks still open the jigsaw in a new tab or window.
const plainClick = (e: MouseEvent) => !(e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)

function useSmall() {
  const [small, setSmall] = useState(() => window.matchMedia(SMALL).matches)
  useEffect(() => {
    const m = window.matchMedia(SMALL)
    const on = () => setSmall(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return small
}

function useWidth() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [el])
  return [setEl, width] as const
}

// True once el has come near the screen, for drawing only what is looked at.
function useSeen() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (!el || seen) return
    const io = new IntersectionObserver((list) => list.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [el, seen])
  return [setEl, seen] as const
}

// Pictures loaded once and kept, by URL.
const images = new Map<string, Promise<HTMLImageElement>>()
function loadImage(src: string) {
  let p = images.get(src)
  if (!p) {
    const img = new Image()
    img.src = src
    p = img.decode().then(() => img)
    p.catch(() => images.delete(src))
    images.set(src, p)
  }
  return p
}

// Finished pictures in rows that fill the width, each row as high as makes it fit, about h. The
// last row keeps its height rather than stretching.
function justify(list: RoomSummary[], width: number, h: number, gap: number) {
  const rows: { items: RoomSummary[]; h: number }[] = []
  let row: RoomSummary[] = []
  let sum = 0
  const fit = () => (width - gap * (row.length - 1)) / sum
  for (const r of list) {
    row.push(r)
    sum += r.width / r.height || 1
    if (fit() <= h) {
      rows.push({ items: row, h: fit() })
      row = []
      sum = 0
    }
  }
  if (row.length) rows.push({ items: row, h: Math.min(h, fit()) })
  return rows
}

type TabKey = 'all' | 'public' | 'private'
const TABS: { key: TabKey; title: string; hint: string; test: (r: RoomSummary) => boolean }[] = [
  { key: 'all', title: 'All', hint: 'All jigsaws', test: () => true },
  { key: 'public', title: 'Public', hint: 'Public jigsaws', test: (r) => !r.private },
  { key: 'private', title: 'Private', hint: 'Private jigsaws', test: (r) => !!r.private },
]

// How long a jigsaw took, for the line under its picture: "45 min", "3 h 12 min".
function took(seconds: number) {
  const m = Math.round(seconds / 60)
  if (m < 1) return 'Under a minute'
  const h = Math.floor(m / 60)
  return h ? `${h} h ${m % 60} min` : `${m} min`
}

// The cells in a base64 bitset (see biggestBits() in server/api.ts).
function cellsOf(bits: string | undefined, n: number) {
  const cells: number[] = []
  if (bits) {
    const bytes = Uint8Array.from(atob(bits), (c) => c.charCodeAt(0))
    for (let i = 0; i < Math.min(n, bytes.length * 8); i++) if (bytes[i >> 3] & (1 << (i & 7))) cells.push(i)
  }
  return cells.length ? cells : [0]
}

const geos = new Map<string, PuzzleGeometry>()

// A jigsaw in progress: its biggest group of pieces cut out of the picture, as big as fits box,
// with faint lines where the pieces meet. Drawn from the small picture, or the full one when the
// group is too small a part of it for that to stay sharp.
function Group({ r, box }: { r: RoomSummary; box: [number, number] }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [wrap, seen] = useSeen()
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    if (!seen) return
    let dead = false
    let geo = geos.get(r.id)
    if (!geo) {
      geo = buildPuzzle(r)
      geos.set(r.id, geo)
    }
    const paths: Path2D[] = []
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const i of cellsOf(r.biggest, geo.pieces.length)) {
      const p = geo.pieces[i]
      const { pts } = shapeOutline(p, geo)
      const path = new Path2D()
      for (let j = 0; j < pts.length; j += 2) {
        const x = p.cx + pts[j]
        const y = p.cy + pts[j + 1]
        if (j) path.lineTo(x, y)
        else path.moveTo(x, y)
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      path.closePath()
      paths.push(path)
    }
    const k = Math.min(box[0] / (x1 - x0), box[1] / (y1 - y0))
    const dpr = window.devicePixelRatio || 1
    const c = canvas.current!
    c.width = Math.ceil((x1 - x0) * k * dpr)
    c.height = Math.ceil((y1 - y0) * k * dpr)
    c.style.width = `${(x1 - x0) * k}px`
    c.style.height = `${(y1 - y0) * k}px`
    const shape = new Path2D()
    for (const p of paths) shape.addPath(p)
    const draw = (img: HTMLImageElement) => {
      if (dead) return
      const ctx = c.getContext('2d')!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.setTransform(k * dpr, 0, 0, k * dpr, -x0 * k * dpr, -y0 * k * dpr)
      ctx.save()
      ctx.clip(shape)
      ctx.drawImage(img, 0, 0, r.width, r.height)
      if (paths.length > 1) {
        ctx.lineWidth = 1 / (k * dpr)
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)'
        for (const p of paths) ctx.stroke(p)
      }
      ctx.restore()
      setDrawn(true)
    }
    loadImage(r.thumb)
      .then((thumb) => {
        draw(thumb)
        // Small picture pixels per screen pixel: too few and the full picture is drawn as well.
        if ((thumb.naturalWidth / r.width) / (k * dpr) < 0.75) return loadImage(api.imageUrl(r.id)).then(draw)
      })
      .catch(() => {})
    return () => {
      dead = true
    }
  }, [seen, r, box])
  return (
    <span ref={wrap} className={`group-pic${drawn ? ' drawn' : ''}`} style={{ width: box[0], height: box[1] }}>
      <canvas ref={canvas} />
    </span>
  )
}

// A finished jigsaw: its picture, the small one first and the full one over it once loaded.
function Art({ r, w, h }: { r: RoomSummary; w: number; h: number }) {
  const [full, setFull] = useState(false)
  return (
    <span className="art-pic" style={{ width: w, height: h }}>
      <img src={r.thumb} alt="" />
      <img className={`full${full ? ' on' : ''}`} src={api.imageUrl(r.id)} alt="" loading="lazy" decoding="async" onLoad={() => setFull(true)} />
    </span>
  )
}

interface TileProps {
  r: RoomSummary
  i: number
  kind: 'art' | 'group'
  mine: boolean
  onPick: (e: MouseEvent<HTMLAnchorElement>, id: string) => void
  onDelete: (r: RoomSummary) => void
  children: ReactNode
  below?: ReactNode
}

function Tile({ r, i, kind, mine, onPick, onDelete, children, below }: TileProps) {
  return (
    <a
      className={`tile ${kind}`}
      href={`/r/${r.id}`}
      style={{ '--i': Math.min(i, 14) } as CSSProperties}
      onClick={(e) => onPick(e, r.id)}
      aria-label={r.done ? 'Finished jigsaw' : `Jigsaw, ${Math.round(r.progress * 100)}% done`}
    >
      <span className="pic">{children}</span>
      {below}
      {mine && (
        <button
          className="icon-btn del"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onDelete(r)
          }}
          aria-label="Delete"
          data-tip="Delete jigsaw"
        >
          <Trash />
        </button>
      )}
    </a>
  )
}

interface GalleryProps {
  // On the jigsaws page (false while it waits over a jigsaw that is opening).
  here: boolean
  closing: boolean
  // The new jigsaw form is open over it (/new).
  newOpen: boolean
}

export default function Gallery({ here, closing, newOpen }: GalleryProps) {
  const { roomId, openRoom, player, playerId, openLogin } = useApp()
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null)
  const small = useSmall()
  const [wallRef, wallWidth] = useWidth()
  const last = store.get('lastRoom')
  // Which jigsaws show, kept in this browser.
  const [tab, setTabState] = useState(() =>
    TABS.some((t) => t.key === store.get('roomsTab')) ? (store.get('roomsTab') as TabKey) : 'all',
  )
  const setTab = (key: TabKey) => {
    store.set('roomsTab', key)
    setTabState(key)
  }
  const shown = TABS.find((t) => t.key === tab)!.test

  const load = useCallback(
    () =>
      api
        .rooms(player?.passphrase)
        .then(setRooms)
        .catch(() => setRooms([])),
    [player?.passphrase],
  )
  useEffect(() => {
    load()
  }, [load])

  // A jigsaw was clicked: the page fades and its table zooms in (see App.tsx and Room.tsx).
  const pick = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (!plainClick(e)) return
    e.preventDefault()
    if (here) openRoom(id)
  }

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
    if (store.get('lastRoom') === room.id) store.set('lastRoom', null)
    load()
  }

  const closeNew = useCallback(() => navigate('/rooms'), [])
  const [newShown, newClosing] = useLinger(newOpen)
  // The bar under the new jigsaw form's title, where it puts its Create button (see NewRoom).
  const [bar, setBar] = useState<HTMLDivElement | null>(null)

  const progress = rooms?.filter((r) => shown(r) && !r.done) || []
  const finished = rooms?.filter((r) => shown(r) && r.done) || []
  const gap = small ? 20 : 44
  const rows = wallWidth ? justify(finished, wallWidth, small ? ROW_H_SMALL : ROW_H, gap) : []
  const box = small ? BOX_SMALL : BOX
  const tile = (r: RoomSummary, i: number, kind: TileProps['kind'], children: ReactNode, below?: ReactNode) => (
    <Tile
      key={r.id}
      r={r}
      i={i}
      kind={kind}
      mine={!!playerId && r.owner === playerId}
      onPick={pick}
      onDelete={setDoomed}
      below={below}
    >
      {children}
    </Tile>
  )

  let n = 0
  return (
    <div className={`gallery${!here ? ' going' : ''}${closing ? ' closing' : ''}`}>
      <header className="gallery-head">
        <div className="float">
          {last && last !== roomId && (
            <button className="icon-btn" onClick={() => openRoom(last)} aria-label="Back to the jigsaw" data-tip="Back to the jigsaw">
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
          <button className="primary new-btn" onClick={() => navigate('/new')}>
            <span>New jigsaw</span>
            <Plus />
          </button>
        </div>
      </header>
      <div className="gallery-tabs">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Show jigsaws" />
      </div>

      {!rooms ? (
        <section className="gallery-table" aria-busy="true" aria-label="Loading jigsaws">
          <div className="groups">
            {Array.from({ length: small ? 4 : 5 }, (_, k) => (
              <span key={k} className="group-ghost" style={{ width: box[0], height: box[1], '--i': k } as CSSProperties} />
            ))}
          </div>
        </section>
      ) : !rooms.length ? (
        <section className="gallery-empty">
          <p>No jigsaws yet.</p>
          <button className="primary" onClick={() => navigate('/new')}>
            Make the first one
          </button>
        </section>
      ) : !progress.length && !finished.length ? (
        <section className="gallery-empty">
          <p>No {tab} jigsaws.</p>
        </section>
      ) : (
        <>
          {progress.length > 0 && (
            <section className="gallery-table">
              <h2 className="gallery-label">
                In progress<span className="n">{progress.length}</span>
              </h2>
              <div className="groups">
                {progress.map((r) =>
                  tile(
                    r,
                    n++,
                    'group',
                    <Group r={r} box={box} />,
                    <span className="group-info">
                      {Math.round(r.progress * 100)}%{!!r.private && <Lock aria-label="Private" />}
                    </span>,
                  ),
                )}
              </div>
            </section>
          )}
          {finished.length > 0 && (
            <section className="gallery-wall">
              <h2 className="gallery-label">
                Finished<span className="n">{finished.length}</span>
              </h2>
              <div className="wall" ref={wallRef} style={{ rowGap: gap * 1.4 }}>
                {rows.map((row, k) => (
                  <div key={k} className="wall-row" style={{ gap }}>
                    {row.items.map((r) => {
                      const h = row.h
                      return tile(
                        r,
                        n++,
                        'art',
                        <Art r={r} w={h * (r.width / r.height || 1)} h={h} />,
                        <span className="art-info" title="Time it took">
                          {took(r.seconds)}
                        </span>,
                      )
                    })}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {newShown && (
        <Dialog
          title="New jigsaw"
          className="sheet"
          bg="sheet-bg"
          onClose={closeNew}
          closing={newClosing}
          keepTyping
          bar={<div className="rooms-bar" ref={setBar} />}
        >
          <NewRoom bar={bar} />
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
