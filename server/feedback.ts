// Feedback from the dialog in Settings > General, kept in the feedback table to be read from there.
import type { IncomingMessage } from 'node:http'
import { LIMITS } from '../shared/protocol.ts'
import type { Db } from './db.ts'
import { fail, ipOf, ok, rateLimit, readJson } from './http.ts'
import type { Reply } from './http.ts'
import type { Players } from './players.ts'

export function createFeedback({ prepare }: Db, players: Players) {
  const insert = prepare('INSERT INTO feedback (created, player_id, room_id, text) VALUES (?, ?, ?, ?)')
  // Messages per address.
  const sent = rateLimit(20, 60 * 60 * 1000)

  // POST /api/feedback { text, passphrase?, room? }: whoever is logged in is noted with it.
  async function route(req: IncomingMessage): Promise<Reply> {
    const ip = ipOf(req)
    if (sent.blocked(ip)) return fail(429, 'too much feedback from here, try again later')
    const b = await readJson<{ text: string; passphrase: string; room: string }>(req)
    const text = String(b.text || '').trim().slice(0, LIMITS.text)
    if (!text) return fail(400, 'write something first')
    sent.count(ip)
    const who = b.passphrase ? players.whoIs(b.passphrase, ip) : null
    const room = String(b.room || '').slice(0, LIMITS.id) || null
    insert.run(Date.now(), who?.id ?? null, room, text)
    return ok({ ok: true })
  }

  return { route }
}
