import { newBuild } from './update.ts'
import { decode, encode } from '../../shared/wire.ts'
import type {
  ClientMessage,
  DeviceInfo,
  NewRoom,
  PlayerLogin,
  PlayerProfile,
  PlayerRef,
  RoomDetails,
  PlayerStats,
  RoomListKind,
  RoomPage,
  RoomSort,
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

// A body that's a picture (Blob) or a form with pictures in it (FormData) goes as it is, with the
// type the browser gives it; anything else as JSON.
async function request<T>(url: string, { method = 'GET', body, as }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const raw = body instanceof Blob || body instanceof FormData
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json'
  if (as) headers['X-Passphrase'] = as
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}
const post = <T>(url: string, body: unknown) => request<T>(url, { method: 'POST', body })

// A picture given as a base64 data URL, as a Blob of its type, to send as the picture itself.
export function dataUrlBlob(url: string) {
  const type = /^data:([^;,]+)/.exec(url)?.[1] || 'application/octet-stream'
  const text = atob(url.slice(url.indexOf(',') + 1))
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return new Blob([bytes], { type })
}

// A new jigsaw's pictures: the picture itself, its thumbnail and its link preview picture.
export interface NewRoomPictures {
  image: Blob
  thumb: Blob
  preview?: Blob
}

// This browser, sent along when signing up or logging in.
async function device(): Promise<DeviceInfo> {
  let storage: DeviceInfo['storage'] = 'ok'
  try {
    localStorage.setItem('storageCheck', '1')
    localStorage.removeItem('storageCheck')
    if (await navigator.storage?.persisted?.()) storage = 'persisted'
  } catch {
    storage = 'blocked'
  }
  return { storage, screen: `${screen.width}x${screen.height}@${+devicePixelRatio.toFixed(2)}`, webgpu: 'gpu' in navigator }
}
const postWithDevice = async <T>(url: string, body: object) => post<T>(url, { ...body, device: await device() })

export const api = {
  signUp: (name: string) => postWithDevice<PlayerLogin>('/api/players', { name }),
  claim: (name: string) => postWithDevice<PlayerLogin>('/api/players/claim', { name }),
  login: (passphrase: string) => postWithDevice<PlayerLogin>('/api/players/login', { passphrase }),
  loginEmail: (email: string, password: string) => postWithDevice<PlayerLogin>('/api/players/email-login', { email, password }),
  useEmail: (passphrase: string, email: string, password: string) =>
    postWithDevice<PlayerLogin>('/api/players/email', { passphrase, email, password }),
  rename: (passphrase: string, name: string) => post<PlayerRef>('/api/players/rename', { passphrase, name }),
  // image: a data URL from avatarFromFile (see src/lib/avatars.ts), or null to take it away. Sent as
  // the picture itself (nothing, to take it away).
  setAvatar: (passphrase: string, image: string | null) =>
    request<PlayerRef>('/api/players/avatar', { method: 'POST', body: image ? dataUrlBlob(image) : undefined, as: passphrase }),
  feedback: (text: string, passphrase?: string | null, room?: string | null) => post<{ ok: true }>('/api/feedback', { text, passphrase, room }),
  lan: () => request<{ address: string | null }>('/api/lan'),
  // A page of one of the lists the jigsaws page shows, from start.
  list: (kind: RoomListKind, o: { sort?: RoomSort; start?: number }, passphrase?: string | null) => {
    const params = new URLSearchParams({ kind, start: String(o.start || 0) })
    if (o.sort) params.set('sort', o.sort)
    return request<RoomPage>(`/api/rooms/list?${params}`, { as: passphrase })
  },
  stats: (id: string) => request<PlayerStats>(`/api/players/${encodeURIComponent(id)}/stats`),
  room: (id: string) => request<RoomDetails>(`/api/rooms/${id}`),
  player: (id: string, passphrase?: string | null) => request<PlayerProfile>(`/api/players/${encodeURIComponent(id)}`, { as: passphrase }),
  join: (id: string, passphrase: string) => post<{ ok: true }>(`/api/rooms/${id}/join`, { passphrase }),
  imageUrl: (id: string) => `/api/rooms/${id}/image`,
  snapshots: (id: string) => request<Snapshot[]>(`/api/rooms/${id}/snapshots`),
  // The pictures go as files, the rest as JSON beside them, so a big picture isn't made into text.
  create: (room: NewRoom, pictures: NewRoomPictures) => {
    const form = new FormData()
    form.append('room', JSON.stringify(room))
    form.append('image', pictures.image)
    form.append('thumb', pictures.thumb)
    if (pictures.preview) form.append('preview', pictures.preview)
    return post<{ id: string }>('/api/rooms', form)
  },
  // A link preview picture for a jigsaw that has none yet (see src/lib/preview.ts); image: a JPEG data URL,
  // sent as the picture itself. Only taken from the jigsaw's maker (anyone logged in, for a jigsaw without one).
  preview: (id: string, passphrase: string, image: string) =>
    request<{ ok: true }>(`/api/rooms/${id}/preview`, { method: 'POST', body: dataUrlBlob(image), as: passphrase }),
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

const transient = (msg: ClientMessage) => ('live' in msg && msg.live) || msg.type === 'live' || msg.type === 'grab' || msg.type === 'sway' || msg.type === 'cursor' || msg.type === 'clock'

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
  // As protobuf (see shared/wire.ts). A message that can't go is a bug, and left out.
  const put = (msg: ClientMessage) => {
    try {
      ws!.send(encode(msg))
    } catch (e) {
      console.error(e)
    }
  }
  const hello = () => {
    if (ws?.readyState === WebSocket.OPEN) put({ type: 'hello', passphrase: passphrase() })
  }
  const open = () => {
    ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${id}&client=${clientId}`)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      retry = 0
      hello()
      for (const msg of queue.splice(0)) put(msg)
      onOpen?.(opened)
      opened = true
    }
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data === 'string') return
      const msg = decode(new Uint8Array(e.data)) as ServerMessage | null
      if (!msg) return
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
      if (ws?.readyState === WebSocket.OPEN) put(msg)
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
