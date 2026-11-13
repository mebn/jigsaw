// Vite plugin that serves the app's JSON and WebSocket API, backed by SQLite (node:sqlite). It runs
// inside the Vite dev or preview server, so no separate backend process is needed.
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite'
import { openDb } from './db.ts'
import { send } from './http.ts'
import type { Reply } from './http.ts'
import { createHub } from './hub.ts'
import type { RoomSocket } from './hub.ts'
import { createMailer } from './mail.ts'
import { roomPage } from './meta.ts'
import { createPlayers } from './players.ts'
import { createRooms } from './rooms.ts'
import { createTable } from './table.ts'
import { attachWebSocket } from './ws.ts'
import type { Socket } from './ws.ts'

// The machine's first network address, so a phone on the same network can open the app.
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}

function createApi(dbFile: string) {
  const db = openDb(dbFile)
  const hub = createHub(db)
  const players = createPlayers(db, hub)
  const table = createTable(db, hub, players)
  const rooms = createRooms(db, hub, players, table, createMailer())
  // The script the built page loads (it's named after its contents), or null while developing.
  let build: string | null = null

  async function route(req: Connect.IncomingMessage, path: string[], query: URLSearchParams): Promise<Reply> {
    const [area, id, action] = path
    const get = req.method === 'GET'
    if (area === 'lan' && get) return [200, { address: lanAddress() }]
    if (area === 'players') {
      if (id === 'invitable' && get) return rooms.invitable(req, query.get('room') || '')
      if (id && get) return rooms.profile(req, id)
      if (req.method === 'POST' && !action) return players.route(req, id)
    }
    if (area === 'rooms') return id ? rooms.room(req, id, action) : rooms.rooms(req)
  }

  // One socket per open room, from api.ts in the page.
  function connect(socket: Socket, url: URL, ip: string) {
    const roomId = url.searchParams.get('room') || ''
    if (!rooms.exists(roomId)) return socket.closed()
    const ws: RoomSocket = Object.assign(socket, { client: url.searchParams.get('client') || '', ip, player: null })
    hub.join(roomId, ws)
    // Which build is being served, so a page still running an older one can reload (see src/lib/update.ts).
    if (build) ws.send(JSON.stringify({ type: 'build', build }))
    ws.onMessage = (text) => {
      let msg: unknown
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      try {
        table.handle(roomId, ws, msg as Record<string, unknown>)
      } catch (e) {
        console.error('room socket:', e)
      }
    }
  }

  async function middleware(req: Connect.IncomingMessage, res: import('node:http').ServerResponse, next: Connect.NextFunction) {
    const url = new URL(req.url!, 'http://x')
    if (!url.pathname.startsWith('/api/')) return next()
    try {
      send(res, await route(req, url.pathname.slice(5).split('/').filter(Boolean), url.searchParams))
    } catch (e) {
      send(res, [500, { error: String((e as Error).message || e) }])
    }
  }

  // The page for url (index.html): a jigsaw's link gets that jigsaw's link preview tags.
  function page(url: string, html: string) {
    try {
      const id = /^\/r\/([^/?#]+)/.exec(new URL(url, 'http://x').pathname)?.[1]
      const room = id ? rooms.sharing(decodeURIComponent(id)) : null
      return room ? roomPage(html, room) : html
    } catch {
      // A malformed address: the site's own tags.
      return html
    }
  }

  return { middleware, connect, page, setBuild: (b: string | null) => (build = b) }
}

export default function sqliteApi(options: { file?: string } = {}): Plugin {
  const file = resolve(options.file || 'data/puzzle.db')
  let api: ReturnType<typeof createApi> | undefined
  const mount = (server: ViteDevServer | PreviewServer) => {
    api ??= createApi(file)
    server.middlewares.use(api.middleware)
    if (server.httpServer) attachWebSocket(server.httpServer, '/api/ws', api.connect)
  }
  return {
    name: 'sqlite-api',
    configureServer: mount,
    configurePreviewServer: (server) => {
      mount(server)
      // A preview serves a build: pages learn which one, see connect().
      const html = readFileSync(resolve(server.config.root, server.config.build.outDir, 'index.html'), 'utf8')
      api!.setBuild(/<script type="module"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1] || null)
      // A jigsaw's page, with its link preview tags (while developing, see transformIndexHtml).
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' || !req.url?.startsWith('/r/')) return next()
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(api!.page(req.url, html))
      })
    },
    // While developing, the page Vite serves for a jigsaw's link gets its link preview tags. A build
    // has no api: the built index.html keeps the site's own.
    transformIndexHtml: (html, ctx) => (api && ctx.originalUrl ? api.page(ctx.originalUrl, html) : html),
  }
}
