// What lies on a room's table (pieces, notes and their reactions and replies, reference images and
// trays), how pages change it over the room socket, and the timelapse of the biggest group.
import { LIMITS, isNoteReaction } from '../shared/protocol.ts'
import type { NoteReaction, NoteReply, NoteRow, PieceMove, PieceRow, RefRow, ServerMessage, TrayRow } from '../shared/protocol.ts'
import type { Db } from './db.ts'
import type { Hub, RoomSocket } from './hub.ts'
import type { Players } from './players.ts'

// What a page sent, unchecked.
type Loose = Record<string, unknown>
const loose = (v: unknown): Loose => (v && typeof v === 'object' ? (v as Loose) : {})
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown, max: number) => String(v || '').slice(0, max)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const cleanNote = (b: Loose) => ({
  id: str(b.id, LIMITS.id),
  x: num(b.x),
  y: num(b.y),
  text: str(b.text, LIMITS.text),
  tray: b.tray ? str(b.tray, LIMITS.id) : null,
  author: str(b.author, LIMITS.name),
  created: num(b.created),
})

// The part of an image that shows, as fractions of the picture: the whole of it when not given.
function cleanTrim(b: Loose) {
  const f = (v: unknown, d: number, lo: number, hi: number) => clamp(v == null || !Number.isFinite(Number(v)) ? d : Number(v), lo, hi)
  const max = 1 - LIMITS.minTrim
  const trimX = f(b.trimX, 0, 0, max)
  const trimY = f(b.trimY, 0, 0, max)
  return { trimX, trimY, trimW: f(b.trimW, 1, LIMITS.minTrim, 1 - trimX), trimH: f(b.trimH, 1, LIMITS.minTrim, 1 - trimY) }
}
const cleanRef = (b: Loose) => ({
  id: str(b.id, LIMITS.id),
  x: num(b.x),
  y: num(b.y),
  w: Math.max(1, num(b.w)),
  opacity: clamp(num(b.opacity) || 1, LIMITS.minOpacity, 1),
  ...cleanTrim(b),
  author: str(b.author, LIMITS.name),
  created: num(b.created),
})
// What's in a tray is saved on the pieces, with their moves, so a tray is cleaned without them.
const cleanTray = (b: Loose) => ({
  id: str(b.id, LIMITS.id),
  x: num(b.x),
  y: num(b.y),
  w: Math.max(1, num(b.w)),
  h: Math.max(1, num(b.h)),
  name: str(b.name, LIMITS.trayName),
  color: str(b.color, LIMITS.trayColor),
  num: clamp(Math.trunc(num(b.num)), 0, LIMITS.trayNum),
  auto: !!b.auto,
  author: str(b.author, LIMITS.name),
  created: num(b.created),
})

// The messages that change what's on the table, or show it changing.
const CHANGES = new Set(['moves', 'grab', 'live', 'sway', 'note', 'ref', 'tray', 'note-delete', 'ref-delete', 'tray-delete'])

type StoredTray = Omit<TrayRow, 'auto' | 'pieces'> & { auto: number }

export function createTable({ prepare, tx }: Db, hub: Hub, players: Players) {
  const q = {
    pieces: prepare<PieceRow>('SELECT idx AS i, x, y, r, g, by, tray AS t, tray_at AS ta FROM pieces WHERE room_id = ? ORDER BY idx'),
    updatePiece: prepare<{ by: string | null }>(
      'UPDATE pieces SET x = ?, y = ?, r = ?, g = ?, by = COALESCE(?, by) WHERE room_id = ? AND idx = ? RETURNING by',
    ),
    // The tray a piece is in, and when it was put there: kept when the tray stays the same.
    setPieceTray: prepare<{ tray_at: number }>(
      'UPDATE pieces SET tray = ?1, tray_at = CASE WHEN tray IS ?1 THEN tray_at ELSE ?2 END WHERE room_id = ?3 AND idx = ?4 RETURNING tray_at',
    ),
    trayPieces: prepare<{ idx: number }>('SELECT idx FROM pieces WHERE room_id = ? AND tray = ? ORDER BY tray_at, idx'),
    clearTray: prepare('UPDATE pieces SET tray = NULL WHERE room_id = ? AND tray = ?'),
    clearNoteTray: prepare('UPDATE notes SET tray = NULL WHERE room_id = ? AND tray = ?'),
    notes: prepare<NoteRow>('SELECT id, x, y, text, tray, author, created FROM notes WHERE room_id = ? AND (?2 IS NULL OR id = ?2) ORDER BY created'),
    upsertNote: prepare(`
      INSERT INTO notes (id, room_id, x, y, text, tray, author, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room_id, id) DO UPDATE SET x = excluded.x, y = excluded.y, text = excluded.text, tray = excluded.tray`),
    deleteNote: prepare('DELETE FROM notes WHERE room_id = ? AND id = ?'),
    noteReactions: prepare<NoteReaction>(
      'SELECT note_id AS note, player_id AS player, kind FROM note_reactions WHERE room_id = ? ORDER BY created',
    ),
    react: prepare('INSERT OR IGNORE INTO note_reactions (room_id, note_id, player_id, kind, created) VALUES (?, ?, ?, ?, ?)'),
    unreact: prepare('DELETE FROM note_reactions WHERE room_id = ? AND note_id = ? AND player_id = ? AND kind = ?'),
    noteReplies: prepare<NoteReply>('SELECT id, note_id AS note, author, text, created FROM note_replies WHERE room_id = ? ORDER BY created'),
    reply: prepare('INSERT OR IGNORE INTO note_replies (room_id, id, note_id, author, text, created) VALUES (?, ?, ?, ?, ?, ?)'),
    deleteReply: prepare('DELETE FROM note_replies WHERE room_id = ? AND id = ? AND author = ?'),
    refs: prepare<RefRow>(
      'SELECT id, x, y, w, opacity, trim_x AS trimX, trim_y AS trimY, trim_w AS trimW, trim_h AS trimH, author, created FROM refs WHERE room_id = ? AND (?2 IS NULL OR id = ?2) ORDER BY created',
    ),
    upsertRef: prepare(`
      INSERT INTO refs (id, room_id, x, y, w, opacity, trim_x, trim_y, trim_w, trim_h, author, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room_id, id) DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w, opacity = excluded.opacity,
        trim_x = excluded.trim_x, trim_y = excluded.trim_y, trim_w = excluded.trim_w, trim_h = excluded.trim_h`),
    deleteRef: prepare('DELETE FROM refs WHERE room_id = ? AND id = ?'),
    trays: prepare<StoredTray>(
      'SELECT id, x, y, w, h, name, color, num, auto, author, created FROM trays WHERE room_id = ? AND (?2 IS NULL OR id = ?2) ORDER BY created',
    ),
    upsertTray: prepare(`
      INSERT INTO trays (id, room_id, x, y, w, h, name, color, num, auto, author, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room_id, id) DO UPDATE SET
        x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, name = excluded.name, color = excluded.color,
        num = excluded.num, auto = excluded.auto`),
    deleteTray: prepare('DELETE FROM trays WHERE room_id = ? AND id = ?'),
    // How many pieces a group has, for the timelapse (see snapshot()).
    biggest: prepare<{ g: number }>('SELECT g FROM pieces WHERE room_id = ? GROUP BY g ORDER BY COUNT(*) DESC, g LIMIT 1'),
    groupSize: prepare<{ size: number }>('SELECT COUNT(*) AS size FROM pieces WHERE room_id = ? AND g = ?'),
    groupCells: prepare<{ idx: number }>('SELECT idx FROM pieces WHERE room_id = ? AND g = ?'),
    lastSnapshot: prepare<{ size: number }>('SELECT size FROM snapshots WHERE room_id = ? ORDER BY t DESC, rowid DESC LIMIT 1'),
    insertSnapshot: prepare('INSERT INTO snapshots (room_id, t, size, pieces) VALUES (?, ?, ?, ?)'),
    snapshots: prepare<{ t: number; size: number; pieces: Uint8Array }>('SELECT t, size, pieces FROM snapshots WHERE room_id = ? ORDER BY t, rowid'),
  }

  // A stored tray, with the pieces in it (see migration 019), in the order they went in.
  const trayOut = (row: StoredTray, roomId: string): TrayRow => ({
    ...row,
    auto: !!row.auto,
    pieces: q.trayPieces.all(roomId, row.id).map((p) => p.idx),
  })

  // The size of each room's last snapshot, so most moves don't have to read it back.
  const snapped = new Map<string, number>()

  // Saves which pieces are in the room's biggest group when it has grown since the last snapshot,
  // for the timelapse. Groups only grow, so the frames only ever add pieces, unless another group
  // overtakes the biggest. groups: the groups the pieces just moved are in, the only ones that can
  // have grown, so only they are counted rather than every piece of the jigsaw.
  function snapshot(roomId: string, now: number, groups: Set<number>) {
    if (!snapped.has(roomId)) {
      const last = q.lastSnapshot.get(roomId)?.size ?? 0
      snapped.set(roomId, last)
      // A jigsaw without a snapshot yet (from before there were any) starts from its biggest group,
      // whichever pieces moved: looked up this once.
      const g = last ? undefined : q.biggest.get(roomId)?.g
      if (g !== undefined) groups.add(g)
    }
    const big = { g: 0, size: 0 }
    for (const g of groups) {
      const size = q.groupSize.get(roomId, g)?.size ?? 0
      if (size > big.size || (size === big.size && g < big.g)) Object.assign(big, { g, size })
    }
    if (big.size < 2 || big.size <= snapped.get(roomId)!) return
    const cells = q.groupCells.all(roomId, big.g)
    let last = 0
    for (const { idx } of cells) if (idx > last) last = idx
    const bits = Buffer.alloc(Math.ceil((last + 1) / 8))
    for (const { idx } of cells) bits[idx >> 3] |= 1 << (idx & 7)
    q.insertSnapshot.run(roomId, now, big.size, bits)
    snapped.set(roomId, big.size)
  }

  // Saves pieces where a page put them, and returns them as everyone is told: with when each went
  // into its tray (ta), so a tray sorts in the same order for all. me: the player moving them. A
  // page says who connected each piece (by), but is only taken at its word for its own player:
  // otherwise the piece stays whose it was.
  function saveMoves(roomId: string, list: unknown[], me: string) {
    const now = Date.now()
    const out: PieceMove[] = []
    const groups = new Set<number>()
    tx(() => {
      for (const raw of list) {
        const b = loose(raw)
        const p: PieceMove = { i: num(b.i), x: num(b.x), y: num(b.y), r: num(b.r), g: num(b.g) }
        // A piece the jigsaw doesn't have is no move at all.
        const saved = q.updatePiece.get(p.x, p.y, p.r, p.g, b.by === me ? me : null, roomId, p.i)
        if (!saved) continue
        p.by = saved.by
        // t: the tray it's in (null: none). Left out, as pages from before trays send, it stays as it was.
        if (b.t !== undefined) {
          p.t = typeof b.t === 'string' && b.t ? b.t.slice(0, LIMITS.id) : null
          p.ta = q.setPieceTray.get(p.t, now, roomId, p.i)?.tray_at ?? now
        }
        out.push(p)
        groups.add(p.g)
      }
      if (out.length) snapshot(roomId, now, groups)
    })
    return out
  }

  // Notes, reference images and trays: live only relays (while dragging), otherwise it's saved.
  function putNote(roomId: string, b: Loose, live: boolean, author: string): NoteRow | undefined {
    const n = cleanNote(b)
    if (!n.id) return
    if (live) return n
    q.upsertNote.run(n.id, roomId, n.x, n.y, n.text, n.tray, author, Date.now())
    return q.notes.get(roomId, n.id)
  }
  function putRef(roomId: string, b: Loose, live: boolean, author: string): RefRow | undefined {
    const r = cleanRef(b)
    if (!r.id) return
    if (live) return r
    q.upsertRef.run(r.id, roomId, r.x, r.y, r.w, r.opacity, r.trimX, r.trimY, r.trimW, r.trimH, author, Date.now())
    return q.refs.get(roomId, r.id)
  }
  function putTray(roomId: string, b: Loose, live: boolean, author: string): TrayRow | Omit<TrayRow, 'pieces'> | undefined {
    const t = cleanTray(b)
    if (!t.id) return
    if (live) return t
    q.upsertTray.run(t.id, roomId, t.x, t.y, t.w, t.h, t.name, t.color, t.num, t.auto ? 1 : 0, author, Date.now())
    const row = q.trays.get(roomId, t.id)
    return row && trayOut(row, roomId)
  }

  // A message from a page on the room's socket.
  function handle(roomId: string, ws: RoomSocket, m: Loose) {
    const client = ws.client
    const relay = (msg: ServerMessage) => hub.broadcast(roomId, msg, ws)
    const id = str(m.id, LIMITS.id)
    // What a player makes is theirs, whoever the page says it's by. (A change to something already
    // there keeps its author.)
    const author = ws.player?.id || ''
    if (m.type === 'hello') return hub.setPlayer(roomId, ws, players.whoIs(m.passphrase, ws.ip))
    // Guests only watch: changing what's on the table takes a logged in player, as the pages ask
    // for before anything can be touched.
    if (!ws.player && CHANGES.has(String(m.type))) return
    switch (m.type) {
      case 'moves':
        if (!Array.isArray(m.pieces)) return
        const pieces = saveMoves(roomId, m.pieces.slice(0, LIMITS.pieces), author)
        if (!pieces.length) return
        return relay({
          type: 'moves',
          client,
          pieces,
          turns: Array.isArray(m.turns) ? m.turns.slice(0, 2000) : undefined,
          fix: m.fix ? true : undefined,
        })
      // Drags, pointers and what players have selected are only relayed, as they are.
      case 'grab':
      case 'live':
      case 'sway':
        return relay({ ...m, client } as ServerMessage)
      // Whose they are is the socket's player, whoever the page says.
      case 'marks':
        return relay({ ...m, client, player: author } as ServerMessage)
      case 'cursor':
        if (m.hide) return relay({ type: 'cursor', client, hide: true })
        return relay({ ...m, client, player: author, name: ws.player?.name ?? str(m.name, LIMITS.name) } as ServerMessage)
      // A stroke in draw mode, growing or finished. Not stored: it fades away on every screen.
      case 'ink': {
        const pts = Array.isArray(m.pts) ? m.pts.slice(0, LIMITS.inkPoints).filter((v): v is number => typeof v === 'number' && isFinite(v)) : []
        return relay({ type: 'ink', client, id: str(m.id, LIMITS.inkId), pts, end: m.end ? true : undefined })
      }
      case 'react': {
        const x = Number(m.x)
        const y = Number(m.y)
        if (isFinite(x) && isFinite(y)) relay({ type: 'react', client, x, y })
        return
      }
      case 'note': {
        const note = putNote(roomId, loose(m.note), !!m.live, author)
        if (note) relay({ type: 'note', client, live: !!m.live, note })
        return
      }
      case 'ref': {
        const ref = putRef(roomId, loose(m.ref), !!m.live, author)
        if (ref) relay({ type: 'ref', client, live: !!m.live, ref })
        return
      }
      case 'tray': {
        const tray = putTray(roomId, loose(m.tray), !!m.live, author)
        if (tray) relay({ type: 'tray', client, live: !!m.live, tray })
        return
      }
      case 'note-delete':
        q.deleteNote.run(roomId, id)
        return relay({ type: 'note-delete', client, id })
      case 'ref-delete':
        q.deleteRef.run(roomId, id)
        return relay({ type: 'ref-delete', client, id })
      // The pieces and notes in a tray that goes stay where they are, in no tray.
      case 'tray-delete':
        tx(() => {
          q.deleteTray.run(roomId, id)
          q.clearTray.run(roomId, id)
          q.clearNoteTray.run(roomId, id)
        })
        return relay({ type: 'tray-delete', client, id })
      // Reactions and replies are the logged in player's own.
      case 'note-react': {
        if (!ws.player || !isNoteReaction(m.kind)) return
        const note = str(m.id, LIMITS.id)
        if (m.on) q.react.run(roomId, note, ws.player.id, m.kind, Date.now())
        else q.unreact.run(roomId, note, ws.player.id, m.kind)
        return relay({ type: 'note-react', client, id: note, kind: m.kind, player: ws.player.id, on: !!m.on })
      }
      case 'note-reply': {
        if (!ws.player) return
        const reply = {
          id: str(m.id, LIMITS.id),
          note: str(m.note, LIMITS.id),
          author: ws.player.id,
          text: String(m.text || '').trim().slice(0, LIMITS.text),
          created: Date.now(),
        }
        if (!reply.id || !reply.note || !reply.text) return
        if (q.reply.run(roomId, reply.id, reply.note, reply.author, reply.text, reply.created).changes) relay({ type: 'note-reply', client, reply })
        return
      }
      // Players can only take back their own replies.
      case 'note-reply-delete': {
        if (!ws.player) return
        const reply = String(m.id || '')
        if (q.deleteReply.run(roomId, reply, ws.player.id).changes) relay({ type: 'note-reply-delete', client, id: reply })
        return
      }
    }
  }

  return {
    handle,
    // Everything on a room's table, as a page loads it.
    read: (roomId: string) => ({
      pieces: q.pieces.all(roomId),
      notes: q.notes.all(roomId, null),
      noteReactions: q.noteReactions.all(roomId),
      noteReplies: q.noteReplies.all(roomId),
      refs: q.refs.all(roomId, null),
      trays: q.trays.all(roomId, null).map((t) => trayOut(t, roomId)),
    }),
    // The timelapse: the biggest group each time it grew, its cells a base64 bitset.
    snapshots: (roomId: string) => q.snapshots.all(roomId).map((s) => ({ t: s.t, size: s.size, pieces: Buffer.from(s.pieces).toString('base64') })),
    forget: (roomId: string) => snapped.delete(roomId),
  }
}
