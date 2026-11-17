import type { IncomingMessage, ServerResponse } from 'node:http'

import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const brotli = promisify(brotliCompress)
const gzipped = promisify(gzip)

// A request's whole body, failing once it's over limit bytes.
export function readBody(req: IncomingMessage, limit: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks, size)))
    req.on('error', reject)
  })
}

export async function readJson<T>(req: IncomingMessage, limit = 64 * 1024): Promise<Partial<T>> {
  return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}')
}

// Whether a request's body is JSON, rather than a picture or a form with pictures in it.
export const isJson = (req: IncomingMessage) => /^application\/json\b/i.test(req.headers['content-type'] || '')

// A multipart/form-data body (see FormData in the page), parts with files in them as File.
export async function readForm(req: IncomingMessage, limit: number) {
  const body = await readBody(req, limit)
  return new Request('http://x', { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] || '' }, body }).formData()
}

// Answers smaller than this go as they are: compressing them saves next to nothing.
const COMPRESS_MIN = 1024

// The compression the page takes for an answer: brotli, gzip or none.
function encodingFor(req: IncomingMessage) {
  const taken = new Set<string>()
  for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim().toLowerCase())
    // q=0 says not this one.
    if (name && !params.some((p) => /^q=0(\.0*)?$/.test(p))) taken.add(name)
  }
  return taken.has('br') ? 'br' : taken.has('gzip') ? 'gzip' : null
}

export async function send(req: IncomingMessage, res: ServerResponse, reply: Reply) {
  if (!reply) reply = [404, { error: 'not found' }]
  if (!Array.isArray(reply)) {
    res.setHeader('Content-Type', reply.type)
    // Files are what players uploaded: never to be read as anything but their type, nor to run script.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    // Pictures are compressed already, so they go as they are.
    return res.end(reply.file)
  }
  res.statusCode = reply[0]
  res.setHeader('Content-Type', 'application/json')
  // The answer depends on what the page takes, so caches keep one per kind.
  res.setHeader('Vary', 'Accept-Encoding')
  const body = Buffer.from(JSON.stringify(reply[1]))
  const encoding = body.length >= COMPRESS_MIN ? encodingFor(req) : null
  if (!encoding) return res.end(body)
  // Brotli at a low quality: nearly as small as its best for JSON, and many times faster.
  const packed =
    encoding === 'br'
      ? await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
      : await gzipped(body, { level: 6 })
  res.setHeader('Content-Encoding', encoding)
  res.end(packed)
}

// A route's answer: [status, body as JSON], a file that never changes, or nothing when it doesn't
// handle the request.
export type Reply = [number, unknown] | { file: Buffer; type: string } | undefined
export const ok = (body: unknown): Reply => [200, body]
export const fail = (status: number, error: string): Reply => [status, { error }]

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
