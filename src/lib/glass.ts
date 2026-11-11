// Liquid glass: the bars, menus and windows bend what lies behind them along their rim, like a
// thick pane of glass. The look itself (tint, blur, highlights) is in styles.css under "liquid
// glass"; this adds the refraction, which CSS can't do alone: an SVG displacement filter shaped
// to each pane, handed to its backdrop-filter through --refract. Only Chromium runs SVG filters
// in backdrop-filter, so elsewhere the panes stay frosted without bending.

// Every pane of glass; the same elements as the glass rules in styles.css.
const PANES =
  '.float, .modal, .gallery-tabs .tabs, .context-menu:not(.sub-menu), .players-menu, .player-card, .ui-tip, .podium-btn, .share-btn, .more-btn'
// The bars a soft light follows the pointer over.
const LIT = '.float'

const SVG = 'http://www.w3.org/2000/svg'
// How far in from the rim the glass bends (px), at most, and how fine the map is drawn.
const BEZEL = 16
const DETAIL = 0.5

interface Lens {
  filter: SVGFilterElement
  users: number
}

// The displacement map of a rounded pane: neutral grey in the middle, and towards the rim more
// and more red and green, which push each pixel's sample inwards along the rim's normal. The
// bend follows a quarter circle, so it is gentle at first and steep at the very edge.
function lensMap(w: number, h: number, r: number, bezel: number): string {
  const cw = Math.max(1, Math.round(w * DETAIL))
  const ch = Math.max(1, Math.round(h * DETAIL))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
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
  return canvas.toDataURL()
}

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

  // One filter for each size and roundness in use, shared by the panes that have it.
  const lenses = new Map<string, Lens>()
  const worn = new WeakMap<Element, string>()

  const release = (el: Element) => {
    const key = worn.get(el)
    if (!key) return
    worn.delete(el)
    const lens = lenses.get(key)
    if (lens && --lens.users <= 0) {
      lens.filter.remove()
      lenses.delete(key)
    }
  }

  const fit = (el: HTMLElement) => {
    const w = el.offsetWidth
    const h = el.offsetHeight
    if (!w || !h) return
    const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2)
    const bezel = Math.max(4, Math.min(BEZEL, r, w / 2, h / 2))
    const key = `${w}x${h}r${Math.round(r)}`
    if (worn.get(el) === key) return
    release(el)
    let lens = lenses.get(key)
    if (!lens) {
      const href = lensMap(w, h, r, bezel)
      if (!href) return
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
      map.setAttribute('href', href)
      map.setAttribute('x', '0')
      map.setAttribute('y', '0')
      map.setAttribute('width', `${w}`)
      map.setAttribute('height', `${h}`)
      map.setAttribute('preserveAspectRatio', 'none')
      map.setAttribute('result', 'map')
      const bend = document.createElementNS(SVG, 'feDisplacementMap')
      bend.setAttribute('in', 'SourceGraphic')
      bend.setAttribute('in2', 'map')
      bend.setAttribute('scale', `${bezel * 2}`)
      bend.setAttribute('xChannelSelector', 'R')
      bend.setAttribute('yChannelSelector', 'G')
      filter.append(map, bend)
      defs.append(filter)
      lens = { filter, users: 0 }
      lenses.set(key, lens)
    }
    lens.users++
    worn.set(el, key)
    el.style.setProperty('--refract', `url(#${lens.filter.id})`)
  }

  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) if (entry.target instanceof HTMLElement) fit(entry.target)
  })
  const each = (node: Node, run: (el: HTMLElement) => void) => {
    if (!(node instanceof HTMLElement)) return
    if (node.matches(PANES)) run(node)
    node.querySelectorAll<HTMLElement>(PANES).forEach(run)
  }
  const add = (el: HTMLElement) => sizes.observe(el)
  const drop = (el: HTMLElement) => {
    sizes.unobserve(el)
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
