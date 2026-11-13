import type { IncomingMessage, ServerResponse } from 'node:http'

export function readJson<T>(req: IncomingMessage, limit = 64 * 1024) {
  return new Promise<Partial<T>>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

export function send(res: ServerResponse, reply: Reply) {
  if (!reply) reply = [404, { error: 'not found' }]
  if (!Array.isArray(reply)) {
    res.setHeader('Content-Type', reply.type)
    // Files are what players uploaded: never to be read as anything but their type, nor to run script.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    return res.end(reply.file)
  }
  res.statusCode = reply[0]
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(reply[1]))
}

// A route's answer: [status, body as JSON], a file that never changes, or nothing when it doesn't
// handle the request.
export type Reply = [number, unknown] | { file: Buffer; type: string } | undefined
export const ok = (body: unknown): Reply => [200, body]
export const fail = (status: number, error: string): Reply => [status, { error }]

// Where links in emails point: APP_URL. Without it, the address the browser used, but whoever asks
// can make that up, so only while mail is printed to the log (sent: false, see mail.ts): an email
// that is really sent then goes without a link (null).
export function siteOrigin(req: IncomingMessage, sent: boolean) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '')
  return sent ? null : req.headers.origin || `http://${req.headers.host}`
}

// The address a request came from. Behind a proxy every request comes from the proxy, so
// CLIENT_IP_HEADER names the header the proxy puts the player's own address in (such as
// CF-Connecting-IP). Only set it when the server can't be reached around the proxy: anyone who can
// would write the header themselves.
export function ipOf(req: IncomingMessage) {
  const header = process.env.CLIENT_IP_HEADER?.trim().toLowerCase()
  const given = header ? req.headers[header] : undefined
  const ip = (Array.isArray(given) ? given[0] : given)?.trim().slice(0, 64)
  return ip || req.socket.remoteAddress || ''
}

// Text as it's stored for names: without control characters (which a terminal would act on) and
// without the marks that turn the text around them right to left.
export const printable = (s: string) => s.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, '')

// Holds each address to `tries` of something in windowMs: wrong passphrases, new players, uploads.
export function rateLimit(tries: number, windowMs: number) {
  const seen = new Map<string, { n: number; t: number }>()
  const fresh = (ip: string) => {
    const f = seen.get(ip)
    if (f && Date.now() - f.t > windowMs) seen.delete(ip)
    return seen.get(ip)
  }
  return {
    blocked: (ip: string) => (fresh(ip)?.n || 0) >= tries,
    count: (ip: string) => {
      // Addresses that are long done are forgotten once there are many.
      if (seen.size > 10000) for (const k of [...seen.keys()]) fresh(k)
      const f = fresh(ip) || { n: 0, t: Date.now() }
      f.n++
      seen.set(ip, f)
    },
  }
}
