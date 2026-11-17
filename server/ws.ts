// Minimal RFC 6455 WebSocket server that attaches to Vite's own HTTP server,
// so live updates need neither a separate process nor an extra dependency.
//
// Messages are compressed (permessage-deflate, RFC 7692) with pages that offer it, as browsers do,
// each message on its own: without context takeover either way. Small messages are sent as they are,
// as deflate doesn't make them smaller. Keeping each socket's deflate stream going (context takeover)
// would make the stream of small pointer and drag messages about half the size again, but each socket
// would then need its own compression of every message (a broadcast couldn't share one frame) and its
// own zlib memory, and Node only runs such streams asynchronously, adding a thread pool hop to every
// message; deflating each message on its own is synchronous and done once per broadcast.
import { createHash } from 'node:crypto'
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from 'node:zlib'
import type { IncomingMessage } from 'node:http'
import type { Socket as NetSocket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { HttpServer } from 'vite'
import { ipOf } from './http.ts'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
// Every socket is pinged this often (ms), and dropped if nothing, not even the pong, came back in
// DEAD_MS. A laptop going to sleep or losing its network never closes its sockets, so without this
// its player would stay in the room for good.
const PING_MS = 25000
const DEAD_MS = 70000
// The biggest message taken, in bytes: a move of every piece of the biggest jigsaw is well under it.
const MAX_MESSAGE = 4 * 1024 * 1024
// Messages smaller than this (bytes) go uncompressed: deflate makes them no smaller.
const DEFLATE_MIN = 128
// What a deflated message's last block ends in, left off on the wire (RFC 7692, 7.2.1).
const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff])

// A frame of the given opcode: its header and payload, written one after the other (see write()),
// so a big payload isn't copied to go behind its header. rsv1: the payload is deflated.
function frame(op: number, payload: Buffer, rsv1 = false) {
  const n = payload.length
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
  head[0] = 0x80 | (rsv1 ? 0x40 : 0) | op
  if (n < 126) head[1] = n
  else if (n < 65536) {
    head[1] = 126
    head.writeUInt16BE(n, 2)
  } else {
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return [head, payload]
}

// A binary message made once to go to many sockets (see sendMessage()), made into a frame as it is
// and deflated (with each window size asked for) only once a socket needs it so.
export class Message {
  private op = 2
  private data: Buffer
  private plain?: Buffer[]
  private deflated = new Map<number, Buffer[] | null>()

  constructor(data: Uint8Array) {
    this.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }

  // The frame for a socket that deflates with this window size (bits), or 0 for one that doesn't.
  frame(bits: number) {
    if (bits && this.data.length >= DEFLATE_MIN) {
      let f = this.deflated.get(bits)
      if (f === undefined) {
        const z = deflateRawSync(this.data, { level: zlibConstants.Z_BEST_SPEED, windowBits: bits, finishFlush: zlibConstants.Z_SYNC_FLUSH })
        // Sent so only when that's smaller.
        f = z.length - TAIL.length < this.data.length ? frame(this.op, z.subarray(0, z.length - TAIL.length), true) : null
        this.deflated.set(bits, f)
      }
      if (f) return f
    }
    return (this.plain ??= frame(this.op, this.data))
  }
}

// What a page offers in Sec-WebSocket-Extensions, taken if it can be: the window size to deflate with
// (bits) and the header to answer with, or null. Both sides start every message afresh.
export function negotiateDeflate(header: string | undefined): { bits: number; answer: string } | null {
  for (const offer of (header || '').split(',')) {
    const [name, ...params] = offer.split(';').map((p) => p.trim())
    if (name !== 'permessage-deflate') continue
    let bits = 15
    const seen = new Set<string>()
    let ok = true
    for (const p of params) {
      const [key, raw] = p.split('=').map((x) => x.trim())
      const value = raw?.replace(/^"(.*)"$/, '$1')
      if (seen.has(key)) ok = false
      seen.add(key)
      if (key === 'server_no_context_takeover' || key === 'client_no_context_takeover') ok &&= value === undefined
      else if (key === 'server_max_window_bits') {
        // zlib can't make raw deflate with an 8 bit window.
        const b = Number(value)
        if (/^\d+$/.test(value || '') && b >= 9 && b <= 15) bits = b
        else ok = false
      } else if (key === 'client_max_window_bits') ok &&= value === undefined || (/^\d+$/.test(value) && Number(value) >= 8 && Number(value) <= 15)
      else ok = false
    }
    if (!ok) continue
    let answer = 'permessage-deflate; server_no_context_takeover; client_no_context_takeover'
    if (seen.has('server_max_window_bits')) answer += `; server_max_window_bits=${bits}`
    return { bits, answer }
  }
  return null
}

export class Socket {
  private sock: NetSocket
  // What has come in and not been read yet, as it came, and how many bytes that is. Joined only
  // once a whole frame is there, so a big message isn't copied again with every bit of it.
  private chunks: Buffer[] = []
  private size = 0
  // The frames so far of a message in many, how many bytes they are, and whether it's deflated.
  private parts: Buffer[] = []
  private partsSize = 0
  private compressed = false
  private open = true
  private heard = Date.now()
  private gone: () => void
  // The window size (bits) messages to this page are deflated with, or 0 when they aren't (it didn't
  // offer to).
  readonly deflate: number
  // Set by whoever gets the socket from onConnect, before it reads anything. Messages are binary: a
  // text message closes the socket.
  onMessage?: (data: Buffer) => void
  onClose?: () => void

  constructor(sock: NetSocket, gone: () => void, deflate = 0) {
    this.sock = sock
    this.gone = gone
    this.deflate = deflate
    sock.setNoDelay(true)
    sock.on('data', (d: Buffer) => {
      this.heard = Date.now()
      this.read(d)
    })
    sock.on('close', () => this.closed())
    // The page's end hung up (the server's HTTP sockets stay half open otherwise, until a write fails).
    sock.on('end', () => this.closed())
    sock.on('error', () => this.closed())
  }

  // Writes a frame's header and payload together, in one packet when they fit.
  private write(f: Buffer[]) {
    this.sock.cork()
    for (const b of f) this.sock.write(b)
    this.sock.uncork()
  }

  send(data: Uint8Array) {
    if (this.open) this.write(new Message(data).frame(this.deflate))
  }

  // Sends a message made to go to many sockets.
  sendMessage(m: Message) {
    if (this.open) this.write(m.frame(this.deflate))
  }

  ping() {
    if (!this.open) return
    if (Date.now() - this.heard > DEAD_MS) return this.closed()
    this.write(frame(9, Buffer.alloc(0)))
  }

  // Closes the socket: with a close frame giving code and reason (RFC 6455, 7.4) when there's a code,
  // else at once.
  closed(code?: number, reason = '') {
    if (!this.open) return
    this.open = false
    if (code) {
      const r = Buffer.from(reason)
      const payload = Buffer.alloc(2 + r.length)
      payload.writeUInt16BE(code)
      r.copy(payload, 2)
      this.write(frame(8, payload))
      this.sock.end()
      // The page answers with its own close frame and closes; one that doesn't is dropped.
      setTimeout(() => this.sock.destroy(), 2000).unref()
    } else this.sock.destroy()
    this.gone()
    this.onClose?.()
  }

  // The first k bytes not read yet (fewer when there aren't that many), without taking them.
  private peek(k: number) {
    const first = this.chunks[0]
    if (first.length >= k) return first
    const out = Buffer.alloc(Math.min(k, this.size))
    let at = 0
    for (const c of this.chunks) {
      at += c.copy(out, at, 0, Math.min(c.length, out.length - at))
      if (at === out.length) break
    }
    return out
  }

  // Takes the first k bytes not read yet, in one buffer.
  private take(k: number) {
    let out: Buffer
    const first = this.chunks[0]
    if (first.length >= k) {
      out = first.subarray(0, k)
      if (first.length === k) this.chunks.shift()
      else this.chunks[0] = first.subarray(k)
    } else {
      out = Buffer.allocUnsafe(k)
      let at = 0
      while (at < k) {
        const c = this.chunks[0]
        const m = Math.min(c.length, k - at)
        c.copy(out, at, 0, m)
        at += m
        if (m === c.length) this.chunks.shift()
        else this.chunks[0] = c.subarray(m)
      }
    }
    this.size -= k
    return out
  }

  read(data: Buffer) {
    if (!this.open || !data.length) return
    this.chunks.push(data)
    this.size += data.length
    for (;;) {
      // Closed by what the last message did, or not enough for a header yet.
      if (!this.open || this.size < 2) return
      // A header is at most 14 bytes: 2, a 2 or 8 byte length, and a 4 byte mask.
      const b = this.peek(14)
      const fin = b[0] & 0x80
      const rsv1 = b[0] & 0x40
      const op = b[0] & 0x0f
      // Only the first frame of a data message may say it's deflated, and only once that was agreed.
      if (b[0] & 0x30 || (rsv1 && (!this.deflate || op === 0 || op > 7))) return this.closed()
      const masked = b[1] & 0x80
      let n = b[1] & 0x7f
      let o = 2
      if (n === 126) {
        if (b.length < 4) return
        n = b.readUInt16BE(2)
        o = 4
      } else if (n === 127) {
        if (b.length < 10) return
        n = Number(b.readBigUInt64BE(2))
        o = 10
      }
      if (n > MAX_MESSAGE) return this.closed()
      const mo = o
      if (masked) o += 4
      if (this.size < o + n) return
      const whole = this.take(o + n)
      let payload: Buffer
      if (masked) {
        // Unmasked into a buffer of its own, as it's kept while a message in many frames comes in.
        payload = Buffer.allocUnsafe(n)
        for (let i = 0; i < n; i++) payload[i] = whole[o + i] ^ whole[mo + (i & 3)]
      } else payload = Buffer.from(whole.subarray(o))

      if (op === 8) return this.closed()
      // Only binary messages are taken (see shared/wire.ts).
      if (op === 1) return this.closed(1003, 'binary messages only')
      // A message in many parts is held to the same size as one in a single frame.
      if (op === 0 && this.partsSize + n > MAX_MESSAGE) return this.closed()
      if (op === 9) this.write(frame(10, payload))
      else if (op === 0 || op === 2) {
        if (op !== 0) this.compressed = !!rsv1
        this.parts.push(payload)
        this.partsSize += n
        if (fin) {
          let data = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.partsSize)
          this.parts = []
          this.partsSize = 0
          if (this.compressed) {
            // Inflated to no more than a message may be, so a small message can't blow up into a huge one.
            try {
              data = inflateRawSync(Buffer.concat([data, TAIL]), { maxOutputLength: MAX_MESSAGE, finishFlush: zlibConstants.Z_SYNC_FLUSH })
            } catch {
              return this.closed()
            }
          }
          this.onMessage?.(data)
        }
      }
    }
  }
}

// Calls onConnect(socket, url, ip) for every upgrade request whose path matches; ip: where it's from.
// Other upgrades (such as Vite's HMR socket) are left alone.
export function attachWebSocket(httpServer: HttpServer, path: string, onConnect: (ws: Socket, url: URL, ip: string) => void) {
  const all = new Set<Socket>()
  const timer = setInterval(() => {
    for (const ws of all) ws.ping()
  }, PING_MS)
  timer.unref()
  httpServer.on('close', () => clearInterval(timer))
  httpServer.on('upgrade', (req: IncomingMessage, sock: Duplex, head: Buffer) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname !== path) return
    const key = req.headers['sec-websocket-key']
    if (!key) return sock.destroy()
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    const deflate = negotiateDeflate(req.headers['sec-websocket-extensions'])
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        (deflate ? `Sec-WebSocket-Extensions: ${deflate.answer}\r\n` : '') +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const ws: Socket = new Socket(sock as NetSocket, () => all.delete(ws), deflate?.bits || 0)
    all.add(ws)
    onConnect(ws, url, ipOf(req))
    if (head?.length) ws.read(head)
  })
}
