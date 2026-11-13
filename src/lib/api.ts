import { newBuild } from './update.ts'
import type {
  ClientMessage,
  InvitablePlayer,
  NewRoom,
  PlayerLogin,
  PlayerProfile,
  PlayerRef,
  RoomDetails,
  RoomSummary,
  ServerMessage,
  ServerMessageOf,
  Snapshot,
} from '../../shared/protocol.ts'

// This page's id on room sockets: the server stamps it on what this page sends, so the page can tell
// its own messages from others'.
export const clientId = Math.random().toString(36).slice(2)

// An id for a new note, reply, image, tray or stroke: random enough that pages making them at the
// same time don't clash.
export const newId = () => Math.random().toString(36).slice(2, 10)

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  // Asks as this player (their passphrase), for what only they may see.
  as?: string | null
}

async function request<T>(url: string, { method = 'GET', body, as }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (as) headers['X-Passphrase'] = as
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}
const post = <T>(url: string, body: unknown) => request<T>(url, { method: 'POST', body })

export const api = {
  signUp: (name: string) => post<PlayerLogin>('/api/players', { name }),
  claim: (name: string) => post<PlayerLogin>('/api/players/claim', { name }),
  login: (passphrase: string) => post<PlayerLogin>('/api/players/login', { passphrase }),
  loginEmail: (email: string, password: string) => post<PlayerLogin>('/api/players/email-login', { email, password }),
  useEmail: (passphrase: string, email: string, password: string) => post<PlayerLogin>('/api/players/email', { passphrase, email, password }),
  rename: (passphrase: string, name: string) => post<PlayerRef>('/api/players/rename', { passphrase, name }),
  lan: () => request<{ address: string | null }>('/api/lan'),
  // Private jigsaws only come back for a player who has them.
  rooms: (passphrase?: string | null) => request<RoomSummary[]>('/api/rooms', { as: passphrase }),
  room: (id: string) => request<RoomDetails>(`/api/rooms/${id}`),
  player: (id: string, passphrase?: string | null) => request<PlayerProfile>(`/api/players/${encodeURIComponent(id)}`, { as: passphrase }),
  invitable: (passphrase: string, room = '') =>
    request<InvitablePlayer[]>(`/api/players/invitable?room=${encodeURIComponent(room)}`, { as: passphrase }),
  invite: (id: string, passphrase: string, players: string[]) => post<{ invited: number }>(`/api/rooms/${id}/invite`, { passphrase, players }),
  join: (id: string, passphrase: string) => post<{ ok: true }>(`/api/rooms/${id}/join`, { passphrase }),
  imageUrl: (id: string) => `/api/rooms/${id}/image`,
  snapshots: (id: string) => request<Snapshot[]>(`/api/rooms/${id}/snapshots`),
  create: (body: NewRoom) => post<{ id: string }>('/api/rooms', body),
  // A link preview picture for a jigsaw that has none yet (see src/lib/preview.ts); image: a JPEG data URL.
  // Only taken from the jigsaw's maker (anyone logged in, for a jigsaw without one).
  preview: (id: string, passphrase: string, image: string) => post<{ ok: true }>(`/api/rooms/${id}/preview`, { passphrase, image }),
  remove: (id: string, passphrase: string | undefined) => request<{ ok: true }>(`/api/rooms/${id}`, { method: 'DELETE', body: { passphrase } }),
  // Adds seconds to the time this player spent on a jigsaw. beacon: the page is going away, so it's
  // sent in a way that outlives it.
  time: (id: string, passphrase: string, seconds: number, beacon = false) => {
    const body = JSON.stringify({ client: clientId, passphrase, seconds })
    if (beacon && navigator.sendBeacon) return navigator.sendBeacon(`/api/rooms/${id}/time`, body)
    return fetch(`/api/rooms/${id}/time`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(
      () => {},
    )
  },
}

type Listener<T extends ServerMessage['type']> = (msg: ServerMessageOf<T>) => void

// A room's live channel, from openRoomSocket(). Reconnects on its own; changes sent while it's
// disconnected are queued and sent once it's back, except those that only matter while fresh.
export interface RoomSocket {
  send: (msg: ClientMessage) => void
  // Calls fn with every message of this type from another page; returns a function that stops it.
  on: <T extends ServerMessage['type']>(type: T, fn: Listener<T>) => () => void
  // Tells the room who is logged in now, after a login or logout (each connect does it anyway).
  hello: () => void
  close: () => void
}

const transient = (msg: ClientMessage) => ('live' in msg && msg.live) || msg.type === 'live' || msg.type === 'grab' || msg.type === 'sway' || msg.type === 'cursor'

// passphrase: the login of who is logged in on this page right now, told to the room on every
// connect. onOpen(reconnect) fires on every connect.
export function openRoomSocket(id: string, passphrase: () => string | null, onOpen?: (reconnect: boolean) => void): RoomSocket {
  let ws: WebSocket | null = null
  let dead = false
  let retry = 0
  let timer = 0
  let opened = false
  const queue: ClientMessage[] = []
  const listeners = new Map<string, Set<(msg: ServerMessage) => void>>()
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const hello = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hello', passphrase: passphrase() } satisfies ClientMessage))
  }
  const open = () => {
    ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${id}&client=${clientId}`)
    ws.onopen = () => {
      retry = 0
      hello()
      for (const msg of queue.splice(0)) ws!.send(JSON.stringify(msg))
      onOpen?.(opened)
      opened = true
    }
    ws.onmessage = (e) => {
      const msg: ServerMessage = JSON.parse(e.data)
      if (msg.type === 'build') newBuild(msg.build)
      else if (msg.client !== clientId) for (const fn of listeners.get(msg.type) || []) fn(msg)
    }
    ws.onclose = () => {
      if (dead) return
      timer = setTimeout(open, Math.min(5000, 300 * 2 ** retry++))
    }
  }
  open()
  return {
    hello,
    send: (msg) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
      else if (!transient(msg)) queue.push(msg)
    },
    on: (type, fn) => {
      const set = listeners.get(type) || new Set()
      listeners.set(type, set)
      const f = fn as (msg: ServerMessage) => void
      set.add(f)
      return () => set.delete(f)
    },
    close: () => {
      dead = true
      clearTimeout(timer)
      ws?.close()
    },
  }
}
