import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { Note as NoteIcon } from './icons.jsx'
import PlaceButton from './PlaceButton.jsx'

// Smallest note width, in units of the jigsaw's piece size. Notes grow wider as a line gets longer,
// and taller with each new line.
const NOTE_W = 2.2

// Two clicks on a note within this time (ms) start editing it.
const DOUBLE_MS = 400

// Makes the text area exactly as wide as its longest line and as tall as its text, so nothing scrolls
// out of sight. An empty note keeps its smallest width, so the placeholder wraps inside it.
function fitSize(el) {
  el.style.width = ''
  if (el.value) {
    el.style.width = '0'
    // A little extra room for the caret at the end of the line.
    el.style.width = `${el.scrollWidth + 2}px`
  }
  el.style.height = '0'
  el.style.height = `${el.scrollHeight}px`
}

function Note({ note, engine, focus, selected, mark, canEdit, author, ensureName, onChange, onSave, onLive }) {
  const area = useRef(null)
  const saveTimer = useRef(0)

  useEffect(() => {
    if (focus) area.current?.focus()
  }, [focus])

  const unit = engine.geo.S
  useLayoutEffect(() => {
    if (area.current) fitSize(area.current)
  }, [note.text, unit])

  // Drag anywhere on the note to move it; a click without moving selects it, a double click edits it.
  // While editing, the text area behaves normally and the rest of the note still drags.
  const startMove = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return
    if (e.target === area.current && document.activeElement === area.current) return
    e.preventDefault()
    if (!ensureName()) return
    // Shift-click adds the note to the selection; dragging a selected note carries the whole selection.
    if (e.shiftKey) return engine.toggleNote(note.id)
    if (selected && engine.selCount > 1) return engine.grabSelection(e, { note: note.id })
    if (engine.selCount && !selected) engine.setSelection(new Set())
    engine.grabNote(e, note.id)
  }

  const edit = (e) => {
    const text = e.target.value
    onChange(note.id, { text })
    onLive({ ...note, text })
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => onSave({ ...note, text }), 400)
  }

  const menu = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    engine.openNoteMenu(note.id, r.left, r.bottom + 4)
  }

  return (
    <div
      className={`note${selected ? ' sel' : mark ? ' marked' : ''}`}
      style={{ left: note.x, top: note.y, '--mark': mark }}
      data-note={note.id}
      onContextMenu={(e) => {
        e.preventDefault()
        engine.openNoteMenu(note.id, e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        if (e.buttons || e.target.closest('button')) return engine.showTip(null)
        const r = engine.canvas.getBoundingClientRect()
        engine.showTip({ text: author, sx: e.clientX - r.left, sy: e.clientY - r.top })
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
        maxLength={2000}
        aria-label="Note"
      />
    </div>
  )
}

export function NotesLayer({ engine, roomId, me, nameOf, initial, busRef, createRef, ensureName, requireName }) {
  const [notes, setNotes] = useState(initial)
  const [focusId, setFocusId] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [marked, setMarked] = useState(() => new Map())
  const layer = useRef(null)
  const lastClick = useRef({})
  const latest = useRef(notes)
  latest.current = notes
  const S = engine.geo.S

  useEffect(() => {
    engine.resetSeen('note', initial)
  }, [engine, initial])

  useEffect(() => {
    const el = layer.current
    const off = engine.addView((cam, vw, vh) => {
      el.style.transform = `translate(${vw / 2 - cam.x * cam.z}px, ${vh / 2 - cam.y * cam.z}px) scale(${cam.z})`
    })
    const wheel = (e) => engine.h.wheel(e)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      off()
      el.removeEventListener('wheel', wheel)
    }
  }, [engine])

  // Lets the engine select notes with the selection box and carry them along with a drag.
  useEffect(() => {
    const size = (id) => {
      const el = layer.current?.querySelector(`[data-note="${id}"]`)
      return { w: el?.offsetWidth || NOTE_W * S, h: el?.offsetHeight || S }
    }
    engine.notes = {
      get: () =>
        latest.current.map((n) => ({
          id: n.id,
          x: n.x,
          y: n.y,
          ...size(n.id),
        })),
      // send: null moves locally only, 'live' also relays, 'save' also stores.
      move: (list, send) => {
        const at = new Map(list.map((p) => [p.id, p]))
        setNotes((ns) => ns.map((n) => (at.has(n.id) ? { ...n, x: at.get(n.id).x, y: at.get(n.id).y } : n)))
        if (!send) return
        for (const n of latest.current) {
          const p = at.get(n.id)
          if (!p) continue
          const moved = { ...n, x: p.x, y: p.y }
          api.saveNote(roomId, moved, send === 'live')
          if (send === 'save') engine.trackObj('note', n.id, moved)
        }
      },
      // Puts a note back as it was (undo and redo).
      put: (note) => {
        setNotes((ns) => (ns.some((n) => n.id === note.id) ? ns.map((n) => (n.id === note.id ? note : n)) : [...ns, note]))
        api.saveNote(roomId, note)
      },
      select: (ids) => setSelected(new Set(ids)),
      // Notes other players have selected, id -> their colour.
      mark: (colors) => setMarked(colors),
      remove: (ids) => {
        const gone = new Set(ids)
        setNotes((ns) => ns.filter((n) => !gone.has(n.id)))
        for (const id of gone) api.deleteNote(roomId, id)
      },
      // Starts editing a note, with the caret after its text.
      edit: (id) => {
        const a = layer.current?.querySelector(`[data-note="${id}"] textarea`)
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
        if (last.id === id && now - last.t < DOUBLE_MS) return engine.notes.edit(id)
        // Leave any note being edited, so Delete removes this one rather than editing its text.
        if (document.activeElement?.closest?.('[data-note]')) document.activeElement.blur()
        engine.selectRef(null)
        engine.selectTray(null)
        engine.setSelection(new Set(), new Set(), new Set([id]))
      },
    }
    return () => (engine.notes = null)
  }, [engine, roomId, S])

  useEffect(() => {
    busRef.current = (msg) => {
      if (msg.type === 'note-delete') {
        engine.seen('note', msg.id, null)
        return setNotes((ns) => ns.filter((n) => n.id !== msg.id))
      }
      if (msg.type === 'notes-reset') {
        engine.resetSeen('note', msg.notes)
        // Keep the text of a note that's being edited right now.
        const editing = document.activeElement?.closest?.('[data-note]')?.dataset.note
        return setNotes((ns) =>
          msg.notes.map((n) => (n.id === editing ? { ...n, text: ns.find((o) => o.id === n.id)?.text ?? n.text } : n)),
        )
      }
      const incoming = msg.note
      engine.seen('note', incoming.id, incoming)
      setNotes((ns) => {
        const editing = document.activeElement?.closest?.(`[data-note="${incoming.id}"]`)
        const i = ns.findIndex((n) => n.id === incoming.id)
        if (i < 0) return [...ns, incoming]
        const next = [...ns]
        next[i] = editing ? { ...incoming, text: ns[i].text } : incoming
        return next
      })
    }
    return () => (busRef.current = null)
  }, [busRef, engine])

  useEffect(() => {
    createRef.current = async (clientX, clientY) => {
      const rect = engine.canvas.getBoundingClientRect()
      const sx = clientX == null ? rect.width / 2 : clientX - rect.left
      const sy = clientY == null ? rect.height / 2 : clientY - rect.top
      const [wx, wy] = engine.toWorld(sx, sy)
      const author = await requireName()
      if (!author) return
      const note = {
        id: Math.random().toString(36).slice(2, 10),
        x: wx - (NOTE_W * S) / 2,
        y: wy - S * 0.2,
        text: '',
        author,
        created: Date.now(),
      }
      setNotes((ns) => [...ns, note])
      setFocusId(note.id)
      api.saveNote(roomId, note)
      engine.trackObj('note', note.id, note)
    }
    return () => (createRef.current = null)
  }, [engine, roomId, S, createRef, requireName])

  const change = (id, patch) => setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  const save = (note) => {
    api.saveNote(roomId, note)
    engine.trackObj('note', note.id, note)
  }
  const live = (note) => api.saveNote(roomId, note, true)

  return (
    <div ref={layer} className="notes" style={{ '--u': `${S}px`, '--nw': NOTE_W }}>
      {notes.map((n) => (
        <Note
          key={n.id}
          note={n}
          engine={engine}
          focus={focusId === n.id}
          selected={selected.has(n.id)}
          mark={marked.get(n.id)}
          canEdit={!!me}
          author={nameOf(n.author)}
          ensureName={ensureName}
          onChange={change}
          onSave={save}
          onLive={live}
        />
      ))}
    </div>
  )
}

// Header button: drag it onto the board to drop a note there, or click to drop one in the centre.
export function NoteButton({ createRef, hint }) {
  return (
    <PlaceButton
      onPlace={(x, y) => createRef.current?.(x, y)}
      ghost="note-ghost"
      label="Note"
      shortcut="N"
      title="Drag a note onto the board"
    >
      <NoteIcon />
      {hint}
    </PlaceButton>
  )
}
