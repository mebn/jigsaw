// Liquid glass: the bars, menus and windows bend what lies behind them along their rim, like a
// thick pane of glass. The look itself (tint, blur, highlights) is in styles.css under "liquid
// glass"; this adds the refraction, which CSS can't do alone: an SVG displacement filter shaped
// to each pane, handed to its backdrop-filter through --refract. Only Chromium runs SVG filters
// in backdrop-filter, so elsewhere the panes stay frosted without bending.

// Every pane of glass; the same elements as the glass rules in styles.css.
const PANES =
  '.float, .modal, .tabs, .primary, .secondary, .context-menu:not(.sub-menu), .players-menu, .player-card, .ui-tip, .more-btn'
// The bars a soft light follows the pointer over.
const LIT = '.float'

const SVG = 'http://www.w3.org/2000/svg'
// How far in from the rim the glass bends: this much of the corner's radius, and at most this many
// px, so the middle of a bar stays clear. Large panes have their map drawn at half size.
const BEZEL = 22
const BEZEL_OF_RADIUS = 0.65
// Panes up to this size (px²) also split the light a little along the rim, into red, green and
// blue; on larger ones it would cost more than it shows. Not over a jigsaw's table, which redraws
// all the time, so every pane over it would refilter that often.
const FRINGE_AREA = 120000
// How far each colour bends, red the most.
const FRINGE = [1, 0.9, 0.8]
const ONLY = ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0']
// How many maps no pane uses any more are kept, for when a pane goes back to an earlier size.
const SPARE_MAPS = 24

interface Lens {
  filter: SVGFilterElement
  users: number
  // The map it's drawn with, and whether it has loaded.
  map: string
  ready: Promise<boolean>
}

interface LensMap {
  // An object URL of the map's picture, or null if it couldn't be drawn.
  url: Promise<string | null>
  users: number
}

// A pane's size rounded a little, so panes of nearly the same size, or one being resized, share a
// map, stretched by a pixel or two to fit.
const bucket = (v: number) => (v < 48 ? v : v < 128 ? Math.round(v / 4) * 4 : Math.round(v / 8) * 8)

// The displacement map of a rounded pane: neutral grey in the middle, and towards the rim more
// and more red and green, which push each pixel's sample inwards along the rim's normal. The
// bend follows a quarter circle, so it is gentle at first and steep at the very edge.
// Drawn as a PNG off the main thread, and loaded before it's handed over, so a pane never shows
// the filter without its map.
function lensMap(w: number, h: number, r: number, bezel: number, detail: number): Promise<string | null> {
  const cw = Math.max(1, Math.round(w * detail))
  const ch = Math.max(1, Math.round(h * detail))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  const img = ctx.createImageData(cw, ch)
  const hx = w / 2 - r
  const hy = h / 2 - r
  let i = 0
  for (let y = 0; y < ch; y++) {
    const py = ((y + 0.5) / ch) * h - h / 2
    const qy = Math.abs(py) - hy
    for (let x = 0; x < cw; x++) {
      const px = ((x + 0.5) / cw) * w - w / 2
      const qx = Math.abs(px) - hx
      // How far inside the rim this pixel is, and which way the rim faces there.
      let dist: number
      let nx = 0
      let ny = 0
      if (qx > 0 && qy > 0) {
        const l = Math.hypot(qx, qy)
        dist = r - l
        nx = (qx / l) * Math.sign(px)
        ny = (qy / l) * Math.sign(py)
      } else if (qx > qy) {
        dist = r - qx
        nx = Math.sign(px)
      } else {
        dist = r - qy
        ny = Math.sign(py)
      }
      const t = Math.min(1, Math.max(0, 1 - dist / bezel))
      const bend = 1 - Math.sqrt(1 - t * t)
      img.data[i++] = 128 - nx * bend * 127
      img.data[i++] = 128 - ny * bend * 127
      img.data[i++] = 128
      img.data[i++] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return new Promise((resolve) =>
    canvas.toBlob((blob) => {
      if (!blob) return resolve(null)
      const url = URL.createObjectURL(blob)
      const pic = new Image()
      pic.src = url
      pic.decode().then(
        () => resolve(url),
        () => resolve(url),
      )
    }),
  )
}

// Whether a pane is over a jigsaw's table: in it, or a window over it with no jigsaws page open.
const onBoard = (el: Element) =>
  !!el.closest('.room') || (!el.closest('.gallery') && !document.querySelector('.gallery') && !!document.querySelector('.room'))

export function liquidGlass() {
  document.addEventListener(
    'pointermove',
    (e) => {
      const bar = e.target instanceof Element ? e.target.closest<HTMLElement>(LIT) : null
      if (!bar) return
      const box = bar.getBoundingClientRect()
      bar.style.setProperty('--gx', `${e.clientX - box.left}px`)
      bar.style.setProperty('--gy', `${e.clientY - box.top}px`)
    },
    { passive: true },
  )

  if (!/\bChrom(e|ium)\//.test(navigator.userAgent)) return

  const defs = document.createElementNS(SVG, 'svg')
  defs.setAttribute('width', '0')
  defs.setAttribute('height', '0')
  defs.setAttribute('aria-hidden', 'true')
  defs.style.position = 'absolute'
  document.body.append(defs)

  // One filter for each size and roundness in use, shared by the panes that have it, and one map
  // for each rounded size (see bucket), shared by the filters that use it.
  const lenses = new Map<string, Lens>()
  const maps = new Map<string, LensMap>()
  // Maps no filter uses, oldest first.
  const spare: string[] = []
  // The filter each pane wears, and the one it's waiting for while its map loads.
  const worn = new WeakMap<Element, string>()
  const wanted = new WeakMap<Element, string>()

  const takeMap = (key: string, draw: () => Promise<string | null>) => {
    let map = maps.get(key)
    if (!map) {
      map = { url: draw(), users: 0 }
      maps.set(key, map)
    }
    const k = spare.indexOf(key)
    if (k >= 0) spare.splice(k, 1)
    map.users++
    return map.url
  }
  const dropMap = (key: string) => {
    const map = maps.get(key)
    if (!map || --map.users > 0) return
    spare.push(key)
    while (spare.length > SPARE_MAPS) {
      const old = spare.shift()!
      maps.get(old)?.url.then((url) => url && URL.revokeObjectURL(url))
      maps.delete(old)
    }
  }

  const unwear = (key: string | undefined) => {
    if (!key) return
    const lens = lenses.get(key)
    if (lens && --lens.users <= 0) {
      lens.filter.remove()
      lenses.delete(key)
      dropMap(lens.map)
    }
  }
  const release = (el: Element) => {
    unwear(worn.get(el))
    unwear(wanted.get(el))
    worn.delete(el)
    wanted.delete(el)
  }

  const makeLens = (key: string, w: number, h: number, r: number, bezel: number, fringe: boolean): Lens => {
    const detail = w * h <= FRINGE_AREA ? 1 : 0.5
    const bw = bucket(w)
    const bh = bucket(h)
    const mapKey = `${bw}x${bh}r${Math.round(r)}d${detail}`
    const url = takeMap(mapKey, () => lensMap(bw, bh, r, bezel, detail))
    const filter = document.createElementNS(SVG, 'filter')
    filter.id = `glass-${key}`
    filter.setAttribute('filterUnits', 'userSpaceOnUse')
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse')
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    filter.setAttribute('x', '0')
    filter.setAttribute('y', '0')
    filter.setAttribute('width', `${w}`)
    filter.setAttribute('height', `${h}`)
    const map = document.createElementNS(SVG, 'feImage')
    map.setAttribute('x', '0')
    map.setAttribute('y', '0')
    map.setAttribute('width', `${w}`)
    map.setAttribute('height', `${h}`)
    map.setAttribute('preserveAspectRatio', 'none')
    map.setAttribute('result', 'map')
    filter.append(map)
    const bend = (scale: number, result?: string) => {
      const fe = document.createElementNS(SVG, 'feDisplacementMap')
      fe.setAttribute('in', 'SourceGraphic')
      fe.setAttribute('in2', 'map')
      fe.setAttribute('scale', `${scale}`)
      fe.setAttribute('xChannelSelector', 'R')
      fe.setAttribute('yChannelSelector', 'G')
      if (result) fe.setAttribute('result', result)
      filter.append(fe)
    }
    if (!fringe) bend(bezel * 2)
    else {
      // Each colour bent on its own, a little less than the last, then laid back together.
      FRINGE.forEach((by, c) => {
        bend(bezel * 2 * by, `bent${c}`)
        const only = document.createElementNS(SVG, 'feColorMatrix')
        only.setAttribute('in', `bent${c}`)
        only.setAttribute('type', 'matrix')
        only.setAttribute('values', ONLY[c])
        only.setAttribute('result', `c${c}`)
        filter.append(only)
      })
      for (const [a, b, result] of [
        ['c0', 'c1', 'c01'],
        ['c01', 'c2', ''],
      ]) {
        const mix = document.createElementNS(SVG, 'feBlend')
        mix.setAttribute('mode', 'screen')
        mix.setAttribute('in', a)
        mix.setAttribute('in2', b)
        if (result) mix.setAttribute('result', result)
        filter.append(mix)
      }
    }
    defs.append(filter)
    const ready = url.then((href) => {
      if (!href) return false
      map.setAttribute('href', href)
      return true
    })
    return { filter, users: 0, map: mapKey, ready }
  }

  const fit = (el: HTMLElement) => {
    const w = el.offsetWidth
    const h = el.offsetHeight
    if (!w || !h || !el.isConnected) return
    const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2)
    const bezel = Math.max(4, Math.min(BEZEL, r * BEZEL_OF_RADIUS, w / 2, h / 2))
    const fringe = w * h <= FRINGE_AREA && !onBoard(el)
    const key = `${w}x${h}r${Math.round(r)}${fringe ? 'f' : ''}`
    if ((wanted.get(el) ?? worn.get(el)) === key) return
    unwear(wanted.get(el))
    let lens = lenses.get(key)
    if (!lens) {
      lens = makeLens(key, w, h, r, bezel, fringe)
      lenses.set(key, lens)
    }
    lens.users++
    wanted.set(el, key)
    const id = lens.filter.id
    // The pane keeps the filter it has until the new one's map has loaded.
    lens.ready.then((ok) => {
      if (wanted.get(el) !== key) return
      wanted.delete(el)
      unwear(worn.get(el))
      worn.set(el, key)
      if (ok) el.style.setProperty('--refract', `url(#${id})`)
      else el.style.removeProperty('--refract')
    })
  }

  // Sizes are fitted once a frame, however many times a pane changed size in it.
  const pending = new Set<HTMLElement>()
  let frame = 0
  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) if (entry.target instanceof HTMLElement) pending.add(entry.target)
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        pending.forEach(fit)
        pending.clear()
      })
  })
  const each = (node: Node, run: (el: HTMLElement) => void) => {
    if (!(node instanceof HTMLElement)) return
    if (node.matches(PANES)) run(node)
    node.querySelectorAll<HTMLElement>(PANES).forEach(run)
  }
  const add = (el: HTMLElement) => sizes.observe(el)
  const drop = (el: HTMLElement) => {
    sizes.unobserve(el)
    pending.delete(el)
    release(el)
  }
  new MutationObserver((changes) => {
    for (const change of changes) {
      change.removedNodes.forEach((node) => each(node, drop))
      change.addedNodes.forEach((node) => each(node, add))
    }
  }).observe(document.body, { childList: true, subtree: true })
  each(document.body, add)
}
