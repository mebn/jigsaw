// Builds a demo database: 20 players, jigsaws done, in progress and fresh, with trays, notes, refs.
// Usage: node seed.ts <manifest.json> <out.db> <passphrases.json>
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { openDb } from '../../server/db.ts'
import { WORDS } from '../../server/words.ts'
import { gridOffset, pack, packExtent, scatter } from '../../src/lib/geometry.ts'

const [manifestFile, outFile, passFile] = process.argv.slice(2)
type Plan = { file: string; base: string; cols: number; rows: number; width: number; height: number; state: 'fresh' | 'done' | 'progress'; progress: number }
const plans: Plan[] = JSON.parse(readFileSync(manifestFile, 'utf8'))

let seedState = 20261116
const rand = () => {
  seedState = (seedState + 0x6d2b79f5) >>> 0
  let t = seedState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const ri = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)]
const shuffle = <T,>(a: T[]) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
const weighted = <T,>(items: T[], w: (t: T) => number) => {
  const total = items.reduce((s, t) => s + w(t), 0)
  let x = rand() * total
  for (const t of items) if ((x -= w(t)) <= 0) return t
  return items[items.length - 1]
}
const hex = (n: number) => Array.from({ length: n }, () => ri(0, 255).toString(16).padStart(2, '0')).join('')

for (const f of [outFile, outFile + '-wal', outFile + '-shm']) rmSync(f, { force: true })
const { db, prepare, tx } = openDb(outFile)

const NOW = Date.now()
const HOUR = 3600e3
const DAY = 24 * HOUR

// ---- players ---------------------------------------------------------------
const NAMES = ['Emily', 'Jake', 'Megan', 'Tyler', 'Sarah', 'Chris', 'Ashley', 'Ryan', 'Hannah', 'Josh', 'Brittany', 'Kevin',
  'puzzlewizard', 'corner_queen', 'edgehunter', 'jigsaw_joe', 'lostpiece', 'TabsAndBlanks', 'night_owl', 'captain_cardboard']
// Participation: core players do most of it, rare ones barely show up.
const LEVELS = [10, 10, 10, 4, 4, 4, 4, 4, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 0.4, 0.4, 0.4, 0.4, 0.4]
const normalize = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter(Boolean).join(' ')
type P = { id: string; name: string; weight: number; passphrase: string }
const players: P[] = shuffle(NAMES.slice()).map((name, k) => ({
  id: hex(8),
  name,
  weight: LEVELS[k],
  passphrase: Array.from({ length: 4 }, () => pick(WORDS)).join(' '),
}))
const insPlayer = prepare('INSERT INTO players (id, name, secret, created) VALUES (?, ?, ?, ?)')
for (const p of players)
  insPlayer.run(p.id, p.name, createHash('sha256').update(normalize(p.passphrase)).digest('hex'), NOW - ri(75, 95) * DAY - ri(0, 23) * HOUR)

// ---- statements ------------------------------------------------------------
const q = {
  room: prepare(`INSERT INTO rooms (id, name, created, cols, rows, shape, seed, width, height, image, image_type, thumb, owner, private, long_pieces, units,
                                    has_thumb, has_preview)
                 VALUES (?, 'Jigsaw', ?, ?, ?, ?, ?, ?, ?, x'', 'image/jpeg', '', ?, 0, 0, 0, 1, 1)`),
  pictures: prepare('INSERT INTO room_pictures (room_id, image, thumb, preview) VALUES (?, ?, ?, ?)'),
  piece: prepare('INSERT INTO pieces (room_id, idx, x, y, r, g, by, tray, tray_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  tray: prepare('INSERT INTO trays (id, room_id, x, y, w, h, name, color, author, created, num, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  note: prepare('INSERT INTO notes (id, room_id, x, y, text, author, created, tray) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'),
  react: prepare('INSERT OR IGNORE INTO note_reactions (room_id, note_id, player_id, kind, created) VALUES (?, ?, ?, ?, ?)'),
  reply: prepare('INSERT INTO note_replies (room_id, id, note_id, author, text, created) VALUES (?, ?, ?, ?, ?, ?)'),
  ref: prepare(`INSERT INTO refs (id, room_id, x, y, w, author, created, opacity, trim_x, trim_y, trim_w, trim_h)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  time: prepare('INSERT INTO times (room_id, user, seconds, seen) VALUES (?, ?, ?, ?)'),
  snap: prepare('INSERT INTO snapshots (room_id, t, size, pieces) VALUES (?, ?, ?, ?)'),
}

// ---- table content ---------------------------------------------------------
const NOTES_PROGRESS = [
  'Edges are done, starting on the middle',
  "Bottom left corner is mine, don't touch it 😄",
  'Sorting the sky pieces into the blue tray',
  'Anyone seen a piece with a bit of red on it?',
  'Taking a break, back after dinner',
  'Save the faces for last, they are the hardest',
  'Who put a tree piece in the edges tray?',
  "I'll finish the left side tonight",
  'Big pile on the right is all dark pieces',
  'Turned all the loose ones upright, you are welcome',
]
const NOTES_DONE = [
  'Finished! Great teamwork everyone 🎉',
  'That last piece was hiding under a tray',
  'Same time next week?',
  'GG, this one was tough',
  'Took us way longer than I thought',
]
const REPLIES = ['Nice!', 'On it', 'Haha sorry, that was me', "I'll help after lunch", '👀', 'Found it, it was turned around', 'Agreed', 'Yes please', 'Not me!', 'Thanks!']
const TRAY_NAMES = ['Sky', 'Faces', 'Red bits', 'Dark', 'Green', 'Blue', 'Light', 'Details']
const TRAY_COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'gray']
const SHAPES = ['classic', 'classic', 'classic', 'dovetail', 'wave', 'mixed', 'jagged']
const WARP: Record<string, number> = { classic: 0.05, wobbly: 0.1, mixed: 0.1, jagged: 0.14 }

const passOut: { name: string; level: string; passphrase: string }[] = []
let summary: string[] = []

db.exec("BEGIN")
plans.forEach((plan) => {
  const { cols, rows, width: W, height: H, state } = plan
  const N = cols * rows
  const id = randomUUID().slice(0, 8)
  const shape = state === 'fresh' ? 'classic' : pick(SHAPES)
  const seed = (rand() * 2 ** 31) | 0
  const room = { cols, rows, width: W, height: H, shape, seed }
  const w = W / cols
  const h = H / rows
  const S = Math.min(w, h)
  const pad = S * (0.4 + (WARP[shape] || 0))
  const e = packExtent({ w, h, pad })
  const radius = Math.hypot(w / 2 + pad + S * 0.12, h / 2 + pad + S * 0.12)
  const trayPad = radius + S * 0.25

  // When: the fresh one is newest so it leads the list.
  const created =
    state === 'fresh' ? NOW - 2 * HOUR : state === 'done' ? NOW - ri(25, 70) * DAY - ri(0, 23) * HOUR : NOW - ri(1, 20) * DAY - ri(0, 23) * HOUR
  const last = state === 'done' ? created + ri(2, 12) * DAY + ri(0, 23) * HOUR : state === 'progress' ? Math.max(created + 3 * HOUR, NOW - ri(1, 72) * HOUR) : created
  const at = (f: number) => Math.round(created + (last - created) * f)

  // Who plays here: core players nearly always, rare ones now and then.
  let crew = players.filter((p) => rand() < Math.min(0.95, 0.15 + p.weight * 0.08))
  if (crew.length < 3) crew = shuffle(players.slice()).slice(0, 3)
  const roomWeight = new Map(crew.map((p) => [p.id, p.weight * (0.4 + rand() * 1.2)]))
  const someone = () => weighted(crew, (p) => roomWeight.get(p.id)!)
  const owner = state === 'fresh' ? players.find((p) => p.weight === 10)! : someone()

  const thumb = 'data:image/jpeg;base64,' + readFileSync(plan.base + '-thumb.jpg').toString('base64')
  q.room.run(id, created, cols, rows, shape, seed, W, H, owner.id)
  q.pictures.run(id, readFileSync(plan.base + '-full.jpg'), thumb, readFileSync(plan.base + '-preview.jpg'))

  // The fresh jigsaw: exactly as the new jigsaw page lays it out, nothing else on the table.
  if (state === 'fresh') {
    for (const p of scatter(room)) q.piece.run(id, p.i, p.x, p.y, p.r, p.g, null, null, 0)
    summary.push(`${plan.file}: ${N} pieces, 0% (fresh)`)
    return
  }

  // Assembly order: the border around from a corner, then inwards from it.
  const border: number[] = []
  for (let c = 0; c < cols; c++) border.push(c)
  for (let r = 1; r < rows; r++) border.push(r * cols + cols - 1)
  for (let c = cols - 2; c >= 0; c--) border.push((rows - 1) * cols + c)
  for (let r = rows - 2; r > 0; r--) border.push(r * cols)
  const startAt = ri(0, border.length - 1)
  const order = [...border.slice(startAt), ...border.slice(0, startAt)]
  const placed = new Uint8Array(N)
  for (const i of order) placed[i] = 1
  const nb = (i: number) => {
    const c = i % cols
    const o: number[] = []
    if (c > 0) o.push(i - 1)
    if (c < cols - 1) o.push(i + 1)
    if (i >= cols) o.push(i - cols)
    if (i < N - cols) o.push(i + cols)
    return o
  }
  const frontier: number[] = []
  const inF = new Uint8Array(N)
  for (const i of order) for (const j of nb(i)) if (!placed[j] && !inF[j]) (inF[j] = 1), frontier.push(j)
  while (frontier.length) {
    const k = Math.floor(rand() * frontier.length)
    const i = frontier[k]
    frontier[k] = frontier[frontier.length - 1]
    frontier.pop()
    placed[i] = 1
    order.push(i)
    for (const j of nb(i)) if (!placed[j] && !inF[j]) (inF[j] = 1), frontier.push(j)
  }

  // Groups: the main one along the order, then a few small ones, to reach the progress wanted.
  const merges = state === 'done' ? N - 1 : Math.round(plan.progress * (N - 1))
  const mainSize = state === 'done' ? N : Math.max(2, Math.round(merges * (0.75 + rand() * 0.15)) + 1)
  const mainCells = order.slice(0, mainSize)
  const group = new Int32Array(N).fill(-1)
  const groups: number[][] = [mainCells]
  for (const i of mainCells) group[i] = 0
  let left = merges - (mainSize - 1)
  let tries = 0
  while (left > 0 && tries++ < 20000) {
    const free = order.filter((i) => group[i] < 0)
    if (!free.length) break
    const want = Math.min(left + 1, ri(3, Math.max(4, Math.round(N / 40))))
    const cells = [pick(free)]
    group[cells[0]] = groups.length
    for (let k = 0; k < cells.length && cells.length < want; k++)
      for (const j of shuffle(nb(cells[k]))) if (group[j] < 0 && cells.length < want) (group[j] = groups.length), cells.push(j)
    if (cells.length < 2) {
      group[cells[0]] = -1
      continue
    }
    groups.push(cells)
    left -= cells.length - 1
  }
  const singles = order.filter((i) => group[i] < 0)

  // Who connected each piece: players take turns along the order, in sessions.
  const by = new Array<string | null>(N).fill(null)
  for (const cells of groups) {
    let who = someone()
    let run = 0
    for (const i of cells) {
      if (run-- <= 0) (who = someone()), (run = ri(5, 40))
      by[i] = who.id
    }
  }

  // Where everything lies. The main group sits where the picture goes, around (0, 0).
  const out = new Array<{ x: number; y: number; r: number; g: number; tray: string | null; ta: number }>(N)
  const home = (i: number): [number, number] => [-W / 2 + ((i % cols) + 0.5) * w, -H / 2 + (Math.floor(i / cols) + 0.5) * h]
  const gMain = Math.min(...mainCells)
  for (const i of mainCells) {
    const [x, y] = home(i)
    out[i] = { x, y, r: 0, g: gMain, tray: null, ta: 0 }
  }

  // Trays below the picture, with some of the loose pieces sorted into them.
  const trays: { id: string; x: number; y: number; w: number; h: number; name: string; color: string; num: number; auto: number; author: string; created: number; cells: number[] }[] = []
  const loose = new Set(singles)
  if (state === 'progress') {
    const edgeLeft = singles.filter((i) => border.includes(i))
    const names = shuffle(TRAY_NAMES.slice())
    const colors = shuffle(TRAY_COLORS.slice())
    const count = N > 700 ? 3 : N > 300 ? 2 : 1
    let tx0 = -W / 2
    for (let k = 0; k < count; k++) {
      const pool = [...loose]
      const isEdges = k === 0 && edgeLeft.length >= 6
      const take = isEdges ? edgeLeft.slice(0, 80) : shuffle(pool).slice(0, Math.min(Math.floor(pool.length / 3), ri(12, 45)))
      if (take.length < 4) break
      for (const i of take) loose.delete(i)
      const gc = Math.ceil(Math.sqrt(take.length * 1.6))
      const sp = 2 * e + S * 0.12
      const ty0 = H / 2 + S * 3
      take.forEach((i, j) => {
        out[i] = { x: tx0 + trayPad + (j % gc) * sp, y: ty0 + trayPad + Math.floor(j / gc) * sp, r: ri(0, 3), g: i, tray: null, ta: 0 }
      })
      const xs = take.map((i) => out[i].x)
      const ys = take.map((i) => out[i].y)
      const tCreated = at(0.1 + rand() * 0.3)
      const t = {
        id: hex(6), x: Math.min(...xs) - trayPad, y: Math.min(...ys) - trayPad,
        w: Math.max(...xs) - Math.min(...xs) + trayPad * 2, h: Math.max(...ys) - Math.min(...ys) + trayPad * 2,
        name: isEdges ? 'Edges' : names.pop()!, color: isEdges ? 'gray' : colors.pop()!, num: k + 1, auto: rand() < 0.4 ? 1 : 0,
        author: someone().id, created: tCreated, cells: take,
      }
      take.forEach((i, j) => {
        out[i].tray = t.id
        out[i].ta = tCreated + 1000 + j * 1500
      })
      trays.push(t)
      tx0 = t.x + t.w + S * 2
    }
  } else if (rand() < 0.6) {
    // A tray left empty once the jigsaw was done.
    trays.push({ id: hex(6), x: -W / 2, y: H / 2 + S * 3, w: S * 6, h: S * 4, name: pick(TRAY_NAMES), color: pick(TRAY_COLORS), num: 1, auto: 0, author: someone().id, created: at(0.2), cells: [] })
  }

  // Loose pieces and small groups, laid out in a grid to the right of the picture.
  const items = shuffle([...[...loose].map((i) => [i]), ...groups.slice(1)]).map((cells) => {
    const k = ri(0, 3)
    const offs = cells.map((i) => gridOffset(cols, w, h, cells[0], i, k))
    const xs = offs.map((o) => o[0])
    const ys = offs.map((o) => o[1])
    const box = { x0: Math.min(...xs) - e, y0: Math.min(...ys) - e, x1: Math.max(...xs) + e, y1: Math.max(...ys) + e }
    return { cells, k, offs, box, mid: [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2] }
  })
  if (items.length) {
    const spots = pack(items.map((t) => t.box), S, false, true)
    let minX = Infinity
    items.forEach((t, k) => (minX = Math.min(minX, spots[k][0] - (t.box.x1 - t.box.x0) / 2)))
    const dx = W / 2 + S * 4 - minX
    items.forEach(({ cells, k, offs, mid }, j) => {
      const g = Math.min(...cells)
      cells.forEach((i, c) => {
        out[i] = { x: spots[j][0] + dx - mid[0] + offs[c][0], y: spots[j][1] - mid[1] + offs[c][1], r: k, g, tray: null, ta: 0 }
      })
    })
  }
  for (let i = 0; i < N; i++) {
    const p = out[i]
    q.piece.run(id, i, p.x, p.y, p.r, p.g, by[i], p.tray, p.ta)
  }
  for (const t of trays) q.tray.run(t.id, id, t.x, t.y, t.w, t.h, t.name, t.color, t.author, t.created, t.num, t.auto)

  // The timelapse: the main group each time it grew.
  const steps = Math.min(mainSize - 1, ri(25, 45))
  let lastSize = 0
  for (let s = 1; s <= steps; s++) {
    const size = Math.max(2, Math.round(mainSize * Math.pow(s / steps, 0.9)))
    if (size <= lastSize) continue
    lastSize = size
    const cells = mainCells.slice(0, size)
    const bits = Buffer.alloc(Math.ceil((Math.max(...cells) + 1) / 8))
    for (const i of cells) bits[i >> 3] |= 1 << (i & 7)
    q.snap.run(id, s === steps ? last : at(0.05 + 0.95 * Math.pow(s / steps, 1.1) * 0.98), size, bits)
  }

  // Reference images to the left of the picture: the whole of it, and sometimes a zoomed part.
  const refW = W * (0.35 + rand() * 0.2)
  let refY = -H / 2 + (refW * H) / W / 2
  if (rand() < 0.85) {
    q.ref.run(hex(6), id, -W / 2 - S * 4 - refW / 2, refY, refW, someone().id, at(0.02), 1, 0, 0, 1, 1)
    refY += (refW * H) / W / 2 + S * 2
  }
  if (rand() < 0.5) {
    const tw = 0.3 + rand() * 0.2
    const th = 0.3 + rand() * 0.2
    const zw = refW * 0.8
    q.ref.run(hex(6), id, -W / 2 - S * 4 - refW / 2, refY + (zw * th * H) / (tw * W) / 2, zw, someone().id, at(0.3), pick([0.6, 0.8, 1]), rand() * (1 - tw), rand() * (1 - th), tw, th)
  }

  // Notes above the picture, with reactions and replies.
  const texts = shuffle((state === 'done' ? NOTES_DONE : NOTES_PROGRESS).slice()).slice(0, state === 'done' ? ri(1, 2) : ri(2, 4))
  let noteX = -W / 2
  texts.forEach((text, k) => {
    const nid = hex(6)
    const nx = noteX
    // Notes grow wider with their text: about 0.17 piece sizes a character.
    noteX += (Math.max(2.2, Math.min(text.length, 60) * 0.17) + 1.5) * S
    const author = someone()
    const t = state === 'done' && k === 0 ? last + ri(1, 30) * 60e3 : at(0.2 + rand() * 0.75)
    q.note.run(nid, id, nx, -H / 2 - S * 4, text, author.id, t)
    for (const p of shuffle(crew.filter((c) => c !== author)).slice(0, ri(0, Math.min(5, crew.length - 1))))
      q.react.run(id, nid, p.id, weighted(['up', 'fire', 'eyes', 'down'], (k) => ({ up: 6, fire: 3, eyes: 2, down: 0.5 })[k]!), t + ri(1, 300) * 60e3)
    let rt = t
    for (let r = ri(0, 3); r > 0; r--) {
      rt += ri(2, 180) * 60e3
      q.reply.run(id, hex(6), nid, someone().id, pick(REPLIES), rt)
    }
  })

  // Time spent: roughly by pieces connected, and some who only looked in.
  const mine = new Map<string, number>()
  for (const b of by) if (b) mine.set(b, (mine.get(b) || 0) + 1)
  for (const p of crew) {
    const cells = mine.get(p.id) || 0
    const seconds = Math.round(cells ? (cells * ri(20, 45) + ri(120, 900)) : ri(60, 1800))
    const seen = state === 'done' ? Math.round(last - rand() ** 2 * (last - created) * 0.8) : Math.round(last - rand() ** 2 * (last - created) * 0.9)
    q.time.run(id, p.id, seconds, Math.max(created + 60e3, seen))
  }
  summary.push(`${plan.file}: ${N} pieces, ${state === 'done' ? 'done' : Math.round((merges / (N - 1)) * 100) + '%'}, ${groups.length} groups, ${trays.length} trays, ${texts.length} notes, ${crew.length} players`)
})

db.exec("COMMIT")
const LEVEL_NAMES: Record<number, string> = { 10: 'core', 4: 'regular', 1.5: 'casual', 0.4: 'rare' }
for (const p of players) passOut.push({ name: p.name, level: LEVEL_NAMES[p.weight], passphrase: p.passphrase })
writeFileSync(passFile, JSON.stringify(passOut, null, 1) + '\n')
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.exec('VACUUM')
db.close()

console.log(summary.join('\n'))
