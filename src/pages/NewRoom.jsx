import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { SHAPES, buildPuzzle, gridFor, longPaths, outlinePath, samplePiecePath, scatter } from '../lib/geometry.js'
import { useApp } from '../App.jsx'
import { Arrow, Chevron, Close, Upload } from '../components/icons.jsx'
import InviteList from '../components/Invite.jsx'

const MIN = 4
const MAX = 4000
// The slider is logarithmic: 0..100 maps to MIN..MAX pieces.
const toCount = (v) => Math.round(Math.exp(Math.log(MIN) + ((Math.log(MAX) - Math.log(MIN)) * v) / 100))
const toSlider = (n) => ((Math.log(n) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN))) * 100
const clampCount = (n) => Math.min(MAX, Math.max(MIN, Math.round(n)))
// The stored image's long side: 2400px, or more for big jigsaws so each piece keeps about 55px.
const maxSide = (cols, rows) => Math.min(4000, Math.max(2400, Math.max(cols, rows) * 55))

function loadImage(file) {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => ok(img)
    img.onerror = fail
    img.src = url
  })
}

function encode(img, maxSide, quality) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.round(img.naturalWidth * k)
  c.height = Math.round(img.naturalHeight * k)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(img, 0, 0, c.width, c.height)
  return { data: c.toDataURL('image/jpeg', quality), width: c.width, height: c.height }
}

function ShapeIcon({ shape }) {
  const d = useMemo(() => samplePiecePath(shape, 60), [shape])
  return (
    <svg viewBox="-24 -24 108 108" aria-hidden="true">
      <path
        d={d}
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const shapeName = (s) => s[0].toUpperCase() + s.slice(1)

// A dropdown of piece shapes, each shown with its outline. The list floats over the window
// (position: fixed), so opening it doesn't grow or scroll the form around it. It opens below the
// button, or above when there's no room, and follows the button when the form scrolls.
// Picking a shape leaves it open, so shapes can be tried one after another on the preview.
function ShapePicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const wrap = useRef(null)
  const btn = useRef(null)
  const menu = useRef(null)

  useLayoutEffect(() => {
    if (!open) return setPos(null)
    const place = () => {
      const b = btn.current.getBoundingClientRect()
      const h = menu.current.offsetHeight
      const below = window.innerHeight - b.bottom - 6 >= h + 8 || b.top < h + 14
      setPos({ top: below ? b.bottom + 6 : b.top - 6 - h, right: window.innerWidth - b.right, minWidth: b.width })
    }
    place()
    menu.current.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Close on a press anywhere else, or Escape (which then leaves the window open).
  useEffect(() => {
    if (!open) return
    const away = (e) => !wrap.current?.contains(e.target) && setOpen(false)
    const key = (e) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  return (
    <div className="shape-picker" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={`shape-btn${open ? ' on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Shape: ${shapeName(value)}`}
      >
        <ShapeIcon shape={value} />
        <span>{shapeName(value)}</span>
        <Chevron className="shape-chevron" />
      </button>
      {open && (
        <ul
          ref={menu}
          className="shape-menu"
          role="listbox"
          aria-label="Shape"
          style={pos || { top: 0, left: -9999 }}
        >
          {SHAPES.map((s) => (
            <li key={s}>
              <button
                type="button"
                className={`shape-option${s === value ? ' on' : ''}`}
                role="option"
                aria-selected={s === value}
                onClick={() => onChange(s)}
              >
                <ShapeIcon shape={s} />
                <span>{shapeName(s)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// The image with the cuts drawn over it, as wide as its box but at most 70% of the window's height
// (a tall image is centred in the box). Drawn again when the box or the window changes size.
function Preview({ img, cols, rows, shape, seed, longPieces }) {
  const ref = useRef(null)
  const paint = (c, width, height) => {
    const k = Math.min(width / img.naturalWidth, height / img.naturalHeight)
    const w = Math.round(img.naturalWidth * k)
    const h = Math.round(img.naturalHeight * k)
    const dpr = window.devicePixelRatio || 1
    c.width = w * dpr
    c.height = h * dpr
    c.style.width = `${w}px`
    c.style.height = `${h}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.drawImage(img, 0, 0, w, h)
    const geo = buildPuzzle({ cols, rows, width: w, height: h, shape, seed, longPieces })
    ctx.lineWidth = 1
    ctx.lineJoin = 'round'
    for (const p of geo.pieces) {
      ctx.setTransform(dpr, 0, 0, dpr, p.cx * dpr, p.cy * dpr)
      // A long piece's cells only draw their cut sides.
      const path = longPaths(p, 0)?.rim || outlinePath(p.outline)
      ctx.strokeStyle = 'rgba(0,0,0,.45)'
      ctx.stroke(path)
      ctx.setTransform(dpr, 0, 0, dpr, (p.cx + 0.6) * dpr, (p.cy + 0.6) * dpr)
      ctx.strokeStyle = 'rgba(255,255,255,.35)'
      ctx.stroke(path)
    }
  }
  useEffect(() => {
    const c = ref.current
    const box = c.parentElement
    let size = ''
    const draw = () => {
      const width = box.clientWidth
      const height = Math.max(240, Math.round(window.innerHeight * 0.7))
      if (!width || `${width}x${height}` === size) return
      size = `${width}x${height}`
      paint(c, width, height)
    }
    const watch = new ResizeObserver(draw)
    watch.observe(box)
    window.addEventListener('resize', draw)
    draw()
    return () => {
      watch.disconnect()
      window.removeEventListener('resize', draw)
    }
  }, [img, cols, rows, shape, seed, longPieces])
  return <canvas ref={ref} />
}

// The new jigsaw form, shown inside the jigsaws window: the image at the top, its settings under
// it, and the Create button in the window's bar (where New jigsaw was).
export default function NewRoom({ bar }) {
  const { requireName, currentPlayer, openRoom } = useApp()
  const [img, setImg] = useState(null)
  // Pieces asked for, by slider or typed. The jigsaw gets the closest grid to it.
  const [count, setCount] = useState(() => toCount(44))
  // What's in the number field while typing; null shows the actual piece count.
  const [typed, setTyped] = useState(null)
  const [shape, setShape] = useState('classic')
  const [longPieces, setLongPieces] = useState(false)
  const [hidden, setHidden] = useState(false)
  // Players to email the private jigsaw's link to, by id.
  const [invited, setInvited] = useState(() => new Set())
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [seed] = useState(() => (Math.random() * 2 ** 31) | 0)
  const input = useRef(null)

  const grid = gridFor(count, img?.naturalWidth || 4, img?.naturalHeight || 3)
  const slider = toSlider(count)

  const pick = async (file) => {
    if (!file || !file.type.startsWith('image/')) return
    const image = await loadImage(file)
    setImg(image)
  }

  // Back to no image.
  const clear = () => {
    setImg(null)
    input.current.value = ''
  }

  // Paste an image anywhere on the page. In a text field, text still pastes as usual.
  const pickRef = useRef(pick)
  pickRef.current = pick
  useEffect(() => {
    const paste = (e) => {
      const data = e.clipboardData
      const file = [...(data?.files || [])].find((f) => f.type.startsWith('image/'))
      if (!file) return
      if (e.target?.closest?.('input, textarea') && data.types.includes('text/plain')) return
      e.preventDefault()
      pickRef.current(file)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [])

  const create = async () => {
    if (!img || busy) return
    if (!(await requireName())) return
    setBusy(true)
    try {
      const full = encode(img, maxSide(grid.cols, grid.rows), 0.9)
      const thumb = encode(img, 480, 0.8)
      const room = { cols: grid.cols, rows: grid.rows, width: full.width, height: full.height, shape, seed, longPieces }
      const { id } = await api.create({
        ...room,
        name: 'Jigsaw',
        image: full.data,
        thumb: thumb.data,
        private: hidden,
        invite: hidden ? [...invited] : [],
        pieces: scatter(room),
        passphrase: currentPlayer()?.passphrase,
      })
      openRoom(id)
    } catch {
      setBusy(false)
    }
  }

  // A switch row in the options box.
  const option = (on, set, label, hint) => (
    <button className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={on} onClick={() => set((v) => !v)} title={label}>
      <span className="toggle-text">
        <span>{label}</span>
        <span className="toggle-hint">{hint}</span>
      </span>
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
    </button>
  )

  return (
    <section className="create">
      <div className="create-media">
        <h2 className="label">Image</h2>
        <div className="drop-wrap">
          <div
            className={`drop${over ? ' over' : ''}${img ? ' has' : ''}`}
            onClick={() => input.current.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current.click()}
            role="button"
            tabIndex={0}
            title={img ? 'Change image (or paste one)' : 'Upload, drop or paste an image'}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setOver(false)
              pick(e.dataTransfer.files[0])
            }}
          >
            {img ? (
              <Preview img={img} {...grid} shape={shape} seed={seed} longPieces={longPieces} />
            ) : (
              <span className="drop-empty">
                <span className="drop-icon">
                  <Upload className="big" />
                </span>
                <span className="drop-hint">Click to upload, drop an image here, or just paste one</span>
              </span>
            )}
            <input ref={input} type="file" accept="image/*" onChange={(e) => pick(e.target.files[0])} />
          </div>
          {img && (
            <button type="button" className="icon-btn drop-clear" onClick={clear} aria-label="Remove image" title="Remove image">
              <Close />
            </button>
          )}
        </div>
      </div>

      <div className="create-settings">
        <div className="row pieces-row">
          <section className="field grow">
            <h2 className="label">Pieces</h2>
            <div className="row slider">
              <input
                type="range"
                style={{ '--p': `${slider}%` }}
                min="0"
                max="100"
                value={slider}
                onChange={(e) => {
                  setCount(toCount(+e.target.value))
                  setTyped(null)
                }}
                aria-label="Pieces"
                title="Number of pieces"
              />
              <input
                className="num"
                type="text"
                inputMode="numeric"
                value={typed ?? grid.cols * grid.rows}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 4)
                  setTyped(v)
                  if (+v >= MIN) setCount(clampCount(+v))
                }}
                onFocus={(e) => e.target.select()}
                onBlur={() => {
                  if (typed && +typed) setCount(clampCount(+typed))
                  setTyped(null)
                }}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                aria-label="Number of pieces"
                title={`Type a number of pieces, ${MIN} to ${MAX}`}
              />
            </div>
          </section>
          <section className="field">
            <h2 className="label">Shape</h2>
            <ShapePicker value={shape} onChange={setShape} />
          </section>
        </div>

        <section className="field">
          <h2 className="label">Options</h2>
          <div className="options">
            {option(longPieces, setLongPieces, 'Big pieces', 'Some pieces are two to five in one: long, L, T and other shapes.')}
            {option(hidden, setHidden, 'Private room', 'Only people with the link can join.')}
            {hidden && (
              <div className="options-invite">
                <h3 className="label">Invite players</h3>
                <InviteList selected={invited} onChange={setInvited} />
              </div>
            )}
          </div>
        </section>
      </div>

      {bar &&
        createPortal(
          <button
            className="primary new-btn create-btn"
            onClick={create}
            disabled={!img || busy}
            title={img ? 'Create jigsaw' : 'Add an image first'}
          >
            {busy ? (
              <span className="spin" />
            ) : (
              <>
                <span>Create jigsaw</span>
                <Arrow />
              </>
            )}
          </button>,
          bar,
        )}
    </section>
  )
}
