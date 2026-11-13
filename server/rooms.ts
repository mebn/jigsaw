// Jigsaws: the list, making and deleting them, their pictures, who has the private ones, invites and
// the time players spend on them.
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { LIMITS, PREVIEW_H, PREVIEW_W } from '../shared/protocol.ts'
import type { NewRoom, PlayerRef, RoomDetails } from '../shared/protocol.ts'
import type { Db } from './db.ts'
import { fail, ipOf, ok, printable, rateLimit, readJson, siteOrigin } from './http.ts'
import type { Reply } from './http.ts'
import type { Hub } from './hub.ts'
import type { SharedRoom } from './meta.ts'
import type { createMailer } from './mail.ts'
import type { Players } from './players.ts'
import type { createTable } from './table.ts'

type Room = Omit<RoomDetails, 'pieces' | 'notes' | 'noteReactions' | 'noteReplies' | 'refs' | 'trays' | 'times' | 'seen' | 'online' | 'players'>
type Table = ReturnType<typeof createTable>

// The longest side of a jigsaw's thumbnail, in pixels (see encode() in NewRoom.tsx).
const THUMB_SIDE = 480

// Share of a jigsaw's pieces connected (0 to 1), from how many pieces (n) and groups it has.
// A link preview picture as sent by the page (see src/lib/preview.ts): a JPEG data URL, at most
// PREVIEW_MAX bytes. Returns its bytes, or null for anything else.
const PREVIEW_MAX = 1024 * 1024
function previewBytes(data: unknown): Buffer | null {
  const m = typeof data === 'string' ? /^data:image\/jpeg;base64,(.*)$/s.exec(data) : null
  const bytes = m ? Buffer.from(m[1], 'base64') : null
  return bytes && bytes.length <= PREVIEW_MAX && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null
}

// The kinds of picture a jigsaw and its thumbnail may be. Anything else (a page, an SVG with script)
// is turned away when uploaded, and one stored before this check is served as plain bytes.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
const imageType = (type: string) => (IMAGE_TYPES.has(type.trim().toLowerCase()) ? type.trim().toLowerCase() : 'application/octet-stream')
// A picture sent as a data URL: its type and bytes, or null when it isn't a picture.
function pictureOf(data: unknown): { type: string; bytes: Buffer } | null {
  const m = typeof data === 'string' ? /^data:([^;,]+);base64,(.*)$/s.exec(data) : null
  const type = m ? m[1].trim().toLowerCase() : ''
  return m && IMAGE_TYPES.has(type) ? { type, bytes: Buffer.from(m[2], 'base64') } : null
}

const progress = (n: number, groups: number) => ({ progress: n > 1 ? (n - groups) / (n - 1) : 0, done: n > 0 && groups === 1 })

// How many groups there are, and the time everyone spent, in room r.
const GROUPS = '(SELECT COUNT(DISTINCT p.g) FROM pieces p WHERE p.room_id = r.id)'
const SECONDS = '(SELECT COALESCE(SUM(t.seconds), 0) FROM times t WHERE t.room_id = r.id)'
// A room's pieces: long pieces are stored per cell, so units counts them when there are any.
const PIECES = '(CASE WHEN r.units > 0 THEN r.units ELSE (SELECT COUNT(*) FROM pieces p WHERE p.room_id = r.id) END)'

export function createRooms({ prepare, tx, deleteRoom }: Db, hub: Hub, players: Players, table: Table, mailer: ReturnType<typeof createMailer>) {
  const q = {
    list: prepare<{ n: number; groups: number } & Record<string, unknown>>(`
      SELECT r.id, r.name, r.created, r.cols, r.rows, r.shape, r.seed, r.width, r.height, r.long_pieces AS longPieces,
             r.thumb, r.owner, r.private, ${PIECES} AS n, ${GROUPS} AS groups, ${SECONDS} AS seconds,
             -- When a finished jigsaw was finished: its last snapshot (the biggest group last grew,
             -- to the whole picture), or for one finished before snapshots, when someone was last in it.
             COALESCE((SELECT MAX(s.t) FROM snapshots s WHERE s.room_id = r.id),
                      (SELECT MAX(t.seen) FROM times t WHERE t.room_id = r.id), 0) AS finished
      FROM rooms r
      WHERE r.private = 0 OR r.id IN (SELECT room_id FROM room_players WHERE player_id = ?)
      ORDER BY r.created DESC`),
    room: prepare<Room>(
      `SELECT id, name, created, cols, rows, shape, seed, width, height, long_pieces AS longPieces, owner, private,
              preview IS NOT NULL AS preview FROM rooms WHERE id = ?`,
    ),
    image: prepare<{ image: Uint8Array; image_type: string }>('SELECT image, image_type FROM rooms WHERE id = ?'),
    // What a jigsaw's link preview shows, see sharing().
    share: prepare<{ id: string; name: string; width: number; height: number; private: number; preview: number; thumb: number; n: number; groups: number }>(
      `SELECT r.id, r.name, r.width, r.height, r.private, r.preview IS NOT NULL AS preview, length(r.thumb) > 0 AS thumb,
              ${PIECES} AS n, ${GROUPS} AS groups FROM rooms r WHERE r.id = ?`,
    ),
    preview: prepare<{ preview: Uint8Array }>('SELECT preview FROM rooms WHERE id = ? AND preview IS NOT NULL'),
    // Only ever set once, so a preview can be cached for good and nobody can swap one that's there.
    setPreview: prepare('UPDATE rooms SET preview = ? WHERE id = ? AND preview IS NULL'),
    // Stored as text or as bytes, depending on how the jigsaw was saved.
    thumb: prepare<{ thumb: string | Uint8Array }>('SELECT thumb FROM rooms WHERE id = ?'),
    insertRoom: prepare(`
      INSERT INTO rooms (id, name, created, cols, rows, shape, seed, width, height, image, image_type, thumb, owner, private, long_pieces, units, preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertPiece: prepare('INSERT INTO pieces (room_id, idx, x, y, r, g) VALUES (?, ?, ?, ?, ?, ?)'),
    join: prepare('INSERT OR IGNORE INTO room_players (room_id, player_id, joined) VALUES (?, ?, ?)'),
    member: prepare('SELECT 1 FROM room_players WHERE room_id = ? AND player_id = ?'),
    // Players who can be invited by email (never the address itself), and whether they already have the room.
    invitable: prepare<PlayerRef & { joined: number }>(`
      SELECT p.id, p.name, EXISTS (SELECT 1 FROM room_players m WHERE m.room_id = ?1 AND m.player_id = p.id) AS joined
      FROM players p WHERE p.email IS NOT NULL AND p.id != ?2 ORDER BY p.name COLLATE NOCASE`),
    emailOf: prepare<{ id: string; email: string }>('SELECT id, email FROM players WHERE id = ? AND email IS NOT NULL'),
    times: prepare<{ user: string; seconds: number }>('SELECT user, seconds FROM times WHERE room_id = ?'),
    addTime: prepare<{ seconds: number }>(`
      INSERT INTO times (room_id, user, seconds, seen) VALUES (?, ?, ?, ?)
      ON CONFLICT (room_id, user) DO UPDATE SET seconds = seconds + excluded.seconds, seen = excluded.seen
      RETURNING seconds`),
    // When each player was last in a room, for "last played".
    seen: prepare<{ user: string; seen: number }>('SELECT user, seen FROM times WHERE room_id = ? AND seen > 0'),
    // Everyone who has left a mark on a room, so their names can be shown.
    roomPlayers: prepare<PlayerRef>(`
      SELECT id, name FROM players WHERE id IN (
        SELECT "by" FROM pieces WHERE room_id = ?1
        UNION SELECT player_id FROM scores WHERE room_id = ?1
        UNION SELECT author FROM notes WHERE room_id = ?1
        UNION SELECT author FROM refs WHERE room_id = ?1
        UNION SELECT author FROM trays WHERE room_id = ?1
        UNION SELECT author FROM note_replies WHERE room_id = ?1
        UNION SELECT player_id FROM note_reactions WHERE room_id = ?1
        UNION SELECT user FROM times WHERE room_id = ?1
      )`),
    profile: prepare<PlayerRef & { created: number }>('SELECT id, name, created FROM players WHERE id = ?'),
    // The jigsaws a player made, made connections in or spent time in, with their share of each.
    // Private ones only when the asking player (?2) has the link too.
    playerRooms: prepare<{ n: number; groups: number; theirs: number } & Record<string, unknown>>(`
      SELECT r.id, r.name, r.created, r.thumb, r.owner, r.private, ${PIECES} AS n, ${GROUPS} AS groups, ${SECONDS} AS seconds,
             COALESCE(m.n, 0) AS connections, COALESCE(t.seconds, 0) AS theirs, COALESCE(t.seen, 0) AS seen
      FROM rooms r
      LEFT JOIN scores m ON m.room_id = r.id AND m.player_id = ?1
      LEFT JOIN times t ON t.room_id = r.id AND t.user = ?1
      WHERE (r.owner = ?1 OR m.n > 0 OR t.seconds > 0)
        AND (r.private = 0 OR r.id IN (SELECT room_id FROM room_players WHERE player_id = ?2))
      ORDER BY t.seen DESC, r.created DESC`),
  }

  // New jigsaws per address.
  const uploads = rateLimit(30, 60 * 60 * 1000)

  // Emails a private jigsaw's link to players with an email, and adds it to their list. Players who
  // already have it are skipped, so nobody gets the same invite twice. Returns how many were invited.
  function invite(room: Room, from: PlayerRef, ids: unknown, origin: string | null) {
    // Without an address to trust for the link (see siteOrigin()), the email points to their list.
    const where = origin ? `Open it here: ${origin}/r/${room.id}` : 'Log in and you will find it in your list of jigsaws.'
    let n = 0
    for (const id of new Set((Array.isArray(ids) ? ids : []).slice(0, 50).map(String))) {
      const p = q.emailOf.get(id)
      if (!p || p.id === from.id || q.member.get(room.id, p.id)) continue
      q.join.run(room.id, p.id, Date.now())
      mailer.send({
        to: p.email,
        subject: `${from.name} invited you to a jigsaw`,
        text: `${from.name} invited you to play a private jigsaw.\n\n${where}\n\nOnly people with its link can see and play it.`,
      })
      n++
    }
    return n
  }

  // GET /api/players/invitable[?room=]: players who can get an email invite, for a logged in player.
  function invitable(req: IncomingMessage, roomId: string): Reply {
    const who = players.asking(req)
    if (!who) return fail(403, 'log in to invite players')
    return ok(q.invitable.all(roomId, who.id).map((p) => ({ ...p, joined: !!p.joined })))
  }

  // GET /api/players/:id: a player's name and the jigsaws they have played. Private jigsaws only show
  // to players who have them too.
  function profile(req: IncomingMessage, id: string): Reply {
    const p = q.profile.get(id)
    if (!p) return fail(404, 'not found')
    const rooms = q.playerRooms.all(p.id, players.asking(req)?.id || '').map(({ theirs, ...r }) => ({
      ...r,
      ...progress(r.n, r.groups),
      time: theirs,
    }))
    return ok({ ...p, rooms })
  }

  // GET and POST /api/rooms
  async function rooms(req: IncomingMessage): Promise<Reply> {
    // Private jigsaws are listed only for players who have opened them.
    if (req.method === 'GET') return ok(q.list.all(players.asking(req)?.id || '').map((r) => ({ ...r, ...progress(r.n, r.groups) })))
    if (req.method !== 'POST') return
    // A new jigsaw is a big upload, read before its maker can be checked: each address gets so many.
    const ip = ipOf(req)
    if (uploads.blocked(ip)) return fail(429, 'too many new jigsaws from here, try again later')
    uploads.count(ip)
    const b = await readJson<NewRoom>(req, 40 * 1024 * 1024)
    const picture = pictureOf(b.image)
    // The thumbnail is kept as the data URL it came as; one that isn't a picture is left out.
    const thumb = pictureOf(b.thumb) ? String(b.thumb) : ''
    if (!picture || !Array.isArray(b.pieces) || !b.pieces.length || b.pieces.length > LIMITS.pieces) return fail(400, 'bad request')
    // The creator proves who they are with their passphrase, and becomes the owner.
    const owner = players.whoIs(b.passphrase, ip)
    if (!owner) return fail(403, 'log in to create a jigsaw')
    // A private jigsaw's link is all it takes to join, so it gets an id too long to guess.
    const hidden = !!b.private
    const id = hidden ? randomBytes(12).toString('base64url') : randomUUID().slice(0, 8)
    const pieces = b.pieces
    tx(() => {
      q.insertRoom.run(
        id,
        printable(String(b.name || '')).trim().slice(0, LIMITS.roomName) || 'Jigsaw',
        Date.now(),
        Number(b.cols) | 0,
        Number(b.rows) | 0,
        String(b.shape),
        Number(b.seed) | 0,
        Number(b.width),
        Number(b.height),
        picture.bytes,
        picture.type,
        thumb,
        owner.id,
        hidden ? 1 : 0,
        b.longPieces ? 1 : 0,
        // The cells of a long piece start out in one group, so there are as many pieces as groups.
        b.longPieces ? new Set(pieces.map((p) => p.g)).size : 0,
        previewBytes(b.preview),
      )
      if (hidden) q.join.run(id, owner.id, Date.now())
      for (const p of pieces) q.insertPiece.run(id, p.i, p.x, p.y, p.r, p.g)
    })
    if (hidden) invite(q.room.get(id)!, owner, b.invite, siteOrigin(req, mailer.sent))
    return ok({ id })
  }

  // /api/rooms/:id[/image|thumb|preview|snapshots|join|invite|time]
  async function room(req: IncomingMessage, id: string, action: string | undefined): Promise<Reply> {
    const room = q.room.get(id)
    if (!room) return fail(404, 'not found')
    const route = `${req.method} ${action ?? ''}`
    if (route === 'GET ') {
      const known = new Map(q.roomPlayers.all(id).map((p) => [p.id, p]))
      for (const p of hub.players(id)) known.set(p.id, p)
      const details: RoomDetails = {
        ...room,
        ...table.read(id),
        times: q.times.all(id),
        seen: Object.fromEntries(q.seen.all(id).map((s) => [s.user, s.seen])),
        online: hub.online(id),
        players: [...known.values()],
      }
      return ok(details)
    }
    if (route === 'GET image') {
      const img = q.image.get(id)!
      return { file: Buffer.from(img.image), type: imageType(img.image_type) }
    }
    // The thumbnail, stored as a data URL, as a file; see sharing().
    if (route === 'GET thumb') {
      const { thumb } = q.thumb.get(id)!
      const m = /^data:([^;]+);base64,(.*)$/s.exec(typeof thumb === 'string' ? thumb : Buffer.from(thumb).toString('latin1'))
      return m ? { file: Buffer.from(m[2], 'base64'), type: imageType(m[1]) } : fail(404, 'not found')
    }
    if (route === 'GET preview') {
      const p = q.preview.get(id)
      return p ? { file: Buffer.from(p.preview), type: 'image/jpeg' } : fail(404, 'not found')
    }
    if (route === 'GET snapshots') return ok(table.snapshots(id))
    // A jigsaw made before link previews gets one from the first page to open it (see Room.tsx).
    // Read here, before the other posts, as it's bigger than they may be.
    // Only its maker may give it one (anyone logged in, for a jigsaw from before they had makers), so
    // nobody can put their own picture on someone else's link. Private jigsaws show no preview.
    if (route === 'POST preview') {
      const p = await readJson<{ image: string; passphrase: string }>(req, 2 * PREVIEW_MAX)
      const who = players.whoIs(p.passphrase, ipOf(req))
      if (!who || room.private || (room.owner && who.id !== room.owner)) return fail(403, 'only the player who made this jigsaw can set its preview')
      const bytes = previewBytes(p.image)
      if (!bytes) return fail(400, 'bad request')
      q.setPreview.run(bytes, id)
      return ok({ ok: true })
    }
    const b = await readJson<{ passphrase: string; players: string[]; seconds: number; client: string }>(req)
    const who = players.whoIs(b.passphrase, ipOf(req))
    // Only the player who created the jigsaw may delete it; old jigsaws have no owner.
    if (route === 'DELETE ') {
      if (!room.owner || who?.id !== room.owner) return fail(403, 'only the player who made this jigsaw can delete it')
      deleteRoom(id)
      table.forget(id)
      hub.end(id)
      return ok({ ok: true })
    }
    // A player opened a private jigsaw's link: from now on it shows in their list.
    if (route === 'POST join') {
      if (room.private && who) q.join.run(id, who.id, Date.now())
      return ok({ ok: true })
    }
    // Anyone logged in with a private jigsaw's link may invite others to it.
    if (route === 'POST invite') {
      if (!who) return fail(403, 'log in to invite players')
      if (!room.private) return fail(400, 'only private jigsaws take invites')
      return ok({ invited: invite(room, who, b.players, siteOrigin(req, mailer.sent)) })
    }
    if (route === 'POST time') {
      const secs = Math.max(0, Math.min(300, Math.round(Number(b.seconds) || 0)))
      if (!who || !secs) return ok({ ok: true })
      const { seconds } = q.addTime.get(id, who.id, secs, Date.now())!
      hub.broadcast(id, { type: 'time', client: b.client ? String(b.client) : undefined, user: who.id, seconds })
      return ok({ seconds })
    }
  }

  // What a link to jigsaw id shows when shared, or null to show the site's own preview: for a jigsaw
  // that's gone, or a private one, whose picture only those with the link should see.
  function sharing(id: string): SharedRoom | null {
    const r = q.share.get(id)
    if (!r || r.private) return null
    // Its preview picture (see src/lib/preview.ts). Until it has one, the thumbnail, made at most
    // THUMB_SIDE on its longest side (see NewRoom.tsx), as the full picture can be several MB, more
    // than some apps take for a preview; failing that, the picture.
    const k = r.thumb ? Math.min(1, THUMB_SIDE / Math.max(r.width, r.height)) : 1
    const image = r.preview
      ? { path: `/api/rooms/${r.id}/preview`, width: PREVIEW_W, height: PREVIEW_H }
      : { path: `/api/rooms/${r.id}/${r.thumb ? 'thumb' : 'image'}`, width: Math.round(r.width * k), height: Math.round(r.height * k) }
    return { id: r.id, name: r.name, image, pieces: r.n, ...progress(r.n, r.groups) }
  }

  return {
    exists: (id: string) => !!q.room.get(id),
    sharing,
    invitable,
    profile,
    rooms,
    room,
  }
}
