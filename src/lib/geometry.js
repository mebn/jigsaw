// Jigsaw geometry: grid sizing, edge shapes, piece outlines and initial scatter.

export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The shapes a new jigsaw can have. Older jigsaws may also have round, arrow or square pieces, which
// still work (see profiles).
export const SHAPES = ['classic', 'dovetail', 'wave', 'wobbly', 'mixed', 'jagged']

// Max perpendicular reach of a tab, in units of the piece's short side.
export const TAB_REACH = 0.4

// Shapes whose inner corners are moved off the grid, by up to this much (in units of the short
// side), so every piece has its own size and its edges their own lengths and angles.
const WARP = { classic: 0.05, wobbly: 0.1, mixed: 0.1, jagged: 0.14 }

// How far a piece can reach past the middle of its grid cell's edges, in units of the short side.
export const reachFor = (shape) => TAB_REACH + (WARP[shape] || 0)

export function gridFor(count, width, height) {
  const aspect = width / height
  let cols = Math.max(2, Math.round(Math.sqrt(count * aspect)))
  let rows = Math.max(2, Math.round(count / cols))
  return { cols, rows }
}

// ---- edge profiles --------------------------------------------------------
// Each profile returns [u, v] points with u in [0, 1] along the edge and v the
// perpendicular offset in units of the piece's short side.

// Curves are drawn as this many times the given steps, so outlines stay smooth zoomed far in.
const DETAIL = 3

function cubic(out, p0, p1, p2, p3, steps) {
  steps *= DETAIL
  for (let s = 1; s <= steps; s++) {
    const t = s / steps
    const m = 1 - t
    const a = m * m * m
    const b = 3 * m * m * t
    const c = 3 * m * t * t
    const d = t * t * t
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ])
  }
}

const j = (r, amount) => (r() * 2 - 1) * amount

// A knob on a neck, like the classic tab, shaped by its options: size scales all of it, pos is
// where its middle sits along the edge, lean moves the head to one side, neck, head and tall scale
// the neck's width, the head's width and the height, and a, e and c lift the edge before the knob,
// after it and the knob itself.
function knob({ size = 1, pos = 0.5, lean = 0, neck = 1, head = 1, tall = 1, a = 0, e = 0, c = 0 }) {
  const t = 0.1 * size
  const m = pos
  const n = t * neck
  const hw = 2 * t * head
  const ht = 3 * t * tall
  const p = [
    [0, 0],
    [m * 0.4, a],
    [m, -t + c],
    [m - n, t + c],
    [m - hw + lean, ht + c],
    [m + hw + lean, ht + c],
    [m + n, t + c],
    [m, -t + c],
    [1 - (1 - m) * 0.4, e],
    [1, 0],
  ]
  const out = [p[0]]
  cubic(out, p[0], p[1], p[2], p[3], 10)
  cubic(out, p[3], p[4], p[5], p[6], 14)
  cubic(out, p[6], p[7], p[8], p[9], 10)
  return out
}

// A classic tab with everything about it a little different from edge to edge.
const wobblyKnob = (r) =>
  knob({
    size: 0.85 + r() * 0.3,
    pos: 0.5 + j(r, 0.05),
    lean: j(r, 0.04),
    neck: 0.8 + r() * 0.4,
    head: 0.85 + r() * 0.25,
    tall: 0.85 + r() * 0.3,
    a: j(r, 0.07),
    e: j(r, 0.07),
    c: j(r, 0.03),
  })

// A tab like on a jigsaw from a good maker: the classic smooth S from the edge into the neck and a
// round head, set a little off the middle, leaning a little and a little lopsided, on an edge that
// stays calm around it and bows a little on its own. Sizes are in units of the short side, whatever
// the edge's length (len, also in units of the short side), so a tab on a long edge isn't stretched.
function classic(r, len = 1) {
  const m = len / 2 + j(r, Math.min(0.15, 0.09 + 0.3 * Math.max(0, len - 1)))
  const t = 0.1 * (0.92 + r() * 0.16)
  // Half the neck's width, the head's half widths (left, right) and heights (left, right), and lean.
  const n = t * (0.85 + r() * 0.2)
  const wl = 2 * t * (0.92 + r() * 0.16)
  const wr = wl * (0.9 + r() * 0.2)
  const hl = 3 * t * (0.92 + r() * 0.16)
  const hr = hl * (0.94 + r() * 0.12)
  const lean = j(r, 0.035)
  // The edge lifts a little before the tab and after it, and the tab with it.
  const a = j(r, 0.02)
  const e = j(r, 0.02)
  const c = j(r, 0.01)
  const bow = j(r, 0.012)
  const p = [
    [0, 0],
    [m * 0.4, a],
    [m, -t + c],
    [m - n, t + c],
    [m - wl + lean, hl + c],
    [m + wr + lean, hr + c],
    [m + n, t + c],
    [m, -t + c],
    [len - (len - m) * 0.4, e],
    [len, 0],
  ]
  const out = [p[0]]
  cubic(out, p[0], p[1], p[2], p[3], 12)
  cubic(out, p[3], p[4], p[5], p[6], 18)
  cubic(out, p[6], p[7], p[8], p[9], 12)
  return out.map(([x, v]) => {
    const u = x / len
    return [u, v + bow * Math.sin(Math.PI * u)]
  })
}

const profiles = {
  classic,
  round(r) {
    const cu = 0.5 + j(r, 0.05)
    const c = 0.1
    const R = 0.16
    const du = Math.sqrt(R * R - c * c)
    const t1 = Math.atan2(-c, -du)
    const t2 = Math.atan2(-c, du)
    const span = Math.PI * 2 - (t2 - t1)
    const out = [[0, 0]]
    const steps = 28 * DETAIL
    for (let s = 0; s <= steps; s++) {
      const th = t1 - (span * s) / steps
      out.push([cu + R * Math.cos(th), c + R * Math.sin(th)])
    }
    out.push([1, 0])
    return out
  },
  dovetail(r) {
    const b = j(r, 0.05)
    return [
      [0, 0],
      [0.39 + b, 0],
      [0.31 + b, 0.24],
      [0.69 + b, 0.24],
      [0.61 + b, 0],
      [1, 0],
    ]
  },
  arrow(r) {
    const b = j(r, 0.05)
    return [
      [0, 0],
      [0.42 + b, 0],
      [0.42 + b, 0.08],
      [0.32 + b, 0.08],
      [0.5 + b, 0.28],
      [0.68 + b, 0.08],
      [0.58 + b, 0.08],
      [0.58 + b, 0],
      [1, 0],
    ]
  },
  wave(r) {
    const amp = 0.09 + j(r, 0.02)
    const h2 = j(r, 0.03)
    const out = []
    const steps = 32 * DETAIL
    for (let s = 0; s <= steps; s++) {
      const u = s / steps
      out.push([u, amp * Math.sin(Math.PI * 2 * u) + h2 * Math.sin(Math.PI * 4 * u)])
    }
    return out
  },
  square() {
    return [
      [0, 0],
      [1, 0],
    ]
  },
  wobbly: wobblyKnob,
  // Every edge gets its own kind of tab: a classic one, a ball on a thin neck, a dovetail or two
  // small knobs side by side.
  mixed(r) {
    const k = r()
    if (k < 0.4) return wobblyKnob(r)
    if (k < 0.6)
      return knob({ size: 0.9 + r() * 0.2, pos: 0.5 + j(r, 0.05), lean: j(r, 0.03), neck: 0.55 + r() * 0.15, head: 0.95 + r() * 0.15, a: j(r, 0.05), e: j(r, 0.05) })
    if (k < 0.8) {
      const m = 0.5 + j(r, 0.06)
      const n = 0.07 + r() * 0.04
      const top = n + 0.06 + r() * 0.05
      const d = 0.2 + r() * 0.07
      return [
        [0, 0],
        [0.2, j(r, 0.04)],
        [m - n, 0],
        [m - top, d],
        [m + top, d],
        [m + n, 0],
        [0.8, j(r, 0.04)],
        [1, 0],
      ]
    }
    // Two knobs, each drawn on half the edge.
    const half = (u0) =>
      knob({ size: 0.6 + r() * 0.1, neck: 1.8 + r() * 0.4, head: 1.8 + r() * 0.3, tall: 1.3 + r() * 0.2, a: j(r, 0.03), e: j(r, 0.03) }).map(
        ([u, v]) => [u0 + u * 0.5, v],
      )
    return [...half(0), ...half(0.5).slice(1)]
  },
  // Straight lines and sharp corners: a kinked edge with an angular head on a neck.
  jagged(r) {
    const m = 0.5 + j(r, 0.06)
    const n = 0.07 + r() * 0.04
    const hw = 0.14 + r() * 0.06
    const nh = 0.1 + r() * 0.05
    const ht = 0.24 + r() * 0.06
    const lean = j(r, 0.04)
    return [
      [0, 0],
      [0.2 + j(r, 0.06), j(r, 0.06)],
      [m - n, 0],
      [m - n + lean / 2, nh],
      [m - hw + lean, nh],
      [m - hw * 0.6 + lean, ht],
      [m + hw * 0.6 + lean, ht],
      [m + hw + lean, nh],
      [m + n + lean / 2, nh],
      [m + n, 0],
      [0.8 + j(r, 0.06), j(r, 0.06)],
      [1, 0],
    ]
  },
}

// ---- jigsaw layout ---------------------------------------------------------

// The share of cells that try to start a big piece, see unitsFor.
const LONG_SHARE = 0.22

// Big pieces (longPieces): two to five cells cut as one piece, in any shape the cells make: a line,
// an L, a T, an S, a square and so on. Each grows from a cell into free cells next to it; some grow
// in a straight line. Returns, per cell, the cell its piece starts at (the lowest index in it), or
// null when every cell is a piece of its own. Every cell is still a piece to the engine; the cells
// of a big piece start out joined.
export function unitsFor({ cols, rows, seed, longPieces }) {
  if (!longPieces) return null
  const n = cols * rows
  const unit = Int32Array.from({ length: n }, (_, i) => i)
  const taken = new Uint8Array(n)
  const r = rng(seed ^ 0x6c078965)
  const order = Array.from({ length: n }, (_, k) => k)
  for (let k = n - 1; k > 0; k--) {
    const m = Math.floor(r() * (k + 1))
    ;[order[k], order[m]] = [order[m], order[k]]
  }
  const free = (i, dc, dr) => {
    const c = (i % cols) + dc
    const row = ((i / cols) | 0) + dr
    const q = row * cols + c
    return c >= 0 && c < cols && row >= 0 && row < rows && !taken[q] ? q : -1
  }
  const STEPS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
  for (const i of order) {
    if (taken[i] || r() > LONG_SHARE) continue
    const size = 2 + Math.floor(r() * 4)
    const line = r() < 0.25 ? STEPS[Math.floor(r() * 4)] : null
    const cells = [i]
    taken[i] = 1
    while (cells.length < size) {
      let q = -1
      if (line) q = free(cells[cells.length - 1], ...line)
      else {
        const edge = [...new Set(cells.flatMap((c) => STEPS.map((d) => free(c, ...d))))].filter((x) => x >= 0)
        if (edge.length) q = edge[Math.floor(r() * edge.length)]
      }
      if (q < 0) break
      taken[q] = 1
      cells.push(q)
    }
    if (cells.length < 2) {
      taken[i] = 0
      continue
    }
    const first = Math.min(...cells)
    for (const q of cells) unit[q] = first
  }
  return unit
}

// The cells of every big piece, by the cell it starts at.
export function unitCells(unit) {
  const m = new Map()
  if (!unit) return m
  unit.forEach((u, i) => {
    if (!m.has(u)) m.set(u, [])
    m.get(u).push(i)
  })
  for (const [u, list] of m) if (list.length < 2) m.delete(u)
  return m
}

// Builds outlines for every piece. Coordinates are in image pixels, relative to
// the centre of the piece's grid cell. Outlines run clockwise (y down).
export function buildPuzzle({ cols, rows, width, height, shape, seed, longPieces }) {
  const w = width / cols
  const h = height / rows
  const S = Math.min(w, h)
  const r = rng(seed)
  const profile = profiles[shape] || profiles.classic
  // Cells of one long piece meet along a straight line with nothing drawn on it.
  const unit = unitsFor({ cols, rows, seed, longPieces })
  const inside = (a, b) => unit && unit[a] === unit[b]

  // The corners of the grid. In warped shapes the inner ones move off it, and those on the border
  // move along it, from their own random numbers so the edges below come out as before.
  const warp = (WARP[shape] || 0) * S
  const wr = rng(seed ^ 0x2545f491)
  const C = []
  for (let y = 0; y <= rows; y++) {
    C.push([])
    for (let x = 0; x <= cols; x++) {
      const dx = warp && x > 0 && x < cols ? j(wr, warp) : 0
      const dy = warp && y > 0 && y < rows ? j(wr, warp) : 0
      C[y].push([x * w + dx, y * h + dy])
    }
  }
  // An edge from corner A to corner B along a profile, its tabs pushed out along normal (nx, ny).
  // The profile gets the edge's length in units of the short side; most ignore it.
  const edge = (A, B, nx, ny) => {
    const sign = r() < 0.5 ? -1 : 1
    const ex = B[0] - A[0]
    const ey = B[1] - A[1]
    return profile(r, Math.hypot(ex, ey) / S).map(([u, v]) => [A[0] + u * ex + v * S * sign * nx, A[1] + u * ey + v * S * sign * ny])
  }
  const dir = (A, B) => {
    const l = Math.hypot(B[0] - A[0], B[1] - A[1])
    return [(B[0] - A[0]) / l, (B[1] - A[1]) / l]
  }

  // Horizontal edges between row y-1 and y, vertical edges between col x-1 and x.
  const H = []
  for (let y = 0; y <= rows; y++) {
    H.push([])
    for (let x = 0; x < cols; x++) {
      const A = C[y][x]
      const B = C[y][x + 1]
      if (y === 0 || y === rows || inside((y - 1) * cols + x, y * cols + x)) H[y].push([A, B])
      else {
        const [dx, dy] = dir(A, B)
        H[y].push(edge(A, B, -dy, dx))
      }
    }
  }
  const V = []
  for (let y = 0; y < rows; y++) {
    V.push([])
    for (let x = 0; x <= cols; x++) {
      const A = C[y][x]
      const B = C[y + 1][x]
      if (x === 0 || x === cols || inside(y * cols + x - 1, y * cols + x)) V[y].push([A, B])
      else {
        const [dx, dy] = dir(A, B)
        V[y].push(edge(A, B, dy, -dx))
      }
    }
  }

  const pieces = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cx = x * w + w / 2
      const cy = y * h + h / 2
      const i = y * cols + x
      const pts = []
      // Where each side starts in the outline, by point, and the last point (the first again).
      const sides = []
      const add = (edge, reverse) => {
        sides.push(Math.max(0, pts.length / 2 - 1))
        const e = reverse ? [...edge].reverse() : edge
        for (let k = pts.length ? 1 : 0; k < e.length; k++) pts.push(e[k][0] - cx, e[k][1] - cy)
      }
      add(H[y][x], false)
      add(V[y][x + 1], false)
      add(H[y + 1][x], true)
      add(V[y][x], true)
      sides.push(pts.length / 2 - 1)
      const piece = { i, col: x, row: y, cx, cy, outline: Float32Array.from(pts), sides }
      // In a long piece: which sides (top, right, bottom, left) are inside it, not cut.
      if (unit) {
        const inner = [
          y > 0 && inside(i, i - cols),
          x < cols - 1 && inside(i, i + 1),
          y < rows - 1 && inside(i, i + cols),
          x > 0 && inside(i, i - 1),
        ]
        if (inner.some(Boolean)) piece.inner = inner
      }
      pieces.push(piece)
    }
  }
  return { w, h, S, pad: S * reachFor(shape), pieces, unit }
}

// For each line of piece p's outline, from one point to the next, which side (0 to 3: top, right,
// bottom, left) it's on, plus 4 when that side is cut (not inside a long piece).
export function sideCodes(p) {
  const out = []
  for (let s = 0; s < 4; s++) {
    for (let k = p.sides[s]; k < p.sides[s + 1]; k++) out.push(s | (p.inner?.[s] ? 0 : 4))
  }
  // The line from the last point back to the first, which is the same point.
  out.push(3 | 4)
  return out
}

export function outlinePath(outline) {
  const p = new Path2D()
  p.moveTo(outline[0], outline[1])
  for (let k = 2; k < outline.length; k += 2) p.lineTo(outline[k], outline[k + 1])
  p.closePath()
  return p
}

// For drawing a cell of a long piece so its cells look like one piece: fill is the outline pushed
// out a little over the sides inside the piece (grow), so the cells overlap instead of leaving a
// hairline between them; rim is only the cut sides, for the edge lines; pts is fill's corners as
// x, y pairs, and code[k] the line from corner k to the next's side code (see sideCodes()). Null
// for a cell that's a piece of its own.
export function longPaths(p, grow) {
  if (!p.inner) return null
  const o = p.outline
  const fill = new Path2D()
  const rim = new Path2D()
  // fill's corners, as x, y pairs, and for each line from one to the next which side it's on and
  // whether that's a cut side (see sideCodes()).
  const pts = [o[0], o[1]]
  const code = []
  const to = (x, y, s, c) => {
    fill.lineTo(x, y)
    pts.push(x, y)
    code.push(s | (c ? 4 : 0))
  }
  fill.moveTo(o[0], o[1])
  let pen = false
  for (let s = 0; s < 4; s++) {
    const a = p.sides[s]
    const b = p.sides[s + 1]
    if (p.inner[s]) {
      // A straight side: from point a to point b, pushed outwards.
      const ax = o[a * 2]
      const ay = o[a * 2 + 1]
      const bx = o[b * 2]
      const by = o[b * 2 + 1]
      const l = Math.hypot(bx - ax, by - ay) || 1
      const nx = (by - ay) / l
      const ny = -(bx - ax) / l
      to(ax + nx * grow, ay + ny * grow, s, false)
      to(bx + nx * grow, by + ny * grow, s, false)
      to(bx, by, s, false)
      pen = false
      continue
    }
    if (!pen) rim.moveTo(o[a * 2], o[a * 2 + 1])
    pen = true
    for (let k = a + 1; k <= b; k++) {
      to(o[k * 2], o[k * 2 + 1], s, true)
      rim.lineTo(o[k * 2], o[k * 2 + 1])
    }
  }
  fill.closePath()
  return { fill, rim, pts, code }
}

// Room around a module when laying modules out side by side: enough that tabs don't overlap
// and neighbours stay out of snapping range of each other.
export function packExtent({ w, h, pad }) {
  return Math.max(w, h) / 2 + pad * 0.7
}

// Lays boxes ({ x0, y0, x1, y1 }) out in a square grid centred on 0, in reading order of where
// they lie now (or in random order, with shuffle, or in the order given, with keep). Every column is as wide as its widest box and
// every row as tall as its tallest. Returns the new centre of each box. S is the puzzle's piece
// size (see buildPuzzle).
export function pack(boxes, S, shuffle = false, keep = false) {
  const gap = S * 0.12
  const mid = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]
  const order = boxes
    .map((b, k) => ({ k, x: mid(b)[0], row: Math.round(mid(b)[1] / (S * 1.5)) }))
    .sort((a, b) => (keep ? a.k - b.k : a.row - b.row || a.x - b.x))
    .map((o) => o.k)
  if (shuffle)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
  const cols = Math.ceil(Math.sqrt(boxes.length))
  const rows = Math.ceil(boxes.length / cols)
  const cw = new Array(cols).fill(0)
  const rh = new Array(rows).fill(0)
  order.forEach((k, n) => {
    const b = boxes[k]
    cw[n % cols] = Math.max(cw[n % cols], b.x1 - b.x0)
    rh[(n / cols) | 0] = Math.max(rh[(n / cols) | 0], b.y1 - b.y0)
  })
  const starts = (sizes) => {
    let at = -(sizes.reduce((a, b) => a + b, 0) + gap * (sizes.length - 1)) / 2
    return sizes.map((v) => {
      const s = at
      at += v + gap
      return s
    })
  }
  const xs = starts(cw)
  const ys = starts(rh)
  const out = new Array(boxes.length)
  order.forEach((k, n) => {
    const c = n % cols
    const r = (n / cols) | 0
    out[k] = [xs[c] + cw[c] / 2, ys[r] + rh[r] / 2]
  })
  return out
}

// The pieces of a jigsaw, each a list of cells: one cell, or the cells of a long piece.
function piecesOf(room) {
  const unit = unitsFor(room)
  const n = room.cols * room.rows
  if (!unit) return Array.from({ length: n }, (_, i) => [i])
  const m = new Map()
  for (let i = 0; i < n; i++) {
    if (!m.has(unit[i])) m.set(unit[i], [])
    m.get(unit[i]).push(i)
  }
  return [...m.values()]
}

// Where cell i sits from cell a of the same piece, when the piece is turned k quarter turns.
function offset(room, a, i, k) {
  const { cols } = room
  const x = ((i % cols) - (a % cols)) * (room.width / cols)
  const y = (((i / cols) | 0) - ((a / cols) | 0)) * (room.height / room.rows)
  const c = [1, 0, -1, 0][k]
  const s = [0, 1, 0, -1][k]
  return [x * c - y * s, x * s + y * c]
}

// Lays the pieces out in shuffled order in the same tight grid as sorting a selection (G) does,
// each with a random quarter-turn rotation. A long piece gets a box as long as it is. A new seed
// gives a new layout of the same pieces.
export function scatter(room, seed = room.seed) {
  const geo = { w: room.width / room.cols, h: room.height / room.rows }
  geo.S = Math.min(geo.w, geo.h)
  geo.pad = geo.S * reachFor(room.shape)
  const r = rng(seed ^ 0x9e3779b9)
  const order = piecesOf(room)
  for (let k = order.length - 1; k > 0; k--) {
    const m = Math.floor(r() * (k + 1))
    ;[order[k], order[m]] = [order[m], order[k]]
  }
  // Every piece gets a box around it, in a single row so pack keeps the shuffled order.
  const e = packExtent(geo)
  let at = 0
  const items = order.map((cells) => {
    const k = Math.floor(r() * 4)
    const offs = cells.map((i) => offset(room, cells[0], i, k))
    const xs = offs.map((o) => o[0])
    const ys = offs.map((o) => o[1])
    const x0 = Math.min(...xs) - e
    const x1 = Math.max(...xs) + e
    const box = { x0: at, y0: Math.min(...ys) - e, x1: at + x1 - x0, y1: Math.max(...ys) + e }
    at = box.x1
    return { cells, k, offs, box, mid: [(x0 + x1) / 2, (box.y0 + box.y1) / 2] }
  })
  const spots = pack(items.map((t) => t.box), geo.S)
  const out = new Array(room.cols * room.rows)
  items.forEach(({ cells, k, offs, mid }, n) => {
    const [x, y] = spots[n]
    cells.forEach((i, c) => {
      out[i] = { i, x: x - mid[0] + offs[c][0], y: y - mid[1] + offs[c][1], r: k, g: cells[0] }
    })
  })
  return out
}

// The jigsaw the warped shapes' sample pieces come from, by shape: its middle piece has two tabs and
// two holes.
const SAMPLE_SEED = { classic: 65 }

// SVG path for a single sample piece (used by the shape picker icon).
export function samplePiecePath(shape, size = 100) {
  // Warped shapes show the middle piece of a small jigsaw, crooked corners and all.
  if (WARP[shape]) {
    const geo = buildPuzzle({ cols: 3, rows: 3, width: size * 3, height: size * 3, shape, seed: SAMPLE_SEED[shape] ?? 15 })
    const o = geo.pieces[4].outline
    const pts = []
    for (let k = 0; k < o.length; k += 2) pts.push(`${(o[k] + size / 2).toFixed(2)} ${(o[k + 1] + size / 2).toFixed(2)}`)
    return 'M' + pts.join('L') + 'Z'
  }
  const profile = profiles[shape] || profiles.classic
  const fixed = () => 0.5
  const e = profile(fixed)
  const pts = []
  const push = (x, y) => pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`)
  // top out, right in, bottom out, left in
  for (const [u, v] of e) push(u * size, -v * size)
  for (const [u, v] of e) push(size - v * size, u * size)
  for (const [u, v] of [...e].reverse()) push(u * size, size + v * size)
  for (const [u, v] of [...e].reverse()) push(v * size, u * size)
  return 'M' + pts.join('L') + 'Z'
}
