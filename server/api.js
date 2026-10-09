// Vite plugin that exposes a small JSON/WebSocket API backed by SQLite (node:sqlite).
// Runs inside the Vite dev/preview server, so no separate backend process is needed.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { attachWebSocket } from './ws.js'
import { WORDS } from './words.js'
import { createMailer } from './mail.js'

function openDb(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created INTEGER NOT NULL,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      shape TEXT NOT NULL,
      seed INTEGER NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      image BLOB NOT NULL,
      image_type TEXT NOT NULL,
      thumb TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pieces (
      room_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      r INTEGER NOT NULL,
      g INTEGER NOT NULL,
      by TEXT,
      PRIMARY KEY (room_id, idx)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY (room_id, id)
    );
    CREATE TABLE IF NOT EXISTS times (
      room_id TEXT NOT NULL,
      user TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, user)
    );
  `)
  migrate(db)
  return db
}

// Applies server/migrations/NNN-name.sql files in order, once each, tracked with PRAGMA user_version.
// The CREATE statements above are the baseline schema and must not change; add a migration instead.
function migrate(db) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^\d+-.+\.sql$/.test(f))
  } catch {
    return
  }
  files.sort((a, b) => parseInt(a) - parseInt(b))
  const current = db.prepare('PRAGMA user_version').get().user_version
  for (const f of files) {
    const v = parseInt(f)
    if (v <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(readFileSync(join(dir, f), 'utf8'))
      db.exec(`PRAGMA user_version = ${v}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${f} failed: ${e.message}`)
    }
  }
}

function readJson(req, limit = 40 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        fail(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        fail(e)
      }
    })
    req.on('error', fail)
  })
}

// Passphrases are compared case and spacing blind: "Otter  maple-moon Jolly" is "otter maple moon jolly".
const normalize = (s) => String(s || '').toLowerCase().split(/[^a-z]+/).filter(Boolean).join(' ')
const hashSecret = (s) => createHash('sha256').update(normalize(s)).digest('hex')
const cleanName = (s) => String(s || '').trim().slice(0, 32)
const cleanEmail = (s) => String(s || '').trim().toLowerCase().slice(0, 254)
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
const MIN_PASSWORD = 8

// Passwords are stored as "salt:hash", both hex, hashed with scrypt.
function hashPassword(password) {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(String(password), salt, 32).toString('hex')}`
}
function checkPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':')
  if (!salt || !hash) return false
  const got = scryptSync(String(password), Buffer.from(salt, 'hex'), 32)
  const want = Buffer.from(hash, 'hex')
  return want.length === got.length && timingSafeEqual(got, want)
}

// The machine's first network address, so a phone on the same network can open the app.
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}

// Where links in emails point: APP_URL when set, otherwise the address the browser used.
function siteOrigin(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '')
  return req.headers.origin || `http://${req.headers.host}`
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function createApi(dbFile) {
  const db = openDb(dbFile)
  const mailer = createMailer()
  const sockets = new Map() // roomId -> Set<ws>

  const q = {
    list: db.prepare(`
      SELECT r.id, r.name, r.created, r.cols, r.rows, r.shape, r.thumb, r.owner, r.private,
             CASE WHEN r.units > 0 THEN r.units ELSE COUNT(p.idx) END AS n, COUNT(DISTINCT p.g) AS groups,
             (SELECT COALESCE(SUM(t.seconds), 0) FROM times t WHERE t.room_id = r.id) AS seconds
      FROM rooms r LEFT JOIN pieces p ON p.room_id = r.id
      WHERE r.private = 0 OR r.id IN (SELECT room_id FROM room_players WHERE player_id = ?)
      GROUP BY r.id ORDER BY r.created DESC`),
    room: db.prepare(
      'SELECT id, name, created, cols, rows, shape, seed, width, height, annoying, long_pieces AS longPieces, owner, private FROM rooms WHERE id = ?',
    ),
    image: db.prepare('SELECT image, image_type FROM rooms WHERE id = ?'),
    pieces: db.prepare('SELECT idx AS i, x, y, r, g, by, f FROM pieces WHERE room_id = ? ORDER BY idx'),
    insertRoom: db.prepare(`
      INSERT INTO rooms (id, name, created, cols, rows, shape, seed, width, height, image, image_type, thumb, annoying, owner, private, long_pieces, units)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertPiece: db.prepare(
      'INSERT INTO pieces (room_id, idx, x, y, r, g, by, f) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    updatePiece: db.prepare(
      'UPDATE pieces SET x = ?, y = ?, r = ?, g = ?, by = COALESCE(?, by), f = COALESCE(?, f) WHERE room_id = ? AND idx = ?',
    ),
    deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),
    deletePieces: db.prepare('DELETE FROM pieces WHERE room_id = ?'),
    join: db.prepare('INSERT OR IGNORE INTO room_players (room_id, player_id, joined) VALUES (?, ?, ?)'),
    deleteMembers: db.prepare('DELETE FROM room_players WHERE room_id = ?'),
    member: db.prepare('SELECT 1 FROM room_players WHERE room_id = ? AND player_id = ?'),
    // Players who can be invited by email (never the address itself), and whether they already have the room.
    invitable: db.prepare(`
      SELECT p.id, p.name, EXISTS (SELECT 1 FROM room_players m WHERE m.room_id = ?1 AND m.player_id = p.id) AS joined
      FROM players p WHERE p.email IS NOT NULL AND p.id != ?2 ORDER BY p.name COLLATE NOCASE`),
    emailOf: db.prepare('SELECT id, email FROM players WHERE id = ? AND email IS NOT NULL'),
    notes: db.prepare('SELECT id, x, y, text, author, created FROM notes WHERE room_id = ? ORDER BY created'),
    upsertNote: db.prepare(`
      INSERT INTO notes (id, room_id, x, y, text, author, created) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room_id, id) DO UPDATE SET x = excluded.x, y = excluded.y, text = excluded.text`),
    note: db.prepare('SELECT id, x, y, text, author, created FROM notes WHERE room_id = ? AND id = ?'),
    deleteNote: db.prepare('DELETE FROM notes WHERE room_id = ? AND id = ?'),
    deleteNotes: db.prepare('DELETE FROM notes WHERE room_id = ?'),
    times: db.prepare('SELECT user, seconds FROM times WHERE room_id = ?'),
    addTime: db.prepare(`
      INSERT INTO times (room_id, user, seconds, seen) VALUES (?, ?, ?, ?)
      ON CONFLICT (room_id, user) DO UPDATE SET seconds = seconds + excluded.seconds, seen = excluded.seen
      RETURNING seconds`),
    // When each player was last in a room, for "last played".
    seen: db.prepare('SELECT user, seen FROM times WHERE room_id = ? AND seen > 0'),
    setSeen: db.prepare(`
      INSERT INTO times (room_id, user, seen) VALUES (?, ?, ?)
      ON CONFLICT (room_id, user) DO UPDATE SET seen = excluded.seen`),
    deleteTimes: db.prepare('DELETE FROM times WHERE room_id = ?'),
    refs: db.prepare('SELECT id, x, y, w, opacity, trim_x AS trimX, trim_y AS trimY, trim_w AS trimW, trim_h AS trimH, author, created FROM refs WHERE room_id = ? ORDER BY created'),
    upsertRef: db.prepare(`
      INSERT INTO refs (id, room_id, x, y, w, opacity, trim_x, trim_y, trim_w, trim_h, author, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room_id, id) DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w, opacity = excluded.opacity,
        trim_x = excluded.trim_x, trim_y = excluded.trim_y, trim_w = excluded.trim_w, trim_h = excluded.trim_h`),
    ref: db.prepare('SELECT id, x, y, w, opacity, trim_x AS trimX, trim_y AS trimY, trim_w AS trimW, trim_h AS trimH, author, created FROM refs WHERE room_id = ? AND id = ?'),
    deleteRef: db.prepare('DELETE FROM refs WHERE room_id = ? AND id = ?'),
    deleteRefs: db.prepare('DELETE FROM refs WHERE room_id = ?'),
    trays: db.prepare(
      'SELECT id, x, y, w, h, name, color, num, auto, pieces, author, created FROM trays WHERE room_id = ? ORDER BY created',
    ),
    upsertTray: db.prepare(`
      INSERT INTO trays (id, room_id, x, y, w, h, name, color, num, auto, pieces, author, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room_id, id) DO UPDATE SET
        x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, name = excluded.name, color = excluded.color,
        num = excluded.num, auto = excluded.auto, pieces = excluded.pieces`),
    tray: db.prepare('SELECT id, x, y, w, h, name, color, num, auto, pieces, author, created FROM trays WHERE room_id = ? AND id = ?'),
    deleteTray: db.prepare('DELETE FROM trays WHERE room_id = ? AND id = ?'),
    deleteTrays: db.prepare('DELETE FROM trays WHERE room_id = ?'),
    player: db.prepare('SELECT id, name FROM players WHERE id = ?'),
    // A passphrase, or the token of a device logged in with an email and password.
    playerBySecret: db.prepare(`
      SELECT id, name, email FROM players WHERE secret = ?1
      UNION SELECT p.id, p.name, p.email FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token = ?1`),
    playerByEmail: db.prepare('SELECT id, name, email, password FROM players WHERE email = ?'),
    unclaimed: db.prepare(
      'SELECT id, name FROM players WHERE name = ? AND secret IS NULL AND email IS NULL ORDER BY created LIMIT 1',
    ),
    secretTaken: db.prepare('SELECT 1 FROM players WHERE secret = ?'),
    named: db.prepare('SELECT 1 FROM players WHERE name = ? LIMIT 1'),
    insertPlayer: db.prepare('INSERT INTO players (id, name, secret, created) VALUES (?, ?, ?, ?)'),
    setSecret: db.prepare('UPDATE players SET secret = ? WHERE id = ?'),
    renamePlayer: db.prepare('UPDATE players SET name = ? WHERE id = ? RETURNING id, name'),
    useEmail: db.prepare('UPDATE players SET email = ?, password = ?, secret = NULL WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token, player_id, created) VALUES (?, ?, ?)'),
    // Everyone who has left a mark on a room, so their names can be shown.
    roomPlayers: db.prepare(`
      SELECT id, name FROM players WHERE id IN (
        SELECT "by" FROM pieces WHERE room_id = ?1
        UNION SELECT author FROM notes WHERE room_id = ?1
        UNION SELECT author FROM refs WHERE room_id = ?1
        UNION SELECT user FROM times WHERE room_id = ?1
      )`),
  }

  // A fresh passphrase of four words that no other player has.
  function newSecret() {
    for (;;) {
      const words = Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]).join(' ')
      if (!q.secretTaken.get(hashSecret(words))) return words
    }
  }

  // A new login token for a player with an email. Only letters, so it survives normalize() like a
  // passphrase does, and the browser keeps it in place of one.
  function newSession(playerId) {
    const token = Array.from(randomBytes(32), (b) => String.fromCharCode(97 + (b % 26))).join('')
    q.insertSession.run(hashSecret(token), playerId, Date.now())
    return token
  }

  // Emails a private jigsaw's link to players with an email, and adds it to their list. Players who
  // already have it are skipped, so nobody gets the same invite twice. Returns how many were invited.
  function invite(room, from, ids, origin) {
    const link = `${origin}/r/${room.id}`
    let n = 0
    for (const id of new Set((Array.isArray(ids) ? ids : []).slice(0, 50).map(String))) {
      const p = q.emailOf.get(id)
      if (!p || p.id === from.id || q.member.get(room.id, p.id)) continue
      q.join.run(room.id, p.id, Date.now())
      mailer.send({
        to: p.email,
        subject: `${from.name} invited you to a jigsaw`,
        text: `${from.name} invited you to play "${room.name}", a private jigsaw.\n\nOpen it here: ${link}\n\nOnly people with this link can see and play it.`,
      })
      n++
    }
    return n
  }

  function createPlayer(name) {
    const id = randomBytes(8).toString('hex')
    const passphrase = newSecret()
    q.insertPlayer.run(id, name, hashSecret(passphrase), Date.now())
    return { id, name, passphrase }
  }

  // Failed logins per address, to keep passphrases from being guessed: ip -> { n, t }.
  const failures = new Map()
  const LOGIN_TRIES = 20
  const LOGIN_WINDOW = 10 * 60 * 1000
  const blocked = (ip) => {
    const f = failures.get(ip)
    if (f && Date.now() - f.t > LOGIN_WINDOW) failures.delete(ip)
    return (failures.get(ip)?.n || 0) >= LOGIN_TRIES
  }
  const failed = (ip) => {
    const f = failures.get(ip) || { n: 0, t: Date.now() }
    f.n++
    failures.set(ip, f)
  }

  function tx(fn) {
    db.exec('BEGIN')
    try {
      fn()
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  function broadcast(roomId, msg, except) {
    const set = sockets.get(roomId)
    if (!set) return
    const data = JSON.stringify(msg)
    for (const ws of set) if (ws !== except) ws.send(data)
  }

  // Who is in a room right now, by player id.
  function online(roomId) {
    const ids = new Set()
    for (const ws of sockets.get(roomId) || []) if (ws.player) ids.add(ws.player.id)
    return [...ids]
  }
  // Everyone in a room counts as seen now, once a minute: if the server stops without their sockets
  // closing, "last played" is still about right.
  setInterval(() => {
    const now = Date.now()
    for (const roomId of sockets.keys()) for (const id of online(roomId)) q.setSeen.run(roomId, id, now)
  }, 60000).unref()

  // Tells the room who is here, and when anyone who just left was last seen.
  function presence(roomId, left) {
    const seen = {}
    if (left) {
      seen[left.id] = Date.now()
      q.setSeen.run(roomId, left.id, seen[left.id])
    }
    broadcast(roomId, { type: 'presence', online: online(roomId), seen })
  }

  // Only real player ids are stored as authors; anything else (such as a name sent by a page from
  // before players) is dropped.
  const playerId = (v) => (v && q.player.get(String(v)) ? String(v) : null)

  function saveMoves(roomId, pieces) {
    const known = new Map()
    const by = (v) => {
      if (v == null) return null
      if (!known.has(v)) known.set(v, playerId(v))
      return known.get(v)
    }
    tx(() => {
      for (const p of pieces) {
        p.by = by(p.by)
        q.updatePiece.run(p.x, p.y, p.r, p.g, p.by, p.f == null ? null : p.f ? 1 : 0, roomId, p.i)
      }
    })
  }

  const cleanNote = (b) => ({
    id: String(b?.id || '').slice(0, 40),
    x: +b?.x || 0,
    y: +b?.y || 0,
    text: String(b?.text || '').slice(0, 2000),
    author: String(b?.author || '').slice(0, 32),
  })
  // The part of an image that shows, as fractions of the picture: the whole of it when not given.
  const cleanTrim = (b) => {
    const f = (v, d, lo, hi) => Math.min(hi, Math.max(lo, v == null || !Number.isFinite(+v) ? d : +v))
    const trimX = f(b?.trimX, 0, 0, 0.99)
    const trimY = f(b?.trimY, 0, 0, 0.99)
    return { trimX, trimY, trimW: f(b?.trimW, 1, 0.01, 1 - trimX), trimH: f(b?.trimH, 1, 0.01, 1 - trimY) }
  }
  const cleanRef = (b) => ({
    id: String(b?.id || '').slice(0, 40),
    x: +b?.x || 0,
    y: +b?.y || 0,
    w: Math.max(1, +b?.w || 0),
    opacity: Math.min(1, Math.max(0.1, +b?.opacity || 1)),
    ...cleanTrim(b),
    author: String(b?.author || '').slice(0, 32),
  })

  const cleanTray = (b) => ({
    id: String(b?.id || '').slice(0, 40),
    x: +b?.x || 0,
    y: +b?.y || 0,
    w: Math.max(1, +b?.w || 0),
    h: Math.max(1, +b?.h || 0),
    name: String(b?.name || '').slice(0, 40),
    color: String(b?.color || '').slice(0, 16),
    num: Math.min(9, Math.max(0, Math.trunc(+b?.num) || 0)),
    auto: !!b?.auto,
    // Left out of live updates (while dragging), which don't change what's in the tray.
    pieces: Array.isArray(b?.pieces) ? b.pieces.filter((i) => Number.isInteger(i) && i >= 0).slice(0, 20000) : undefined,
    author: String(b?.author || '').slice(0, 32),
  })
  // A stored tray, with its pieces as a list again.
  const trayOut = (row) => row && { ...row, auto: !!row.auto, pieces: JSON.parse(row.pieces || '[]') }

  // Notes, reference images and trays: live=true only relays (while dragging), otherwise it's saved.
  function putNote(roomId, b, live) {
    const n = cleanNote(b)
    if (!n.id) return null
    if (live) return { ...n, created: +b.created || 0 }
    n.author = playerId(n.author) || ''
    q.upsertNote.run(n.id, roomId, n.x, n.y, n.text, n.author, Date.now())
    return q.note.get(roomId, n.id)
  }
  function putRef(roomId, b, live) {
    const r = cleanRef(b)
    if (!r.id) return null
    if (live) return { ...r, created: +b.created || 0 }
    r.author = playerId(r.author) || ''
    q.upsertRef.run(r.id, roomId, r.x, r.y, r.w, r.opacity, r.trimX, r.trimY, r.trimW, r.trimH, r.author, Date.now())
    return q.ref.get(roomId, r.id)
  }

  function putTray(roomId, b, live) {
    const t = cleanTray(b)
    if (!t.id) return null
    if (live) return { ...t, created: +b.created || 0 }
    t.author = playerId(t.author) || ''
    const pieces = JSON.stringify(t.pieces || trayOut(q.tray.get(roomId, t.id))?.pieces || [])
    q.upsertTray.run(t.id, roomId, t.x, t.y, t.w, t.h, t.name, t.color, t.num, t.auto ? 1 : 0, pieces, t.author, Date.now())
    return trayOut(q.tray.get(roomId, t.id))
  }

  // One socket per open room. Live drag messages ("grab", "live") are only relayed;
  // "moves" are the final positions after a drop and get persisted.
  function connect(ws, url) {
    const roomId = url.searchParams.get('room') || ''
    const client = url.searchParams.get('client') || ''
    if (!q.room.get(roomId)) return ws.closed()
    if (!sockets.has(roomId)) sockets.set(roomId, new Set())
    sockets.get(roomId).add(ws)
    // Tell the room who just arrived, so their name shows on whatever they do.
    const player = q.player.get(url.searchParams.get('player') || '')
    ws.player = player || null
    if (player) broadcast(roomId, { type: 'player', client, player: { id: player.id, name: player.name } }, ws)
    presence(roomId)
    ws.handler = (text) => {
      try {
        handle(JSON.parse(text))
      } catch {}
    }
    const handle = (m) => {
      // The player on this socket logged in, out or signed up.
      if (m.type === 'hello') {
        const p = q.player.get(String(m.player || ''))
        const before = ws.player
        ws.player = p || null
        if (p) broadcast(roomId, { type: 'player', client, player: { id: p.id, name: p.name } }, ws)
        if (before?.id !== p?.id) presence(roomId, before)
      } else if (m.type === 'moves' && Array.isArray(m.pieces)) {
        saveMoves(roomId, m.pieces)
        broadcast(roomId, { type: 'moves', client, pieces: m.pieces, turns: Array.isArray(m.turns) ? m.turns.slice(0, 2000) : undefined }, ws)
      } else if (m.type === 'grab' || m.type === 'live' || m.type === 'cursor' || m.type === 'marks') {
        broadcast(roomId, { ...m, client }, ws)
      } else if (m.type === 'react' && isFinite(m.x) && isFinite(m.y)) {
        broadcast(roomId, { type: 'react', client, kind: String(m.kind || '').slice(0, 16), x: +m.x, y: +m.y }, ws)
      } else if (m.type === 'note' || m.type === 'ref' || m.type === 'tray') {
        const put = { note: putNote, ref: putRef, tray: putTray }[m.type]
        const item = put(roomId, m[m.type], !!m.live)
        if (item) broadcast(roomId, { type: m.type, client, live: !!m.live, [m.type]: item }, ws)
      } else if (m.type === 'note-delete' || m.type === 'ref-delete' || m.type === 'tray-delete') {
        const id = String(m.id || '')
        const del = { 'note-delete': q.deleteNote, 'ref-delete': q.deleteRef, 'tray-delete': q.deleteTray }[m.type]
        del.run(roomId, id)
        broadcast(roomId, { type: m.type, client, id }, ws)
      }
    }
    ws.onclose = () => {
      sockets.get(roomId)?.delete(ws)
      broadcast(roomId, { type: 'gone', client })
      presence(roomId, ws.player)
    }
  }

  const middleware = async function middleware(req, res, next) {
    const url = new URL(req.url, 'http://x')
    if (!url.pathname.startsWith('/api/')) return next()
    const parts = url.pathname.slice(5).split('/').filter(Boolean)

    try {
      // /api/lan: where phones on the same network can reach this server.
      if (parts[0] === 'lan' && req.method === 'GET') return send(res, 200, { address: lanAddress() })

      // /api/players/invitable: players who can get an email invite, for a logged in player.
      // With ?room=, each says whether they already have that jigsaw.
      if (parts[0] === 'players' && parts[1] === 'invitable' && req.method === 'GET') {
        const who = req.headers['x-passphrase'] ? q.playerBySecret.get(hashSecret(req.headers['x-passphrase'])) : null
        if (!who) return send(res, 403, { error: 'log in to invite players' })
        const list = q.invitable.all(url.searchParams.get('room') || '', who.id)
        return send(res, 200, list.map((p) => ({ ...p, joined: !!p.joined })))
      }

      // /api/players: sign up with a name, log in with a passphrase, rename.
      if (parts[0] === 'players' && req.method === 'POST') {
        const b = await readJson(req, 64 * 1024)
        if (parts.length === 1) {
          const name = cleanName(b.name)
          if (!name) return send(res, 400, { error: 'name required' })
          return send(res, 200, createPlayer(name))
        }
        // Browsers from before passphrases only know a name: the first to ask gets the player made
        // for that name. Once it has a passphrase, other browsers with the name must log in with it
        // (409), so one person's devices don't split into separate players.
        if (parts[1] === 'claim') {
          const name = cleanName(b.name)
          if (!name) return send(res, 400, { error: 'name required' })
          const old = q.unclaimed.get(name)
          if (!old) {
            if (q.named.get(name)) return send(res, 409, { error: 'taken' })
            return send(res, 200, createPlayer(name))
          }
          const passphrase = newSecret()
          q.setSecret.run(hashSecret(passphrase), old.id)
          return send(res, 200, { id: old.id, name: old.name, passphrase })
        }
        if (parts[1] === 'login') {
          const ip = req.socket.remoteAddress || ''
          if (blocked(ip)) return send(res, 429, { error: 'too many tries, wait a few minutes' })
          const p = normalize(b.passphrase) && q.playerBySecret.get(hashSecret(b.passphrase))
          if (!p) {
            failed(ip)
            return send(res, 404, { error: 'unknown passphrase' })
          }
          return send(res, 200, { ...p, passphrase: normalize(b.passphrase) })
        }
        // Log in with an email and password: this device gets its own token to use as its passphrase.
        if (parts[1] === 'email-login') {
          const ip = req.socket.remoteAddress || ''
          if (blocked(ip)) return send(res, 429, { error: 'too many tries, wait a few minutes' })
          const p = q.playerByEmail.get(cleanEmail(b.email))
          if (!p || !checkPassword(b.password, p.password)) {
            failed(ip)
            return send(res, 404, { error: 'wrong email or password' })
          }
          return send(res, 200, { id: p.id, name: p.name, email: p.email, passphrase: newSession(p.id) })
        }
        // Switch from a passphrase to an email and password. The passphrase stops working, on every
        // device, and this one carries on with a new token.
        if (parts[1] === 'email') {
          const who = normalize(b.passphrase) && q.playerBySecret.get(hashSecret(b.passphrase))
          if (!who) return send(res, 404, { error: 'unknown passphrase' })
          if (who.email) return send(res, 400, { error: 'already using an email' })
          const email = cleanEmail(b.email)
          if (!validEmail(email)) return send(res, 400, { error: 'enter a valid email' })
          if (String(b.password || '').length < MIN_PASSWORD) {
            return send(res, 400, { error: `use at least ${MIN_PASSWORD} characters for the password` })
          }
          if (q.playerByEmail.get(email)) return send(res, 409, { error: 'that email is already in use' })
          let passphrase
          tx(() => {
            q.useEmail.run(email, hashPassword(b.password), who.id)
            passphrase = newSession(who.id)
          })
          return send(res, 200, { id: who.id, name: who.name, email, passphrase })
        }
        if (parts[1] === 'rename') {
          const name = cleanName(b.name)
          if (!name) return send(res, 400, { error: 'name required' })
          const who = normalize(b.passphrase) && q.playerBySecret.get(hashSecret(b.passphrase))
          if (!who) return send(res, 404, { error: 'unknown passphrase' })
          const p = q.renamePlayer.get(name, who.id)
          for (const [roomId, set] of sockets) {
            for (const ws of set) if (ws.player?.id === p.id) ws.player = p
            broadcast(roomId, { type: 'player', player: p })
          }
          return send(res, 200, p)
        }
        return send(res, 404, { error: 'not found' })
      }

      // /api/rooms
      if (parts[0] !== 'rooms') return send(res, 404, { error: 'not found' })

      if (parts.length === 1) {
        if (req.method === 'GET') {
          // Private jigsaws are listed only for players who have opened them. Player ids are seen by
          // everyone, so the list is asked for with the passphrase.
          const who = req.headers['x-passphrase'] ? q.playerBySecret.get(hashSecret(req.headers['x-passphrase'])) : null
          const rows = q.list.all(who?.id || '').map((r) => ({
            ...r,
            progress: r.n > 1 ? (r.n - r.groups) / (r.n - 1) : 0,
            done: r.n > 0 && r.groups === 1,
          }))
          return send(res, 200, rows)
        }
        if (req.method === 'POST') {
          const b = await readJson(req)
          const m = /^data:([^;]+);base64,(.*)$/s.exec(b.image || '')
          if (!m || !Array.isArray(b.pieces) || !b.pieces.length) {
            return send(res, 400, { error: 'bad request' })
          }
          // The creator proves who they are with their passphrase, and becomes the owner.
          const owner = b.passphrase ? q.playerBySecret.get(hashSecret(b.passphrase)) : null
          if (!owner) return send(res, 403, { error: 'log in to create a jigsaw' })
          // A private jigsaw's link is all it takes to join, so it gets an id too long to guess.
          const hidden = !!b.private
          const id = hidden ? randomBytes(12).toString('base64url') : randomUUID().slice(0, 8)
          tx(() => {
            q.insertRoom.run(
              id,
              String(b.name || 'Jigsaw').slice(0, 80),
              Date.now(),
              b.cols | 0,
              b.rows | 0,
              String(b.shape),
              b.seed | 0,
              +b.width,
              +b.height,
              Buffer.from(m[2], 'base64'),
              m[1],
              String(b.thumb || ''),
              b.annoying ? 1 : 0,
              owner.id,
              hidden ? 1 : 0,
              b.longPieces ? 1 : 0,
              // The cells of a long piece start out in one group, so there are as many pieces as groups.
              b.longPieces ? new Set(b.pieces.map((p) => p.g)).size : 0,
            )
            if (hidden) q.join.run(id, owner.id, Date.now())
            for (const p of b.pieces) q.insertPiece.run(id, p.i, p.x, p.y, p.r, p.g, null, p.f ? 1 : 0)
          })
          if (hidden) invite(q.room.get(id), owner, b.invite, siteOrigin(req))
          return send(res, 200, { id })
        }
      }

      const id = parts[1]
      const room = q.room.get(id)
      if (!room) return send(res, 404, { error: 'not found' })

      if (parts.length === 2) {
        if (req.method === 'GET') {
          const players = new Map(q.roomPlayers.all(id).map((p) => [p.id, p]))
          for (const ws of sockets.get(id) || []) if (ws.player) players.set(ws.player.id, ws.player)
          return send(res, 200, {
            ...room,
            pieces: q.pieces.all(id),
            notes: q.notes.all(id),
            refs: q.refs.all(id),
            trays: q.trays.all(id).map(trayOut),
            times: q.times.all(id),
            seen: Object.fromEntries(q.seen.all(id).map((s) => [s.user, s.seen])),
            online: online(id),
            players: [...players.values()],
          })
        }
        if (req.method === 'DELETE') {
          // Only the player who created the jigsaw may delete it; old jigsaws have no owner.
          const b = await readJson(req, 64 * 1024)
          const who = b.passphrase ? q.playerBySecret.get(hashSecret(b.passphrase)) : null
          if (!room.owner || !who || who.id !== room.owner) {
            return send(res, 403, { error: 'only the player who made this jigsaw can delete it' })
          }
          tx(() => {
            q.deletePieces.run(id)
            q.deleteNotes.run(id)
            q.deleteRefs.run(id)
            q.deleteTrays.run(id)
            q.deleteTimes.run(id)
            q.deleteMembers.run(id)
            q.deleteRoom.run(id)
          })
          broadcast(id, { type: 'deleted' })
          return send(res, 200, { ok: true })
        }
      }

      if (parts[2] === 'image' && req.method === 'GET') {
        const img = q.image.get(id)
        res.setHeader('Content-Type', img.image_type)
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        return res.end(Buffer.from(img.image))
      }

      // A player opened a private jigsaw's link: from now on it shows in their list.
      if (parts[2] === 'join' && req.method === 'POST') {
        const b = await readJson(req, 64 * 1024)
        const who = b.passphrase ? q.playerBySecret.get(hashSecret(b.passphrase)) : null
        if (room.private && who) q.join.run(id, who.id, Date.now())
        return send(res, 200, { ok: true })
      }

      // Anyone logged in with a private jigsaw's link may invite others to it.
      if (parts[2] === 'invite' && req.method === 'POST') {
        const b = await readJson(req, 64 * 1024)
        const who = b.passphrase ? q.playerBySecret.get(hashSecret(b.passphrase)) : null
        if (!who) return send(res, 403, { error: 'log in to invite players' })
        if (!room.private) return send(res, 400, { error: 'only private jigsaws take invites' })
        return send(res, 200, { invited: invite(room, who, b.players, siteOrigin(req)) })
      }

      if (parts[2] === 'time' && req.method === 'POST') {
        const b = await readJson(req)
        const user = playerId(b.user)
        const secs = Math.max(0, Math.min(300, Math.round(+b.seconds || 0)))
        if (!user || !secs) return send(res, 200, { ok: true })
        const { seconds } = q.addTime.get(id, user, secs, Date.now())
        broadcast(id, { type: 'time', client: b.client, user, seconds })
        return send(res, 200, { seconds })
      }

      send(res, 404, { error: 'not found' })
    } catch (e) {
      send(res, 500, { error: String(e.message || e) })
    }
  }

  return { middleware, connect }
}

export default function sqliteApi(options = {}) {
  const file = resolve(options.file || 'data/puzzle.db')
  let api
  const mount = (server) => {
    api ??= createApi(file)
    server.middlewares.use(api.middleware)
    if (server.httpServer) attachWebSocket(server.httpServer, '/api/ws', api.connect)
  }
  return {
    name: 'sqlite-api',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}
