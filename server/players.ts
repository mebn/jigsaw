import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { ERRORS, LIMITS } from '../shared/protocol.ts'
import type { PlayerRef } from '../shared/protocol.ts'
import type { Db } from './db.ts'
import { fail, ipOf, ok, printable, rateLimit, readJson } from './http.ts'
import type { Reply } from './http.ts'
import type { Hub } from './hub.ts'
import { WORDS } from './words.ts'

type PlayerRow = PlayerRef & { email: string | null }

// Passphrases are compared case and spacing blind: "Otter  maple-moon Jolly" is "otter maple moon jolly".
const normalize = (s: unknown) => String(s || '').toLowerCase().split(/[^a-z]+/).filter(Boolean).join(' ')
const hashSecret = (s: unknown) => createHash('sha256').update(normalize(s)).digest('hex')
const cleanName = (s: unknown) => printable(String(s || '')).trim().slice(0, LIMITS.name)
const cleanEmail = (s: unknown) => String(s || '').trim().toLowerCase().slice(0, LIMITS.email)
const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

// Passwords are stored as "salt:hash", both hex, hashed with scrypt.
function hashPassword(password: unknown) {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(String(password), salt, 32).toString('hex')}`
}
function checkPassword(password: unknown, stored: string | null) {
  const [salt, hash] = String(stored || '').split(':')
  if (!salt || !hash) return false
  const got = scryptSync(String(password), Buffer.from(salt, 'hex'), 32)
  const want = Buffer.from(hash, 'hex')
  return want.length === got.length && timingSafeEqual(got, want)
}

interface PlayerBody {
  name: string
  passphrase: string
  email: string
  password: string
}

export function createPlayers({ prepare, tx }: Db, hub: Hub) {
  const q = {
    player: prepare<PlayerRef>('SELECT id, name FROM players WHERE id = ?'),
    // A passphrase, or the token of a device logged in with an email and password.
    bySecret: prepare<PlayerRow>(`
      SELECT id, name, email FROM players WHERE secret = ?1
      UNION SELECT p.id, p.name, p.email FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token = ?1`),
    byEmail: prepare<PlayerRow & { password: string | null }>('SELECT id, name, email, password FROM players WHERE email = ?'),
    secretTaken: prepare('SELECT 1 FROM players WHERE secret = ?'),
    named: prepare('SELECT 1 FROM players WHERE name = ? LIMIT 1'),
    insert: prepare('INSERT INTO players (id, name, secret, created) VALUES (?, ?, ?, ?)'),
    rename: prepare<PlayerRef>('UPDATE players SET name = ? WHERE id = ? RETURNING id, name'),
    useEmail: prepare('UPDATE players SET email = ?, password = ?, secret = NULL WHERE id = ?'),
    insertSession: prepare('INSERT INTO sessions (token, player_id, created) VALUES (?, ?, ?)'),
  }
  // Wrong passphrases, tokens and passwords per address, to keep them from being guessed: wherever
  // one is given, not just when logging in. An address over the limit is nobody until it's let in again.
  const guesses = rateLimit(30, 10 * 60 * 1000)
  // New players per address.
  const signups = rateLimit(30, 60 * 60 * 1000)

  // A fresh passphrase of four words that no other player has.
  function newSecret() {
    for (;;) {
      const words = Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]).join(' ')
      if (!q.secretTaken.get(hashSecret(words))) return words
    }
  }

  // A new login token for a player with an email. Only letters, so it survives normalize() like a
  // passphrase does, and the browser keeps it in place of one.
  function newSession(playerId: string) {
    const token = Array.from(randomBytes(32), (b) => String.fromCharCode(97 + (b % 26))).join('')
    q.insertSession.run(hashSecret(token), playerId, Date.now())
    return token
  }

  function create(name: string) {
    const id = randomBytes(8).toString('hex')
    const passphrase = newSecret()
    q.insert.run(id, name, hashSecret(passphrase), Date.now())
    return { id, name, passphrase }
  }

  // The player with this passphrase (or device token), if any. ip: the address that gave it.
  function whoIs(secret: unknown, ip: string): PlayerRow | null {
    if (!normalize(secret) || guesses.blocked(ip)) return null
    const p = q.bySecret.get(hashSecret(secret)) || null
    if (!p) guesses.count(ip)
    return p
  }
  const asking = (req: IncomingMessage) => whoIs(req.headers['x-passphrase'], ipOf(req))
  const byId = (id: unknown) => (id ? q.player.get(String(id)) || null : null)

  // POST /api/players[/claim|login|email-login|email|rename]
  async function route(req: IncomingMessage, action: string | undefined): Promise<Reply> {
    const b = await readJson<PlayerBody>(req)
    const ip = ipOf(req)
    const tooMany = fail(429, 'too many tries, wait a few minutes')
    if ((action === undefined || action === 'claim') && signups.blocked(ip)) return fail(429, 'too many new players from here, try again later')
    if (action === undefined) {
      const name = cleanName(b.name)
      if (!name) return fail(400, 'name required')
      signups.count(ip)
      return ok(create(name))
    }
    // Browsers from before passphrases only know a name, which proves nothing: they get a new player
    // when the name is free, and are otherwise asked to log in or start fresh (409). A player from
    // back then is never handed over for knowing its name.
    if (action === 'claim') {
      const name = cleanName(b.name)
      if (!name) return fail(400, 'name required')
      if (q.named.get(name)) return fail(409, ERRORS.nameTaken)
      signups.count(ip)
      return ok(create(name))
    }
    if (action === 'login') {
      if (guesses.blocked(ip)) return tooMany
      const p = whoIs(b.passphrase, ip)
      if (!p) return fail(404, ERRORS.unknownPassphrase)
      return ok({ ...p, passphrase: normalize(b.passphrase) })
    }
    // Log in with an email and password: this device gets its own token to use as its passphrase.
    if (action === 'email-login') {
      if (guesses.blocked(ip)) return tooMany
      const p = q.byEmail.get(cleanEmail(b.email))
      if (!p || !checkPassword(b.password, p.password)) {
        guesses.count(ip)
        return fail(404, 'wrong email or password')
      }
      return ok({ id: p.id, name: p.name, email: p.email, passphrase: newSession(p.id) })
    }
    // Switch from a passphrase to an email and password. The passphrase stops working, on every
    // device, and this one carries on with a new token.
    if (action === 'email') {
      if (guesses.blocked(ip)) return tooMany
      const who = whoIs(b.passphrase, ip)
      if (!who) return fail(404, ERRORS.unknownPassphrase)
      if (who.email) return fail(400, 'already using an email')
      const email = cleanEmail(b.email)
      if (!validEmail(email)) return fail(400, 'enter a valid email')
      if (String(b.password || '').length < LIMITS.password) return fail(400, `use at least ${LIMITS.password} characters for the password`)
      if (q.byEmail.get(email)) return fail(409, 'that email is already in use')
      let passphrase = ''
      tx(() => {
        q.useEmail.run(email, hashPassword(b.password), who.id)
        passphrase = newSession(who.id)
      })
      return ok({ id: who.id, name: who.name, email, passphrase })
    }
    if (action === 'rename') {
      const name = cleanName(b.name)
      if (!name) return fail(400, 'name required')
      if (guesses.blocked(ip)) return tooMany
      const who = whoIs(b.passphrase, ip)
      if (!who) return fail(404, ERRORS.unknownPassphrase)
      const p = q.rename.get(name, who.id)!
      hub.renamed(p)
      return ok(p)
    }
  }

  return { whoIs, asking, byId, route }
}

export type Players = ReturnType<typeof createPlayers>
