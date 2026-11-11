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

// Where links in emails point: APP_URL when set, otherwise the address the browser used.
export function siteOrigin(req: IncomingMessage) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '')
  return req.headers.origin || `http://${req.headers.host}`
}
