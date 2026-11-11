import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOverlay } from '../lib/overlays.ts'
import { trayName, trayOrder } from '../lib/engine.ts'
import type { Engine } from '../lib/engine.ts'
import type { Box } from '../lib/geometry.ts'
import { plural, timeAgo } from '../lib/format.ts'
import type { NameOf } from './Players.tsx'
import TextField from './TextField.tsx'
import { Search as SearchIcon } from './icons.tsx'

// A note or a tray with a name: its text, what's said under it, the text to search in, the box to fly
// to.
interface Result {
  kind: 'tray' | 'note'
  key: string
  text: string
  meta: string[]
  hay: string
  box: Box
  // How much of the view the box fills when flown to: a note, being small, less, so what's around it shows too.
  fill: number
  id: string
}

// The text with each place it has the query in it marked.
function marked(text: string, q: string): ReactNode {
  if (!q) return text
  const lower = text.toLowerCase()
  const out: ReactNode[] = []
  let at = 0
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, at)) {
    out.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + q.length)}</mark>)
    at = i + q.length
  }
  out.push(text.slice(at))
  return out
}

interface SearchProps {
  engine: Engine
  nameOf: NameOf
  closing: boolean
  onClose: () => void
}

// Ctrl+F: the notes, newest first, and the trays with names, numbered ones first, narrowed down while typing. Arrow keys pick one,
// Enter (or a click) flies to it and selects it. Ctrl+F again closes it (see Room).
export default function Search({ engine, nameOf, closing, onClose }: SearchProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()

  const all = useMemo<Result[]>(() => {
    const notes: Result[] = (engine.notes?.find() || [])
      .filter((n) => n.text.trim())
      .sort((a, b) => b.created - a.created)
      .map((n) => {
        const text = n.text.trim().replace(/\s+/g, ' ')
        const by = nameOf(n.author)
        return {
          kind: 'note' as const,
          key: `n:${n.id}`,
          text,
          meta: [by, timeAgo(n.created)].filter(Boolean),
          hay: `${text}\n${by}\nnote`.toLowerCase(),
          box: { x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h },
          fill: 0.3,
          id: n.id,
        }
      })
    const trays: Result[] = engine.trays
      .filter(trayName)
      .sort(trayOrder)
      .map((t) => ({
        kind: 'tray' as const,
        key: `t:${t.id}`,
        text: trayName(t),
        meta: [t.num ? `Tray ${t.num}` : 'Tray', plural(t.pieces.length, 'piece')],
        hay: `${t.name}\ntray ${t.num || ''}`.toLowerCase(),
        box: { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h },
        fill: 0.75,
        id: t.id,
      }))
    return [...trays, ...notes]
  }, [engine, nameOf])
  // Every word typed has to be in it somewhere; ones with the whole query in their text come first,
  // trays still before notes, so each kind stays together under its heading.
  const results = useMemo(() => {
    if (!q) return all
    const words = q.split(/\s+/)
    const inText = (r: Result) => (r.text.toLowerCase().includes(q) ? 0 : 1)
    return all.filter((r) => words.every((w) => r.hay.includes(w))).sort((a, b) => (a.kind === b.kind ? inText(a) - inText(b) : a.kind === 'tray' ? -1 : 1))
  }, [all, q])

  useEffect(() => setActive(0), [q])
  useLayoutEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, results])

  useOverlay(!closing, onClose, { modal: true })

  const go = (r: Result | undefined) => {
    if (!r) return
    onClose()
    engine.selectOnly(r.kind, r.id)
    engine.flyTo(r.box, r.fill)
  }

  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = results.length
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) setActive((a) => (n ? (a + 1) % n : 0))
    else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) setActive((a) => (n ? (a - 1 + n) % n : 0))
    else if (e.key === 'Enter') go(results[active])
    else return
    e.preventDefault()
  }

  return createPortal(
    <div className={`modal-bg search-bg${closing ? ' closing' : ''}`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal search" role="dialog" aria-label="Search notes and trays">
        <label className="search-field">
          <SearchIcon />
          <TextField
            autoFocus
            value={query}
            placeholder="Search notes and trays"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="search-results"
            aria-activedescendant={results.length ? `search-${active}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={key}
            spellCheck={false}
          />
        </label>
        <div ref={listRef} className="search-results" id="search-results" role="listbox">
          {!results.length && (
            <p className="search-empty">
              {all.length ? <>Nothing matches “{query.trim()}”.</> : <>No notes or named trays yet.</>}
            </p>
          )}
          {results.map((r, i) => [
            r.kind !== results[i - 1]?.kind && (
              <h2 key={r.kind} className="search-section">
                {r.kind === 'tray' ? 'Trays' : 'Notes'}
                <span>{results.filter((x) => x.kind === r.kind).length}</span>
              </h2>
            ),
            <button
              key={r.key}
              type="button"
              id={`search-${i}`}
              data-i={i}
              role="option"
              aria-selected={i === active}
              className={`search-item${i === active ? ' on' : ''}`}
              onPointerMove={() => i !== active && setActive(i)}
              onClick={() => go(r)}
            >
              <span className="search-main">
                <span className="search-title">{marked(r.text, q)}</span>
                <span className="search-meta">
                  {r.meta.map((m, k) => (k ? <span key={k}>{marked(m, q)}</span> : <b key={k}>{m}</b>))}
                </span>
              </span>
              <kbd className="search-enter" aria-hidden="true">
                ↵
              </kbd>
            </button>,
          ])}
        </div>
      </div>
    </div>,
    document.body,
  )
}
