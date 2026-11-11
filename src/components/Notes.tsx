import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, RefObject } from 'react'
import { newId } from '../lib/api.ts'
import { useApp } from '../lib/app.ts'
import type { RoomSocket } from '../lib/api.ts'
import { trayColor } from '../lib/colors.ts'
import { LIMITS } from '../../shared/protocol.ts'
import type { NoteReaction, NoteReactionKind, NoteReply, NoteRow, RoomDetails } from '../../shared/protocol.ts'
import type { Engine } from '../lib/engine.ts'
import type { NameOf } from './Players.tsx'
import { Close, Note as NoteIcon, Reply } from './icons.tsx'
import PlaceButton from './PlaceButton.tsx'

// Smallest note width, in units of the jigsaw's piece size. Notes grow wider as a line gets longer,
// and taller with each new line.
const NOTE_W = 2.2

// A note stuck to a tray has its top left corner this far (in piece sizes) left of and above the
// tray's bottom right corner, so it sits over the corner.
const ON_TRAY_X = 1
const ON_TRAY_Y = 0.6

// Two clicks on a note within this time (ms) start editing it.
const DOUBLE_MS = 400

// How each reaction a note can have shows, in the order they show under it.
const REACTIONS: { kind: NoteReactionKind; emoji: string; label: string }[] = [
  { kind: 'up', emoji: '👍', label: 'Thumbs up' },
  { kind: 'down', emoji: '👎', label: 'Thumbs down' },
  { kind: 'eyes', emoji: '👀', label: 'Eyes' },
  { kind: 'fire', emoji: '🔥', label: 'Fire' },
]

// Reactions as stored ([{ note, player, kind }], oldest first) to note id -> kind -> player ids.
function gather(rows: NoteReaction[] = []): ReactionMap {
  const out: ReactionMap = {}
  for (const { note, player, kind } of rows) {
    const by = (out[note] ||= {})
    by[kind] = [...(by[kind] || []), player]
  }
  return out
}

// Replies as stored ([{ id, note, author, text, created }], oldest first) to note id -> replies.
function gatherReplies(rows: NoteReply[] = []): ReplyMap {
  const out: ReplyMap = {}
  for (const r of rows) (out[r.note] ||= []).push(r)
  return out
}

// Makes the text area exactly as wide as its longest line and as tall as its text, so nothing scrolls
// out of sight. An empty note keeps its smallest width, so the placeholder wraps inside it. With fill,
// an empty one takes no room of its own and just fills the note (min-width: 100%), as wide as it is.
function fitSize(el: HTMLTextAreaElement, fill = false) {
  el.style.width = fill ? '0' : ''
  if (el.value) {
    // Measured without its min-width, which would hold it as wide as the note: then a note never got
    // narrower again when a long line was shortened or a long reply deleted.
    el.style.minWidth = '0'
    el.style.width = '0'
    // A little extra room for the caret at the end of the line.
    el.style.width = `${el.scrollWidth + 2}px`
    el.style.minWidth = ''
  }
  el.style.height = '0'
  el.style.height = `${el.scrollHeight}px`
}

// Makes a note at (clientX, clientY) in the window, or in the middle of the table for null.
export type CreateNote = (clientX: number | null, clientY: number | null) => void

// A note's reactions: kind -> the players who gave it.
type NoteReactions = Partial<Record<NoteReactionKind, string[]>>

interface NoteProps {
  note: NoteRow
  at: { x: number; y: number }
  edge: string | undefined
  engine: Engine
  focus: boolean
  selected: boolean
  mark: string | undefined
  canEdit: boolean
  author: string
  reactions: NoteReactions | undefined
  replies: NoteReply[] | undefined
  me: string | null | undefined
  nameOf: NameOf
  ensureName: () => boolean
  onChange: (id: string, patch: Partial<NoteRow>) => void
  onSave: (note: NoteRow) => void
  onLive: (note: NoteRow) => void
  onReact: (id: string, kind: NoteReactionKind, on: boolean) => void
  onReply: (note: string, text: string) => void
  onDeleteReply: (id: string) => void
}

function Note({ note, at, edge, engine, focus, selected, mark, canEdit, author, reactions, replies, me, nameOf, ensureName, onChange, onSave, onLive, onReact, onReply, onDeleteReply }: NoteProps) {
  const area = useRef<HTMLTextAreaElement>(null)
  const replyArea = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef(0)
  // The reply being written, or null when not replying.
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (focus) area.current?.focus()
  }, [focus])

  const unit = engine.geo.S
  useLayoutEffect(() => {
    if (area.current) fitSize(area.current)
  }, [note.text, unit])
  useLayoutEffect(() => {
    if (replyArea.current) fitSize(replyArea.current, true)
  }, [draft, unit])

  // Drag anywhere on the note to move it; a click without moving selects it, a double click edits it.
  // While editing, the text area behaves normally and the rest of the note still drags.
  const startMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return
    if (e.target === area.current && document.activeElement === area.current) return
    if (e.target === replyArea.current) return
    e.preventDefault()
    if (!ensureName()) return
    // Shift-click adds the note to the selection; dragging a selected note carries the whole selection.
    if (e.shiftKey) return engine.toggleNote(note.id)
    if (selected && engine.selCount > 1) return engine.grabSelection(e, { note: note.id })
    if (engine.selCount && !selected) engine.setSelection(new Set())
    engine.grabNote(e, note.id)
  }

  const edit = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    onChange(note.id, { text })
    onLive({ ...note, text })
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => onSave({ ...note, text }), 400)
  }

  const startReply = () => {
    if (!ensureName()) return
    if (draft === null) setDraft('')
    else replyArea.current?.focus()
  }
  // Enter or a click anywhere else sends the reply, Shift+Enter starts a new line, Escape gives it up.
  const replyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') cancelled.current = true
    else if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    e.currentTarget.blur()
  }
  const replyBlur = () => {
    // Switching to another tab or app keeps the reply to finish later.
    if (!cancelled.current && !document.hasFocus()) return
    if (!cancelled.current && draft?.trim()) onReply(note.id, draft.trim())
    cancelled.current = false
    setDraft(null)
  }

  const menu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    engine.openNoteMenu(note.id, r.left, r.bottom + 4)
  }

  return (
    <div
      className={`note${selected ? ' sel' : mark ? ' marked' : ''}`}
      style={{ left: at.x, top: at.y, '--mark': mark, '--edge': edge } as CSSProperties}
      data-note={note.id}
      onContextMenu={(e) => {
        e.preventDefault()
        engine.openNoteMenu(note.id, e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        // Over a reaction, who gave it; over a button, what it does; over a reply, nothing (it's signed);
        // over the rest of the note, who wrote it.
        const b = (e.target as Element).closest<HTMLElement>('[data-who]')
        const text = b ? b.dataset.who : author
        if (e.buttons || !text) return engine.showTip(null)
        const [sx, sy] = engine.canvasPoint(e.clientX, e.clientY)
        engine.showTip({ text, sx, sy })
      }}
      onPointerLeave={() => engine.showTip(null)}
      onPointerDown={startMove}
    >
      <button type="button" className="note-menu" onClick={menu} aria-label="Note menu">
        <i />
        <i />
        <i />
      </button>
      <textarea
        ref={area}
        rows={1}
        readOnly={!canEdit}
        value={note.text}
        placeholder={canEdit ? 'Write something…' : ''}
        onChange={edit}
        onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
        onBlur={() => {
          clearTimeout(saveTimer.current)
          onSave(note)
        }}
        spellCheck={false}
        maxLength={LIMITS.text}
        aria-label="Note"
      />
      {replies?.map((r) => (
        <div key={r.id} className="note-reply" data-who="">
          <b>{nameOf(r.author)}</b>
          <span>{r.text}</span>
          {r.author === me && (
            <button type="button" className="note-reply-delete" onClick={() => onDeleteReply(r.id)} aria-label="Delete reply" data-who="Delete your reply">
              <Close />
            </button>
          )}
        </div>
      ))}
      {draft !== null && (
        <div className="note-reply" data-who="">
          <textarea
            ref={replyArea}
            className="note-reply-field"
            rows={1}
            value={draft}
            placeholder="Reply…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={replyKey}
            onBlur={replyBlur}
            autoFocus
            spellCheck={false}
            maxLength={LIMITS.text}
            aria-label="Reply"
          />
        </div>
      )}
      {/* Reactions someone gave stay under the note; the others show while it's hovered or selected. */}
      <div className="note-reacts">
        {REACTIONS.map(({ kind, emoji, label }) => {
          const who = reactions?.[kind] || []
          const mine = !!me && who.includes(me)
          return (
            <button
              key={kind}
              type="button"
              className={`note-react${who.length ? ' used' : ''}${mine ? ' mine' : ''}`}
              onClick={() => ensureName() && onReact(note.id, kind, !mine)}
              aria-label={label}
              aria-pressed={mine}
              data-who={who.map(nameOf).join(', ')}
            >
              <span>{emoji}</span>
              {who.length > 0 && <b>{who.length}</b>}
            </button>
          )
        })}
        <button type="button" className="note-react note-reply-btn" onClick={startReply} aria-label="Reply" data-who="Reply">
          <Reply />
        </button>
      </div>
    </div>
  )
}

// Reactions on each note: note id -> kind -> the players who gave it.
type ReactionMap = Record<string, NoteReactions>
// Replies under each note, oldest first: note id -> replies.
type ReplyMap = Record<string, NoteReply[]>

// The reactions with a player's reaction of this kind on note id put on (on) or taken off.
function toggled(rs: ReactionMap, id: string, kind: NoteReactionKind, player: string, on: boolean): ReactionMap {
  const who = (rs[id]?.[kind] || []).filter((p) => p !== player)
  return { ...rs, [id]: { ...rs[id], [kind]: on ? [...who, player] : who } }
}

// The replies with r added under its note (once), or with reply id taken away.
function withReply(rs: ReplyMap, r: NoteReply): ReplyMap {
  const list = rs[r.note] || []
  return list.some((o) => o.id === r.id) ? rs : { ...rs, [r.note]: [...list, r] }
}
function withoutReply(rs: ReplyMap, id: string): ReplyMap {
  const out: ReplyMap = {}
  for (const [note, list] of Object.entries(rs)) out[note] = list.filter((r) => r.id !== id)
  return out
}

// room: the room as last loaded, again after a reconnect.
interface NotesLayerProps {
  engine: Engine
  sock: RoomSocket
  room: Pick<RoomDetails, 'notes' | 'noteReactions' | 'noteReplies'>
  me: string | null | undefined
  nameOf: NameOf
  createRef: RefObject<CreateNote | null>
}

// Memoised: the room re-renders every second while time counts up, and nothing here changes with it.
export const NotesLayer = memo(function NotesLayer({ engine, sock, room, me, nameOf, createRef }: NotesLayerProps) {
  const { ensureName, requireName } = useApp()
  const [notes, setNotes] = useState(room.notes)
  const [reactions, setReactions] = useState(() => gather(room.noteReactions))
  const [replies, setReplies] = useState(() => gatherReplies(room.noteReplies))
  const [focusId, setFocusId] = useState<string | null>(null)
  const [selected, setSelected] = useState(() => new Set<string>())
  const [marked, setMarked] = useState(() => new Map<string, string>())
  const layer = useRef<HTMLDivElement>(null)
  const lastClick = useRef<{ id?: string; t?: number }>({})
  const latest = useRef(notes)
  latest.current = notes
  const S = engine.geo.S

  // Where a note stuck to a tray goes, over the tray's bottom right corner ({} if it isn't on one).
  const onTray = (n: { tray?: string | null }): { x?: number; y?: number } => {
    const t = n.tray && engine.trays.find((x) => x.id === n.tray)
    return t ? { x: t.x + t.w - S * ON_TRAY_X, y: t.y + t.h - S * ON_TRAY_Y } : {}
  }
  const where = (n: NoteRow) => ({ x: n.x, y: n.y, ...onTray(n) })
  // A note stuck to a tray has the tray's colour for its border.
  const edgeOf = (n: NoteRow) => {
    const t = n.tray && engine.trays.find((x) => x.id === n.tray)
    return t ? trayColor(t.color) : undefined
  }
  const saveNote = (note: NoteRow, live = false) => sock.send({ type: 'note', live, note })

  // The notes as the room was loaded, but the text of a note that's being edited right now stays.
  useEffect(() => {
    engine.resetSeen('note', room.notes)
    setReactions(gather(room.noteReactions))
    setReplies(gatherReplies(room.noteReplies))
    const editing = document.activeElement?.closest?.<HTMLElement>('[data-note]')?.dataset.note
    setNotes((ns) => room.notes.map((n) => (n.id === editing ? { ...n, text: ns.find((o) => o.id === n.id)?.text ?? n.text } : n)))
  }, [engine, room])

  useEffect(() => {
    const el = layer.current!
    const off = engine.addView((cam, vw, vh) => {
      el.style.transform = `translate(${vw / 2 - cam.x * cam.z}px, ${vh / 2 - cam.y * cam.z}px) scale(${cam.z})`
    })
    const wheel = (e: WheelEvent) => engine.onWheel(e)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      off()
      el.removeEventListener('wheel', wheel)
    }
  }, [engine])

  // Lets the engine select notes with the selection box and carry them along with a drag.
  useEffect(() => {
    const size = (id: string) => {
      const el = layer.current?.querySelector<HTMLElement>(`[data-note="${id}"]`)
      return { w: el?.offsetWidth || NOTE_W * S, h: el?.offsetHeight || S }
    }
    engine.notes = {
      get: () =>
        latest.current.map((n) => ({
          id: n.id,
          ...where(n),
          ...size(n.id),
        })),
      find: () =>
        latest.current.map((n) => ({
          id: n.id,
          ...where(n),
          ...size(n.id),
          text: n.text,
          author: n.author,
          created: n.created,
        })),
      // send: null moves locally only, 'live' also relays, 'save' also stores. Moving a note takes it
      // off its tray, unless it's given one ({ id, x, y, tray }), whose corner it then goes to.
      move: (list, send) => {
        const at = new Map(list.map((p) => [p.id, p]))
        const moved = (n: NoteRow) => {
          const p = at.get(n.id)!
          return { ...n, x: p.x, y: p.y, tray: p.tray || null, ...onTray({ tray: p.tray }) }
        }
        setNotes((ns) => ns.map((n) => (at.has(n.id) ? moved(n) : n)))
        if (!send) return
        for (const n of latest.current) {
          if (!at.has(n.id)) continue
          const m = moved(n)
          saveNote(m, send === 'live')
          if (send === 'save') engine.trackObj('note', n.id, m)
        }
      },
      // Each frame: notes stuck to trays follow their tray's corner as it moves or changes size, its
      // colour, its lift while it's moved, and its outline while it's selected (data-lit, in the
      // colour --lit).
      follow: () => {
        const lit = new Map<string, string>()
        let marks: Map<string, string> | undefined
        for (const n of latest.current) {
          const p = onTray(n)
          const el = p.x != null && layer.current?.querySelector<HTMLElement>(`[data-note="${n.id}"]`)
          if (!el) continue
          if (el.style.left !== `${p.x}px`) el.style.left = `${p.x}px`
          if (el.style.top !== `${p.y}px`) el.style.top = `${p.y}px`
          const edge = edgeOf(n)
          if (el.style.getPropertyValue('--edge') !== edge) el.style.setProperty('--edge', edge!)
          const up = String(engine.trayUp.get(n.tray!)?.value || 0)
          if (el.style.getPropertyValue('--up') !== up) el.style.setProperty('--up', up)
          const color = n.tray === engine.traySel ? 'var(--sel)' : (marks ||= engine.markedBy('tray')).get(n.tray!)
          if (!color) continue
          lit.set(n.id, color)
          if (el.style.getPropertyValue('--lit') !== color) el.style.setProperty('--lit', color)
          if (!('lit' in el.dataset)) el.dataset.lit = ''
        }
        for (const el of layer.current?.querySelectorAll<HTMLElement>('[data-lit]') || []) if (!lit.has(el.dataset.note!)) delete el.dataset.lit
      },
      // A tray is going: the notes on it stay where they are, on no tray. save: this player removed it.
      trayGone: (id: string, save: boolean) => {
        const off = latest.current.filter((n) => n.tray === id).map((n) => ({ ...n, ...where(n), tray: null }))
        if (!off.length) return
        const by = new Map(off.map((n) => [n.id, n]))
        setNotes((ns) => ns.map((n) => by.get(n.id) || n))
        if (save) for (const n of off) saveNote(n)
      },
      // Puts a note back as it was (undo and redo).
      put: (note: NoteRow) => {
        setNotes((ns) => (ns.some((n) => n.id === note.id) ? ns.map((n) => (n.id === note.id ? note : n)) : [...ns, note]))
        saveNote(note)
      },
      select: (ids) => setSelected(new Set(ids)),
      // Notes other players have selected, id -> their colour.
      mark: (colors) => setMarked(colors),
      remove: (ids) => {
        const gone = new Set(ids)
        setNotes((ns) => ns.filter((n) => !gone.has(n.id)))
        for (const id of gone) sock.send({ type: 'note-delete', id })
      },
      // Starts editing a note, with the caret after its text.
      edit: (id) => {
        const a = layer.current?.querySelector<HTMLTextAreaElement>(`[data-note="${id}"] textarea`)
        if (!a) return
        lastClick.current = {}
        engine.setSelection(new Set())
        a.focus()
        a.setSelectionRange(a.value.length, a.value.length)
      },
      // A click selects just this note, a second click soon after edits it.
      click: (id) => {
        const now = performance.now()
        const last = lastClick.current
        lastClick.current = { id, t: now }
        if (last.id === id && now - last.t! < DOUBLE_MS) return engine.notes!.edit(id)
        // Leave any note being edited, so Delete removes this one rather than editing its text.
        if (document.activeElement?.closest?.('[data-note]')) (document.activeElement as HTMLElement).blur()
        engine.selectOnly('note', id)
      },
    }
    return () => {
      engine.notes = null
    }
  }, [engine, sock, S])

  useEffect(() => {
    const offs = [
      sock.on('note-react', (msg) => setReactions((rs) => toggled(rs, msg.id, msg.kind, msg.player, msg.on))),
      sock.on('note-reply', (msg) => setReplies((rs) => withReply(rs, msg.reply))),
      sock.on('note-reply-delete', (msg) => setReplies((rs) => withoutReply(rs, msg.id))),
      sock.on('note-delete', (msg) => {
        engine.seen('note', msg.id, null)
        setNotes((ns) => ns.filter((n) => n.id !== msg.id))
      }),
      sock.on('note', ({ note: incoming }) => {
        engine.seen('note', incoming.id, incoming)
        setNotes((ns) => {
          const editing = document.activeElement?.closest?.(`[data-note="${incoming.id}"]`)
          const i = ns.findIndex((n) => n.id === incoming.id)
          if (i < 0) return [...ns, incoming]
          const next = [...ns]
          next[i] = editing ? { ...incoming, text: ns[i].text } : incoming
          return next
        })
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [sock, engine])

  useEffect(() => {
    createRef.current = async (clientX, clientY) => {
      // Notes show in the first pane of a split screen (top left), so one without a place goes in its middle.
      const first = engine.panes[0]
      const [wx, wy] = clientX == null ? engine.worldAt(first.w / 2, first.h / 2) : engine.clientToWorld(clientX, clientY!)
      const author = await requireName()
      if (!author) return
      const note: NoteRow = {
        id: newId(),
        x: wx - (NOTE_W * S) / 2,
        y: wy - S * 0.2,
        text: '',
        tray: null,
        author,
        created: Date.now(),
      }
      setNotes((ns) => [...ns, note])
      setFocusId(note.id)
      saveNote(note)
      engine.trackObj('note', note.id, note)
    }
    return () => {
      createRef.current = null
    }
  }, [engine, sock, S, createRef, requireName])

  const change = (id: string, patch: Partial<NoteRow>) => setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  const save = (note: NoteRow) => {
    saveNote(note)
    engine.trackObj('note', note.id, note)
  }
  const live = (note: NoteRow) => saveNote(note, true)
  const react = (id: string, kind: NoteReactionKind, on: boolean) => {
    setReactions((rs) => toggled(rs, id, kind, me!, on))
    sock.send({ type: 'note-react', id, kind, on })
  }
  const reply = (note: string, text: string) => {
    const r: NoteReply = { id: newId(), note, author: me!, text, created: Date.now() }
    setReplies((rs) => withReply(rs, r))
    sock.send({ type: 'note-reply', id: r.id, note, text })
  }
  const deleteReply = (id: string) => {
    setReplies((rs) => withoutReply(rs, id))
    sock.send({ type: 'note-reply-delete', id })
  }

  return (
    <div ref={layer} className="notes" style={{ '--u': `${S}px`, '--nw': NOTE_W } as CSSProperties}>
      {notes.map((n) => (
        <Note
          key={n.id}
          note={n}
          at={where(n)}
          edge={edgeOf(n)}
          engine={engine}
          focus={focusId === n.id}
          selected={selected.has(n.id)}
          mark={marked.get(n.id)}
          canEdit={!!me}
          author={nameOf(n.author)}
          reactions={reactions[n.id]}
          replies={replies[n.id]}
          me={me}
          nameOf={nameOf}
          ensureName={ensureName}
          onChange={change}
          onSave={save}
          onLive={live}
          onReact={react}
          onReply={reply}
          onDeleteReply={deleteReply}
        />
      ))}
    </div>
  )
})

// Header button: drag it onto the board to drop a note there, or click to drop one in the centre.
interface NoteButtonProps {
  createRef: RefObject<CreateNote | null>
}

export function NoteButton({ createRef }: NoteButtonProps) {
  return (
    <PlaceButton
      onPlace={(x, y) => createRef.current?.(x, y)}
      ghost="note-ghost"
      label="Note"
      shortcut="N"
      title="Drag a note onto the board"
    >
      <NoteIcon />
    </PlaceButton>
  )
}
