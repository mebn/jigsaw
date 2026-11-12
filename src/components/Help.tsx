
import type { ReactNode } from 'react'
import Dialog from './Dialog.tsx'
import { isPlainKey } from '../lib/overlays.ts'

const Key = ({ children }: { children: ReactNode }) => <kbd className="key">{children}</kbd>

const IS_MAC = /mac|iphone|ipad/i.test((navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform || navigator.platform || '')
const MOD = IS_MAC ? 'Cmd' : 'Ctrl'

// Keys pressed together, shown as Shift + Space.
const Combo = ({ keys }: { keys: string[] }) =>
  keys.map((k, i) => (
    <span key={k} className="key-group">
      {i > 0 && <span className="key-sep">+</span>}
      <Key>{k}</Key>
    </span>
  ))

// Keys that each do the same thing, shown as Delete / Backspace.
const Either = ({ keys }: { keys: string[] }) =>
  keys.map((k, i) => (
    <span key={k} className="key-group">
      {i > 0 && <span className="key-sep">/</span>}
      <Key>{k}</Key>
    </span>
  ))

// A range of keys, shown as 1 - 9.
const Range = ({ from, to }: { from: string; to: string }) => (
  <span className="key-group">
    <Key>{from}</Key>
    <span className="key-sep">-</span>
    <Key>{to}</Key>
  </span>
)

const SECTIONS = [
  {
    title: 'Mouse',
    rows: [
      [<Key key="lp">Drag a piece</Key>, 'Move'],
      [<Key key="lc">Click a piece</Key>, 'Select'],
      [<Key key="lt">Drag the table</Key>, 'Select an area'],
      [<Combo key="sc" keys={['Shift', 'Click']} />, 'Add to selection'],
      [<Combo key="st" keys={['Shift', 'Drag a tray']} />, 'Move the tray'],
      [<Combo key="ir" keys={['Shift', 'Drag an image']} />, 'Resize'],
      [<Combo key="ia" keys={['Alt', 'Drag an image']} />, 'Fade'],
      [<Key key="nc">Double click a note</Key>, 'Edit'],
      [<Key key="r">Right drag</Key>, 'Pan'],
      [<Key key="rc">Right click while dragging</Key>, 'Rotate'],
      [<Key key="w">Scroll</Key>, 'Zoom'],
    ],
  },
  {
    title: 'Keyboard',
    rows: [
      [
        <span key="pan" className="key-stack">
          <span className="key-group">
            <Key>W</Key>
            <Key>A</Key>
            <Key>S</Key>
            <Key>D</Key>
          </span>
          <span className="key-group">
            <Key>↑</Key>
            <Key>←</Key>
            <Key>↓</Key>
            <Key>→</Key>
          </span>
        </span>,
        'Pan',
      ],
      [<Key key="sp">Space</Key>, 'Rotate'],
      [<Combo key="ss" keys={['Shift', 'Space']} />, 'Rotate together'],
      [<Key key="g">G</Key>, 'Sort into a grid'],
      [<Combo key="sg" keys={['Shift', 'G']} />, 'Shuffle into a grid'],
      [<Range key="tn" from="1" to="9" />, 'Send to tray'],
      [<Key key="rn">R</Key>, 'Rename the selected tray'],
      [<Combo key="sa" keys={[MOD, 'A']} />, 'Select all'],
      [<Combo key="sf" keys={[MOD, 'F']} />, 'Search notes and trays'],
      [<Either key="del" keys={['Delete', 'Backspace']} />, 'Remove'],
      [<Combo key="un" keys={[MOD, 'Z']} />, 'Undo'],
      [<Combo key="re" keys={[MOD, 'Shift', 'Z']} />, 'Redo'],
    ],
  },
  {
    title: 'Tools',
    rows: [
      [<Key key="t">T</Key>, 'New tray'],
      [<Key key="i">I</Key>, 'New image'],
      [<Key key="q">Q</Key>, 'Picture as a map'],
      [<Key key="n">N</Key>, 'New note'],
      [<Key key="r">R</Key>, 'Reactions'],
      [<Key key="p">P</Key>, 'All players'],
      [<Key key="v">V</Key>, 'View mode'],
      [<Key key="x">X</Key>, 'Split screen'],
      [<Key key="e">E</Key>, 'Draw (fades away)'],
      [<Key key="h">H</Key>, 'How to play'],
      [<Either key="z" keys={['+', '-']} />, 'Zoom'],
      [<Key key="c">C</Key>, 'Fit to screen'],
      [<Key key="f">F</Key>, 'Fullscreen'],
    ],
  },
  {
    title: 'Touch',
    rows: [
      [<Key key="ts">Tap a piece</Key>, 'Select'],
      [<Key key="tp">Drag a selected piece</Key>, 'Move'],
      [<Key key="tt">Drag anything else</Key>, 'Pan'],
      [<Key key="tz">Pinch</Key>, 'Zoom'],
      [<Key key="t2">2nd finger tap</Key>, 'Rotate'],
    ],
  },
]

// Touch screens get the touch gestures, everything else the mouse and keyboard ones.
const TOUCH = window.matchMedia('(hover: none)').matches

type Row = [ReactNode, string]

// Keys in one column, what they do in the next, every other row shaded.
const Rows = ({ rows }: { rows: Row[] }) => (
  <dl>
    {rows.map(([k, text], i) => (
      <div key={i} className="help-row">
        <dt>{k}</dt>
        <dd>{text}</dd>
      </div>
    ))}
  </dl>
)

// The controls, in sections. Shown in the settings window (see Settings.tsx).
export default function HelpPanel() {
  return SECTIONS.filter((s) => (s.title === 'Touch') === TOUCH).map((s) => (
    <section key={s.title} className={`help-${s.title.toLowerCase()}`}>
      <h2 className="label">{s.title}</h2>
      <Rows rows={s.rows as Row[]} />
    </section>
  ))
}

// Just enough to start: moving, rotating, panning and zooming.
const BASICS: Row[] = TOUCH
  ? [
      [<Key key="ts">Tap a piece</Key>, 'Select'],
      [<Key key="tp">Drag a selected piece</Key>, 'Move'],
      [<Key key="t2">2nd finger tap</Key>, 'Rotate'],
      [<Key key="tt">Drag anything else</Key>, 'Pan'],
      [<Key key="tz">Pinch</Key>, 'Zoom'],
    ]
  : [
      [<Key key="lp">Drag a piece</Key>, 'Move'],
      [<Key key="sp">Space</Key>, 'Rotate'],
      [<Key key="r">Right drag</Key>, 'Pan'],
      [<Key key="w">Scroll</Key>, 'Zoom'],
    ]

// Shown by itself the first time a player opens a jigsaw (see Room): the basic controls, and how to
// find the rest. H, or the button on touch screens, opens how to play in the settings instead.
interface BasicsProps {
  onClose: () => void
  onAll: () => void
  closing: boolean
}

export function BasicsDialog({ onClose, onAll, closing }: BasicsProps) {
  return (
    <Dialog
      title="How to play"
      className="basics-dialog"
      bodyClass="basics-body"
      closing={closing}
      onClose={onClose}
      onKey={(e) => {
        if (e.key.toLowerCase() !== 'h' || !isPlainKey(e)) return
        e.preventDefault()
        onAll()
      }}
    >
      <Rows rows={BASICS} />
      {TOUCH ? (
        <button type="button" className="secondary basics-more" onClick={onAll}>
          All controls
        </button>
      ) : (
        <p className="basics-more">
          Press <Key>H</Key> for all shortcuts
        </p>
      )}
    </Dialog>
  )
}
