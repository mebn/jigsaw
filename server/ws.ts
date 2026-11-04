// Minimal RFC 6455 WebSocket server that attaches to Vite's own HTTP server,
// so live updates need neither a separate process nor an extra dependency.
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket as NetSocket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { HttpServer } from 'vite'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
// Every socket is pinged this often (ms), and dropped if nothing, not even the pong, came back in
// DEAD_MS. A laptop going to sleep or losing its network never closes its sockets, so without this
// its player would stay in the room for good.
const PING_MS = 25000
const DEAD_MS = 70000

function frame(op: number, payload: Buffer) {
  const n = payload.length
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
  head[0] = 0x80 | op
  if (n < 126) head[1] = n
  else if (n < 65536) {
    head[1] = 126
    head.writeUInt16BE(n, 2)
  } else {
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return Buffer.concat([head, payload])
}

export class Socket {
  sock: NetSocket
  buf: Buffer
  parts: Buffer[]
  open: boolean
  onMessage: (text: string) => void
  onClose: () => void
  heard: number
  // Set by whoever gets the socket from onConnect.
  handler?: (text: string) => void
  onclose?: () => void

  constructor(sock: NetSocket, onMessage: (text: string) => void, onClose: () => void) {
    this.sock = sock
    this.buf = Buffer.alloc(0)
    this.parts = []
    this.open = true
    this.onMessage = onMessage
    this.onClose = onClose
    this.heard = Date.now()
    sock.setNoDelay(true)
    sock.on('data', (d: Buffer) => {
      this.heard = Date.now()
      this.read(d)
    })
    sock.on('close', () => this.closed())
    sock.on('error', () => this.closed())
  }

  send(text: string) {
    if (this.open) this.sock.write(frame(1, Buffer.from(text)))
  }

  ping() {
    if (!this.open) return
    if (Date.now() - this.heard > DEAD_MS) return this.closed()
    this.sock.write(frame(9, Buffer.alloc(0)))
  }

  closed() {
    if (!this.open) return
    this.open = false
    this.sock.destroy()
    this.onClose()
  }

  read(data: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data
    for (;;) {
      const b = this.buf
      if (b.length < 2) return
      const fin = b[0] & 0x80
      const op = b[0] & 0x0f
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
      if (n > 16 * 1024 * 1024) return this.closed()
      const mo = o
      if (masked) o += 4
      if (b.length < o + n) return
      const payload = Buffer.from(b.subarray(o, o + n))
      if (masked) for (let i = 0; i < n; i++) payload[i] ^= b[mo + (i & 3)]
      this.buf = b.subarray(o + n)

      if (op === 8) return this.closed()
      if (op === 9) this.sock.write(frame(10, payload))
      else if (op === 0 || op === 1 || op === 2) {
        this.parts.push(payload)
        if (fin) {
          const text = Buffer.concat(this.parts).toString('utf8')
          this.parts = []
          this.onMessage(text)
        }
      }
    }
  }
}

// Calls onConnect(socket, url) for every upgrade request whose path matches.
// Other upgrades (such as Vite's HMR socket) are left alone.
export function attachWebSocket(httpServer: HttpServer, path: string, onConnect: (ws: Socket, url: URL) => void) {
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
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const ws: Socket = new Socket(
      sock as NetSocket,
      (text) => ws.handler?.(text),
      () => {
        all.delete(ws)
        ws.onclose?.()
      },
    )
    all.add(ws)
    onConnect(ws, url)
    if (head?.length) ws.read(head)
  })
}
