import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import TextField from './TextField.tsx'
import { TRAY_COLORS } from '../lib/engine.ts'
import type { Engine, MenuKind, Tray } from '../lib/engine.ts'

// What a menu is open on, and where: x and y on the board. id is the tray's, image's or note's
// (none for pieces: the menu acts on the selection). rename: start in a tray's name field.
export interface MenuAt {
  x: number
  y: number
  kind: MenuKind
  id: string | undefined
  rename: boolean
}

interface MenuItem {
  label: string
  keys: string
  run: () => void
  off?: boolean
  sub?: undefined
}

interface SubMenu {
  label: string
  sub: MenuItem[]
}

interface ContextMenuProps {
  engine: Engine
  at: MenuAt
  onClose: () => void
}

// The right click menu on a piece, tray, image or note: its actions with their shortcuts. A tray's
// menu starts with its name and colour, an image's with its opacity. An item with sub items opens
// them in a second menu beside it.
export default function ContextMenu({ engine, at, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  // The item whose second menu is open, and where that menu goes.
  const [open, setOpen] = useState<string | null>(null)
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)
  const r = engine.canvas.getBoundingClientRect()

  const tray = at.kind === 'tray' ? engine.trays.find((t) => t.id === at.id) : undefined
  const empty = at.kind === 'tray' && !tray?.pieces.length
  const [name, setName] = useState(tray?.name || '')
  const [color, setColor] = useState(tray?.color)
  // The name being typed, saved on Enter, when the field loses focus or when the menu closes; null
  // once saved, or when Escape drops it.
  const draft = useRef<string | null>(null)
  const saveName = () => {
    if (draft.current === null) return
    engine.setTrayLook(at.id!, { name: draft.current.trim() })
    draft.current = null
  }
  const image = at.kind === 'ref' ? engine.refs.find((r) => r.id === at.id) : undefined
  const [opacity, setOpacity] = useState(image?.opacity ?? 1)
  const trimmed = image && engine.refTrim(image).some((v, k) => v !== (k < 2 ? 0 : 1))
  // The opacity being slid to, saved when the slider is let go or the menu closes; null once saved.
  const fade = useRef<number | null>(null)
  const saveOpacity = () => {
    if (fade.current === null) return
    engine.setRefOpacity(at.id!, fade.current)
    fade.current = null
  }
  useEffect(
    () => () => {
      saveName()
      saveOpacity()
    },
    [],
  )
  // Opened with R on a tray: straight into its name, selected to type over.
  useEffect(() => {
    if (!at.rename) return
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])
  const turn: MenuItem[] = [
    { label: 'Turn', keys: 'Space', run: () => engine.rotateSelection(1), off: empty },
    { label: 'Turn as one', keys: 'Shift + Space', run: () => engine.rotateSelection(1, true), off: empty },
    { label: 'Sort into a grid', keys: 'G', run: () => engine.sortSelection(), off: empty },
    { label: 'Sort in random order', keys: 'Shift + G', run: () => engine.sortSelection(true), off: empty },
  ]
  // Trays to send pieces to: numbered ones first, by number, as "Tray 1 (name)" if they have a name,
  // then the named ones without a number.
  const trayName = (t: Tray) => t.name?.trim()
  const sendTo: MenuItem[] = [
    ...engine.trays.filter((t) => t.num).sort((a, b) => a.num! - b.num!),
    ...engine.trays.filter((t) => !t.num && trayName(t)).sort((a, b) => trayName(a)!.localeCompare(trayName(b)!)),
  ].map((t) => ({
    label: t.num ? `Tray ${t.num}${trayName(t) ? ` (${trayName(t)})` : ''}` : trayName(t)!,
    keys: t.num ? String(t.num) : '',
    run: () => engine.sendToTray(t.id),
  }))
  const remove = (label: string): MenuItem => ({ label, keys: 'Del', run: () => engine.removeSelected() })
  const items: (MenuItem | SubMenu)[] =
    at.kind === 'piece'
      ? [
          ...turn,
          ...(sendTo.length ? [{ label: 'Send to', sub: sendTo }] : []),
          { label: 'Select all', keys: 'Ctrl + A', run: () => engine.selectAll() },
        ]
      : at.kind === 'tray'
        ? [...turn, { label: 'Auto sort', keys: tray?.auto ? 'On' : 'Off', run: () => engine.setTrayAuto(at.id!, !tray?.auto) }, remove('Remove tray')]
        : at.kind === 'ref'
          ? [
              { label: 'Trim', keys: '', run: () => engine.startTrim(at.id!) },
              ...(trimmed ? [{ label: 'Show whole image', keys: '', run: () => engine.untrim(at.id!) }] : []),
              remove('Remove image'),
            ]
          : [{ label: 'Edit note', keys: 'Double click', run: () => requestAnimationFrame(() => engine.notes?.edit(at.id!)) }, remove('Remove note')]

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    setPos({
      left: Math.max(4, Math.min(at.x, r.width - m.offsetWidth - 4)),
      top: Math.max(4, Math.min(at.y, r.height - m.offsetHeight - 4)),
    })
  }, [at, r.width, r.height])

  // While open on a tray or image, its buttons stay shown.
  useEffect(() => {
    engine.setMenuFor(at.kind, at.id)
    return () => engine.setMenuFor(null)
  }, [engine, at.kind, at.id])

  // The second menu opens to the right of its item, or to the left when there is no room, and is kept
  // on screen.
  useLayoutEffect(() => {
    const m = ref.current
    const sub = subRef.current
    const item = open && m?.querySelector(`[data-sub="${open}"]`)
    if (!sub || !item) return setSubPos(null)
    const mr = m!.getBoundingClientRect()
    const ir = item.getBoundingClientRect()
    const right = mr.right + sub.offsetWidth + 2 <= window.innerWidth - 4
    setSubPos({
      left: right ? mr.width - 3 : -sub.offsetWidth + 3,
      top: Math.max(4 - mr.top, Math.min(ir.top - mr.top - 5, window.innerHeight - 4 - sub.offsetHeight - mr.top)),
    })
  }, [open, pos])

  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.target === nameRef.current) draft.current = null
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('wheel', onClose, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('wheel', onClose, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: pos.left + r.left, top: pos.top + r.top }} onContextMenu={(e) => e.preventDefault()}>
      {tray && (
        <div className="menu-look tray-look">
          <TextField
            ref={nameRef}
            compact
            value={name}
            maxLength={40}
            placeholder="Name this tray"
            aria-label="Tray name"
            onChange={(e) => {
              setName(e.target.value)
              draft.current = e.target.value
            }}
            onBlur={saveName}
            onKeyDown={(e) => e.key === 'Enter' && onClose()}
          />
          <div className="tray-colors" role="radiogroup" aria-label="Tray colour">
            {Object.entries(TRAY_COLORS).map(([key, hex]) => (
              <button
                key={key}
                role="radio"
                aria-checked={color === key}
                aria-label={key}
                title={key[0].toUpperCase() + key.slice(1)}
                style={{ '--c': hex } as CSSProperties}
                onClick={() => {
                  setColor(key)
                  engine.setTrayLook(at.id!, { color: key })
                }}
              />
            ))}
          </div>
        </div>
      )}
      {image && (
        <label className="menu-look ref-look">
          <span>Opacity</span>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={Math.round(opacity * 100)}
            aria-label="Image opacity"
            onChange={(e) => {
              const v = +e.target.value / 100
              setOpacity(v)
              fade.current = v
              engine.setRefOpacity(at.id!, v, true)
            }}
            onPointerUp={saveOpacity}
            onKeyUp={saveOpacity}
            onBlur={saveOpacity}
          />
          <span className="ref-pct">{Math.round(opacity * 100)}%</span>
        </label>
      )}
      {items.map((it) =>
        it.sub ? (
          <button
            key={it.label}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === it.label}
            data-sub={it.label}
            className={open === it.label ? 'open' : undefined}
            onPointerEnter={() => setOpen(it.label)}
            onClick={() => setOpen(it.label)}
            onKeyDown={(e) => e.key === 'ArrowRight' && (setOpen(it.label), requestAnimationFrame(() => subRef.current?.querySelector('button')?.focus()))}
          >
            <span>{it.label}</span>
            <span className="sub-arrow" aria-hidden="true">
              ›
            </span>
          </button>
        ) : (
          <button
            key={it.label}
            role="menuitem"
            disabled={it.off}
            onPointerEnter={() => setOpen(null)}
            onClick={() => {
              onClose()
              it.run()
            }}
          >
            <span>{it.label}</span>
            <kbd>{it.keys}</kbd>
          </button>
        ),
      )}
      {open && (
        <div
          ref={subRef}
          className="context-menu sub-menu"
          role="menu"
          aria-label={open}
          style={subPos ? { left: subPos.left, top: subPos.top } : { visibility: 'hidden' }}
          onKeyDown={(e) => e.key === 'ArrowLeft' && (setOpen(null), ref.current?.querySelector<HTMLElement>(`[data-sub="${open}"]`)?.focus())}
        >
          {(items.find((it) => it.label === open) as SubMenu | undefined)?.sub.map((it) => (
              <button
                key={it.label + it.keys}
                role="menuitem"
                onClick={() => {
                  onClose()
                  it.run()
                }}
              >
                <span className="sub-label">{it.label}</span>
                <kbd>{it.keys}</kbd>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
