// Jigsaws: the list, making and deleting them, their pictures, who has the private ones, invites and
// the time players spend on them.
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { LIMITS, PREVIEW_H, PREVIEW_W } from '../shared/protocol.ts'
import type { HomeRooms, NewRoom, PlayerRef, PlayerStats, RoomDetails, RoomListKind, RoomPage, RoomSort, RoomSummary } from '../shared/protocol.ts'
import type { Db, Stmt } from './db.ts'
import { fail, ipOf, isJson, ok, printable, rateLimit, readBody, readForm, readJson } from './http.ts'
import type { Reply } from './http.ts'
import type { Hub } from './hub.ts'
import type { SharedRoom } from './meta.ts'
import type { Players } from './players.ts'
import type { createTable } from './table.ts'

type Room = Omit<RoomDetails, 'pieces' | 'notes' | 'noteReactions' | 'noteReplies' | 'refs' | 'trays' | 'times' | 'seen' | 'online' | 'players'>
type Table = ReturnType<typeof createTable>
// A row of a list of jigsaws, before its progress and who's in it are added.
type SummaryRow = Omit<RoomSummary, 'progress' | 'done' | 'online'>

// The longest side of a jigsaw's thumbnail, in pixels (see encode() in NewRoom.tsx).
const THUMB_SIDE = 480

// A picture as uploaded: its type and bytes.
type Picture = { type: string; bytes: Buffer }

// A picture sent as a data URL, as pages did before pictures went as files.
function fromDataUrl(data: unknown): Picture | null {
  const m = typeof data === 'string' ? /^data:([^;,]+);base64,(.*)$/s.exec(data) : null
  return m ? { type: m[1].trim().toLowerCase(), bytes: Buffer.from(m[2], 'base64') } : null
}
// A picture sent as a file in a form (see api.create in the page), or null when that part isn't a file.
async function fromPart(part: ReturnType<FormData['get']>): Promise<Picture | null> {
  return part instanceof Blob ? { type: part.type.trim().toLowerCase(), bytes: Buffer.from(await part.arrayBuffer()) } : null
}

// A link preview picture as sent by the page (see src/lib/preview.ts): a JPEG of at most
// PREVIEW_MAX bytes. Returns its bytes, or null for anything else.
const PREVIEW_MAX = 1024 * 1024
function previewBytes(p: Picture | null): Buffer | null {
  const bytes = p?.type === 'image/jpeg' ? p.bytes : null
  return bytes && bytes.length <= PREVIEW_MAX && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null
}

// The kinds of picture a jigsaw and its thumbnail may be. Anything else (a page, an SVG with script)
// is turned away when uploaded, and one stored before this check is served as plain bytes.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
const imageType = (type: string) => (IMAGE_TYPES.has(type.trim().toLowerCase()) ? type.trim().toLowerCase() : 'application/octet-stream')
// p, when it's one of those kinds of picture.
const pictureOf = (p: Picture | null) => (p && IMAGE_TYPES.has(p.type) ? p : null)

// The biggest upload of a new jigsaw: its picture, thumbnail, preview and where its pieces lie.
const NEW_ROOM_MAX = 40 * 1024 * 1024

// A bytes column as a Buffer, without copying it.
const asBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength)

// Share of a jigsaw's pieces connected (0 to 1), from how many pieces (n) and groups it has.
const progress = (n: number, groups: number) => ({ progress: n > 1 ? (n - groups) / (n - 1) : 0, done: n > 0 && groups === 1 })

// Where room r's thumbnail is (see GET thumb), or '' when it has none. A link, not the picture, so
// the list stays small and browsers keep each thumbnail.
const THUMB = "(CASE WHEN r.has_thumb THEN '/api/rooms/' || r.id || '/thumb' ELSE '' END) AS thumb"
// What a list shows of room r. Its pieces, groups, time and when it was finished are kept on the room
// (see migration 033), so a list doesn't count them up.
const SUMMARY = `r.id, r.name, r.created, r.cols, r.rows, r.shape, r.seed, r.width, r.height, r.long_pieces AS longPieces,
  ${THUMB}, r.owner, r.private, r.piece_count AS n, r.group_count AS groups, r.seconds, r.finished_at AS finished`
// Room r is the asking player's (one ? for each of the three): they made it, made a connection in it,
// or opened its private link.
const MINE = `(r.owner = ? OR r.id IN (SELECT room_id FROM scores WHERE player_id = ? AND n > 0)
  OR (r.private = 1 AND r.id IN (SELECT room_id FROM room_players WHERE player_id = ?)))`
// The ways each list can be sorted, the first its default: the order, and a table joined for it
// on the asking player (one ?) when it needs one.
type Order = { order: string; join?: string }
const NEARLY: Order = { order: '(r.piece_count - r.group_count) * 1.0 / MAX(r.piece_count - 1, 1) DESC, r.played_at DESC' }
const NEWEST: Order = { order: 'r.created DESC' }
const PIECES: Order = { order: 'r.piece_count DESC, r.created DESC' }
const ORDERS: Record<RoomListKind, Partial<Record<RoomSort, Order>>> = {
  // Their own jigsaws in progress: last played by them first.
  mine: {
    recent: { order: 'COALESCE(t.seen, 0) DESC, r.created DESC', join: 'LEFT JOIN times t ON t.room_id = r.id AND t.user = ?' },
    newest: NEWEST,
    nearly: NEARLY,
    pieces: PIECES,
  },
  finished: {
    finished: { order: 'r.finished_at DESC, r.created DESC' },
    // Their share of the jigsaw's connections.
    share: {
      order: 'COALESCE(m.n, 0) * 1.0 / MAX(r.piece_count - 1, 1) DESC, r.finished_at DESC',
      join: 'LEFT JOIN scores m ON m.room_id = r.id AND m.player_id = ?',
    },
    pieces: PIECES,
  },
  public: { recent: { order: 'r.played_at DESC, r.created DESC' }, newest: NEWEST, nearly: NEARLY, pieces: PIECES },
}
const KINDS: readonly RoomListKind[] = ['mine', 'finished', 'public']
// sort when list kind can be sorted that way, else its default.
const sortFor = (kind: RoomListKind, sort: string | null | undefined) =>
  (sort && sort in ORDERS[kind] ? sort : Object.keys(ORDERS[kind])[0]) as RoomSort

// How many of each list the jigsaws page shows before "See all", and how many a page of a list has.
const HOME = { mine: 40, finished: 10, public: 20 }
const PAGE = 40

export function createRooms({ prepare, tx, deleteRoom }: Db, hub: Hub, players: Players, table: Table) {
  const q = {
    // How many jigsaws a player made, the connections they made and the time they spent, in all.
    stats: prepare<PlayerStats>(`
      SELECT (SELECT COUNT(*) FROM rooms WHERE owner = ?1) AS made,
             (SELECT COALESCE(SUM(n), 0) FROM scores WHERE player_id = ?1) AS connections,
             (SELECT COALESCE(SUM(seconds), 0) FROM times WHERE user = ?1) AS seconds`),
    room: prepare<Room>(
      `SELECT id, name, created, cols, rows, shape, seed, width, height, long_pieces AS longPieces, owner, private,
              has_preview AS preview FROM rooms WHERE id = ?`,
    ),
    // A jigsaw's pictures are in room_pictures (see migration 030), out of the way of the rest of it.
    image: prepare<{ image: Uint8Array; image_type: string }>(
      'SELECT p.image, r.image_type FROM room_pictures p JOIN rooms r ON r.id = p.room_id WHERE p.room_id = ?',
    ),
    // What a jigsaw's link preview shows, see sharing().
    share: prepare<{ id: string; name: string; width: number; height: number; private: number; preview: number; thumb: number; n: number; groups: number }>(
      `SELECT r.id, r.name, r.width, r.height, r.private, r.has_preview AS preview, r.has_thumb AS thumb,
              r.piece_count AS n, r.group_count AS groups FROM rooms r WHERE r.id = ?`,
    ),
    preview: prepare<{ preview: Uint8Array }>('SELECT preview FROM room_pictures WHERE room_id = ? AND preview IS NOT NULL'),
    // Only ever set once, so a preview can be cached for good and nobody can swap one that's there.
    setPreview: prepare('UPDATE room_pictures SET preview = ? WHERE room_id = ? AND preview IS NULL'),
    hasPreview: prepare('UPDATE rooms SET has_preview = 1 WHERE id = ?'),
    // Stored as text or as bytes, depending on how the jigsaw was saved.
    thumb: prepare<{ thumb: string | Uint8Array }>('SELECT thumb FROM room_pictures WHERE room_id = ?'),
    // The picture columns of rooms are left empty, see migration 030.
    insertRoom: prepare(`
      INSERT INTO rooms (id, name, created, cols, rows, shape, seed, width, height, image, image_type, thumb, owner, private, long_pieces, units,
                         has_thumb, has_preview, piece_count, group_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, x'', ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertPictures: prepare('INSERT INTO room_pictures (room_id, image, thumb, preview) VALUES (?, ?, ?, ?)'),
    insertPiece: prepare('INSERT INTO pieces (room_id, idx, x, y, r, g) VALUES (?, ?, ?, ?, ?, ?)'),
    join: prepare('INSERT OR IGNORE INTO room_players (room_id, player_id, joined) VALUES (?, ?, ?)'),
    member: prepare('SELECT 1 FROM room_players WHERE room_id = ? AND player_id = ?'),
    times: prepare<{ user: string; seconds: number }>('SELECT user, seconds FROM times WHERE room_id = ?'),
    addTime: prepare<{ seconds: number }>(`
      INSERT INTO times (room_id, user, seconds, seen) VALUES (?, ?, ?, ?)
      ON CONFLICT (room_id, user) DO UPDATE SET seconds = seconds + excluded.seconds, seen = excluded.seen
      RETURNING seconds`),
    // When each player was last in a room, for "last played".
    seen: prepare<{ user: string; seen: number }>('SELECT user, seen FROM times WHERE room_id = ? AND seen > 0'),
    // Everyone who has left a mark on a room, so their names can be shown.
    roomPlayers: prepare<PlayerRef>(`
      SELECT id, name, avatar_at AS avatar FROM players WHERE id IN (
        SELECT "by" FROM pieces WHERE room_id = ?1
        UNION SELECT player_id FROM scores WHERE room_id = ?1
        UNION SELECT author FROM notes WHERE room_id = ?1
        UNION SELECT author FROM refs WHERE room_id = ?1
        UNION SELECT author FROM trays WHERE room_id = ?1
        UNION SELECT author FROM note_replies WHERE room_id = ?1
        UNION SELECT player_id FROM note_reactions WHERE room_id = ?1
        UNION SELECT user FROM times WHERE room_id = ?1
      )`),
    profile: prepare<PlayerRef & { created: number }>('SELECT id, name, avatar_at AS avatar, created FROM players WHERE id = ?'),
    // The jigsaws a player made, made connections in or spent time in, with their share of each.
    // Private ones only when the asking player (?2) has the link too.
    playerRooms: prepare<{ n: number; groups: number; theirs: number } & Record<string, unknown>>(`
      SELECT r.id, r.name, r.created, r.width, r.height, ${THUMB}, r.owner, r.private, r.piece_count AS n, r.group_count AS groups,
             r.seconds, r.finished_at AS finished,
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

  // The lists of jigsaws, each made the first time it's asked for: kind, sorted by sort.
  const lists = new Map<string, { page: Stmt<SummaryRow>; count: Stmt<{ n: number }>; joined: boolean }>()
  function listOf(kind: RoomListKind, sort: RoomSort) {
    const key = `${kind} ${sort}`
    let l = lists.get(key)
    if (!l) {
      const where = [
        kind === 'public' ? 'r.private = 0' : MINE,
        kind === 'finished' ? 'r.group_count = 1' : 'r.group_count != 1',
      ].join(' AND ')
      const { order, join = '' } = ORDERS[kind][sort]!
      l = {
        page: prepare<SummaryRow>(`SELECT ${SUMMARY} FROM rooms r ${join} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`),
        count: prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM rooms r WHERE ${where}`),
        joined: !!join,
      }
      lists.set(key, l)
    }
    return l
  }
  // A page of a list, from start, for player me ('' for nobody: their own lists are empty).
  function page(kind: RoomListKind, me: string, opts: { sort?: RoomSort; start?: number; limit: number }): RoomPage {
    if (kind !== 'public' && !me) return { rooms: [], total: 0, next: null }
    const { start = 0, limit } = opts
    const l = listOf(kind, sortFor(kind, opts.sort))
    const params = kind === 'public' ? [] : [me, me, me]
    const rows = l.page.all(...(l.joined ? [me] : []), ...params, limit + 1, start)
    const more = rows.length > limit
    const rooms = rows.slice(0, limit).map((r) => summary(r, me))
    return { rooms, total: l.count.get(...params)?.n ?? 0, next: more ? start + limit : null }
  }
  // A row of a list as the page shows it, for player me: who's playing is everyone else in it, so
  // someone just back from a jigsaw (its socket still closing) isn't counted as playing it.
  const summary = (r: SummaryRow, me: string): RoomSummary => ({
    ...r,
    ...progress(r.n, r.groups),
    online: hub.online(r.id).filter((id) => id !== me).length,
  })

  // GET /api/rooms/home: what the jigsaws page shows (see HomeRooms).
  function home(req: IncomingMessage): HomeRooms {
    const me = players.asking(req)?.id || ''
    const mine = page('mine', me, { limit: HOME.mine })
    const finished = page('finished', me, { limit: HOME.finished })
    const pub = page('public', me, { limit: HOME.public })
    return {
      mine: mine.rooms,
      mineTotal: mine.total,
      finished: finished.rooms,
      finishedTotal: finished.total,
      public: pub.rooms,
      publicTotal: pub.total,
    }
  }

  // GET /api/rooms/list?kind=&sort=&start=: a page of one of the lists (see RoomListKind).
  function list(req: IncomingMessage, query: URLSearchParams): Reply {
    const kind = query.get('kind') as RoomListKind
    if (!KINDS.includes(kind)) return fail(400, 'bad request')
    const sort = query.get('sort')
    const me = players.asking(req)?.id || ''
    return ok(
      page(kind, me, {
        sort: sortFor(kind, sort),
        start: Math.max(0, Number(query.get('start')) | 0),
        limit: PAGE,
      }),
    )
  }

  // GET and POST /api/rooms
  async function rooms(req: IncomingMessage): Promise<Reply> {
    // Pages from before the jigsaws page had its own lists get its lists in one.
    if (req.method === 'GET') {
      const h = home(req)
      const seen = new Set<string>()
      return ok([...h.mine, ...h.finished, ...h.public].filter((r) => !seen.has(r.id) && !!seen.add(r.id)))
    }
    if (req.method !== 'POST') return
    // A new jigsaw is a big upload, read before its maker can be checked: each address gets so many.
    const ip = ipOf(req)
    if (uploads.blocked(ip)) return fail(429, 'too many new jigsaws from here, try again later')
    uploads.count(ip)
    // The pictures come as files in a form, with the rest as JSON in its room part (see api.create in
    // the page). Pages from before that send it all as JSON, the pictures as data URLs.
    let b: Partial<NewRoom>
    let pictures: { image: Picture | null; thumb: Picture | null; preview: Picture | null }
    if (isJson(req)) {
      const old = await readJson<NewRoom & { image: string; thumb: string; preview: string }>(req, NEW_ROOM_MAX)
      b = old
      pictures = { image: fromDataUrl(old.image), thumb: fromDataUrl(old.thumb), preview: fromDataUrl(old.preview) }
    } else {
      const form = await readForm(req, NEW_ROOM_MAX)
      const room = form.get('room')
      b = typeof room === 'string' ? JSON.parse(room) : {}
      pictures = { image: await fromPart(form.get('image')), thumb: await fromPart(form.get('thumb')), preview: await fromPart(form.get('preview')) }
    }
    const picture = pictureOf(pictures.image)
    // The thumbnail is kept as a data URL; one that isn't a picture is left out.
    const small = pictureOf(pictures.thumb)
    const thumb = small ? `data:${small.type};base64,${small.bytes.toString('base64')}` : ''
    const preview = previewBytes(pictures.preview)
    if (!picture || !Array.isArray(b.pieces) || !b.pieces.length || b.pieces.length > LIMITS.pieces) return fail(400, 'bad request')
    // The creator proves who they are with their passphrase, and becomes the owner.
    const owner = players.whoIs(b.passphrase, ip)
    if (!owner) return fail(403, 'log in to create a jigsaw')
    // A private jigsaw's link is all it takes to join, so it gets an id too long to guess.
    const hidden = !!b.private
    const id = hidden ? randomBytes(12).toString('base64url') : randomUUID().slice(0, 8)
    const pieces = b.pieces
    // The cells of a long piece start out in one group, so there are as many pieces as groups.
    const groups = new Set(pieces.map((p) => p.g)).size
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
        picture.type,
        owner.id,
        hidden ? 1 : 0,
        b.longPieces ? 1 : 0,
        b.longPieces ? groups : 0,
        thumb ? 1 : 0,
        preview ? 1 : 0,
        b.longPieces ? groups : pieces.length,
        groups,
      )
      q.insertPictures.run(id, picture.bytes, thumb, preview)
      if (hidden) q.join.run(id, owner.id, Date.now())
      for (const p of pieces) q.insertPiece.run(id, p.i, p.x, p.y, p.r, p.g)
    })
    return ok({ id })
  }

  // /api/rooms/:id[/image|thumb|preview|snapshots|join|time]
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
      const img = q.image.get(id)
      return img ? { file: asBuffer(img.image), type: imageType(img.image_type) } : fail(404, 'not found')
    }
    // The thumbnail, stored as a data URL, as a file; see sharing().
    if (route === 'GET thumb') {
      const thumb = q.thumb.get(id)?.thumb ?? ''
      const m = /^data:([^;]+);base64,(.*)$/s.exec(typeof thumb === 'string' ? thumb : asBuffer(thumb).toString('latin1'))
      return m ? { file: Buffer.from(m[2], 'base64'), type: imageType(m[1]) } : fail(404, 'not found')
    }
    if (route === 'GET preview') {
      const p = q.preview.get(id)
      return p ? { file: asBuffer(p.preview), type: 'image/jpeg' } : fail(404, 'not found')
    }
    if (route === 'GET snapshots') return ok(table.snapshots(id))
    // A jigsaw made before link previews gets one from the first page to open it (see Room.tsx).
    // Read here, before the other posts, as it's bigger than they may be.
    // Only its maker may give it one (anyone logged in, for a jigsaw from before they had makers), so
    // nobody can put their own picture on someone else's link. Private jigsaws show no preview.
    // It comes as the JPEG itself, with the player's passphrase in X-Passphrase (see api.preview in the
    // page); from pages before that, as JSON with the picture as a data URL.
    if (route === 'POST preview') {
      let passphrase: unknown = req.headers['x-passphrase']
      let picture: Picture | null
      if (isJson(req)) {
        const p = await readJson<{ image: string; passphrase: string }>(req, 2 * PREVIEW_MAX)
        passphrase = p.passphrase
        picture = fromDataUrl(p.image)
      } else picture = { type: String(req.headers['content-type'] || '').trim().toLowerCase(), bytes: await readBody(req, PREVIEW_MAX) }
      const who = players.whoIs(passphrase, ipOf(req))
      if (!who || room.private || (room.owner && who.id !== room.owner)) return fail(403, 'only the player who made this jigsaw can set its preview')
      const bytes = previewBytes(picture)
      if (!bytes) return fail(400, 'bad request')
      tx(() => {
        if (q.setPreview.run(bytes, id).changes) q.hasPreview.run(id)
      })
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
    profile,
    // GET /api/players/:id/stats
    stats: (id: string): Reply => ok(q.stats.get(id)),
    home: (req: IncomingMessage): Reply => ok(home(req)),
    list,
    rooms,
    room,
  }
}
