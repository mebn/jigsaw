import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.ts'
import { SHAPES, buildPuzzle, gridFor, outlinePath, samplePiecePath, scatter } from '../lib/geometry.ts'
import { useApp } from '../lib/app.ts'
import { navigate, paths } from '../lib/router.ts'
import { Arrow, Close, Lock, Upload } from '../components/icons.tsx'

type Shape = (typeof SHAPES)[number]

const MIN = 4
const MAX = 4000
// The slider is logarithmic: 0..100 maps to MIN..MAX pieces.
const toCount = (v: number) => Math.round(Math.exp(Math.log(MIN) + ((Math.log(MAX) - Math.log(MIN)) * v) / 100))
const toSlider = (n: number) => ((Math.log(n) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN))) * 100
const clampCount = (n: number) => Math.min(MAX, Math.max(MIN, Math.round(n)))
// The stored image's long side: 2400px, or more for big jigsaws so each piece keeps about 55px.
const maxSide = (cols: number, rows: number) => Math.min(4000, Math.max(2400, Math.max(cols, rows) * 55))

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((ok, fail) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => ok(img)
    img.onerror = fail
    img.src = url
  })
}

function encode(img: HTMLImageElement, maxSide: number, quality: number) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.round(img.naturalWidth * k)
  c.height = Math.round(img.naturalHeight * k)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(img, 0, 0, c.width, c.height)
  return { data: c.toDataURL('image/jpeg', quality), width: c.width, height: c.height }
}

function ShapeIcon({ shape }: { shape: Shape }) {
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

const shapeName = (s: string) => s[0].toUpperCase() + s.slice(1)

// The image with the cuts drawn over it, as big as fits its box, in the middle of it. Drawn again
// when the box changes size.
interface PreviewProps {
  img: HTMLImageElement
  cols: number
  rows: number
  shape: Shape
  seed: number
}

function Preview({ img, cols, rows, shape, seed }: PreviewProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const paint = (c: HTMLCanvasElement, width: number, height: number) => {
    const k = Math.min(width / img.naturalWidth, height / img.naturalHeight)
    const w = Math.round(img.naturalWidth * k)
    const h = Math.round(img.naturalHeight * k)
    const dpr = window.devicePixelRatio || 1
    c.width = w * dpr
    c.height = h * dpr
    c.style.width = `${w}px`
    c.style.height = `${h}px`
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.drawImage(img, 0, 0, w, h)
    const geo = buildPuzzle({ cols, rows, width: w, height: h, shape, seed })
    ctx.lineWidth = 1
    ctx.lineJoin = 'round'
    for (const p of geo.pieces) {
      const path = outlinePath(p.outline)
      ctx.setTransform(dpr, 0, 0, dpr, p.cx * dpr, p.cy * dpr)
      ctx.strokeStyle = 'rgba(0,0,0,.45)'
      ctx.stroke(path)
      ctx.setTransform(dpr, 0, 0, dpr, (p.cx + 0.6) * dpr, (p.cy + 0.6) * dpr)
      ctx.strokeStyle = 'rgba(255,255,255,.35)'
      ctx.stroke(path)
    }
  }
  useEffect(() => {
    const c = ref.current!
    const box = c.parentElement!
    let size = ''
    const draw = () => {
      const width = box.clientWidth
      const height = Math.max(200, box.clientHeight)
      if (!width || `${width}x${height}` === size) return
      size = `${width}x${height}`
      paint(c, width, height)
    }
    const watch = new ResizeObserver(draw)
    watch.observe(box)
    draw()
    return () => watch.disconnect()
  }, [img, cols, rows, shape, seed])
  return <canvas ref={ref} />
}

// The new jigsaw form, in a window over the jigsaws page, in one column: the image large at the
// top, and under it the settings: how many pieces, their shape and whether it's private. The
// Create button goes in slot, in the window's header.
export default function NewRoom({ slot }: { slot: HTMLElement | null }) {
  const { requireName, currentPlayer } = useApp()
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  // Pieces asked for, by slider or typed. The jigsaw gets the closest grid to it.
  const [count, setCount] = useState(() => toCount(44))
  // What's in the number field while typing; null shows the actual piece count.
  const [typed, setTyped] = useState<string | null>(null)
  const [shape, setShape] = useState<Shape>('classic')
  const [hidden, setHidden] = useState(false)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [seed] = useState(() => (Math.random() * 2 ** 31) | 0)
  const input = useRef<HTMLInputElement>(null)

  const grid = gridFor(count, img?.naturalWidth || 4, img?.naturalHeight || 3)
  const slider = toSlider(count)

  const pick = async (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return
    const image = await loadImage(file)
    setImg(image)
  }

  const clear = () => {
    setImg(null)
    input.current!.value = ''
  }

  // Paste an image anywhere on the page. In a text field, text still pastes as usual.
  const pickRef = useRef(pick)
  pickRef.current = pick
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const data = e.clipboardData
      const file = [...(data?.files || [])].find((f) => f.type.startsWith('image/'))
      if (!file) return
      if ((e.target as Element | null)?.closest?.('input, textarea') && data!.types.includes('text/plain')) return
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
    setFailed(false)
    try {
      const full = encode(img, maxSide(grid.cols, grid.rows), 0.9)
      const thumb = encode(img, 480, 0.8)
      const room = { cols: grid.cols, rows: grid.rows, width: full.width, height: full.height, shape, seed, longPieces: false }
      const { id } = await api.create({
        ...room,
        name: 'Jigsaw',
        image: full.data,
        thumb: thumb.data,
        private: hidden,
        invite: [],
        pieces: scatter(room),
        passphrase: currentPlayer()?.passphrase,
      })
      navigate(paths.room(id))
    } catch {
      setBusy(false)
      setFailed(true)
    }
  }

  return (
    <section className="create">
      <div
        className={`stage${over ? ' over' : ''}${img ? ' has' : ''}`}
        onClick={() => input.current!.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current!.click()}
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
          <div className="stage-pic">
            <Preview img={img} {...grid} shape={shape} seed={seed} />
          </div>
        ) : (
          <span className="stage-empty">
            <span className="stage-icon">
              <Upload />
            </span>
            <span className="stage-title">Choose a picture</span>
            <span className="stage-hint">Click, drop one here, or paste it</span>
          </span>
        )}
        <input ref={input} type="file" accept="image/*" onChange={(e) => pick(e.target.files![0])} />
        {img && (
          <button
            type="button"
            className="icon-btn stage-clear"
            onClick={(e) => {
              e.stopPropagation()
              clear()
            }}
            aria-label="Remove image"
            title="Remove image"
          >
            <Close />
          </button>
        )}
      </div>

      <div className="create-side">
        <section className="create-part">
          <h2 className="label">Pieces</h2>
          <div className="count">
            <input
              className="count-num"
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
            <span className="count-grid" title="Columns by rows">
              {grid.cols} × {grid.rows}
            </span>
          </div>
          <input
            type="range"
            style={{ '--p': `${slider}%` } as CSSProperties}
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
        </section>

        <section className="create-part">
          <h2 className="label">Shape</h2>
          <div className="shapes" role="radiogroup" aria-label="Shape">
            {SHAPES.map((s) => (
              <button
                key={s}
                type="button"
                className={`shape${s === shape ? ' on' : ''}`}
                role="radio"
                aria-checked={s === shape}
                onClick={() => setShape(s)}
                title={shapeName(s)}
              >
                <ShapeIcon shape={s} />
                <span>{shapeName(s)}</span>
              </button>
            ))}
          </div>
        </section>

        <button className={`toggle${hidden ? ' on' : ''}`} role="switch" aria-checked={hidden} onClick={() => setHidden((v) => !v)}>
          <span className="toggle-text">
            <span className="toggle-title">
              <Lock />
              Private room
            </span>
            <span className="toggle-hint">Only people with the link can join.</span>
          </span>
          <span className="toggle-track" aria-hidden="true">
            <span className="toggle-knob" />
          </span>
        </button>
        {failed && <p className="modal-error">Couldn't make the jigsaw, try again.</p>}
      </div>

      {slot &&
        createPortal(
          <button className="primary new-btn create-btn" onClick={create} disabled={!img || busy} title={img ? 'Create jigsaw' : 'Choose a picture first'}>
            {busy ? (
              <span className="spin" />
            ) : (
              <>
                <span>Create jigsaw</span>
                <Arrow />
              </>
            )}
          </button>,
          slot,
        )}
    </section>
  )
}
