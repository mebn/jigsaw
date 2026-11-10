import { newBuild } from './update.ts'
import type { PiecePlacement, PuzzleSpec } from './geometry.ts'

// ---- what the server sends -------------------------------------------------

// A player as everyone sees them.
export interface PlayerRef {
  id: string
  name: string
}

// A player as they log in: for a player with an email, passphrase is this device's login token.
export interface PlayerLogin extends PlayerRef {
  passphrase: string
  email?: string | null
}

// A jigsaw in the list of jigsaws (api.rooms()). private is 0 or 1; n is how many pieces it has,
// groups how many groups they are in now, seconds the time everyone spent on it.
export interface RoomSummary {
  id: string
  name: string
  created: number
  cols: number
  rows: number
  shape: string
  thumb: string
  owner: string | null
  private: number
  n: number
  groups: number
  seconds: number
  // Share of the pieces connected, 0 to 1.
  progress: number
  done: boolean
}

// A jigsaw a player has played (api.player()): pieces is how many they connected, time how long they
// spent on it and seen when they were last in it (ms since epoch, 0 for never).
export interface PlayerRoom {
  id: string
  name: string
  created: number
  thumb: string
  owner: string | null
  private: number
  groups: number
  seconds: number
  seen: number
  n: number
  progress: number
  done: boolean
  pieces: number
  time: number
}

// A player and the jigsaws they have played (api.player()).
export interface PlayerProfile extends PlayerRef {
  created: number
  rooms: PlayerRoom[]
}

// A player who can be invited to a private jigsaw; joined when they already have it.
export interface InvitablePlayer extends PlayerRef {
  joined: boolean
}

// A piece as stored: cell i at (x, y), turned r quarter turns, in group g, last moved by player by,
// f 1 when fixed, in tray t (put there at ta, ms since epoch).
export interface PieceRow {
  i: number
  x: number
  y: number
  r: number
  g: number
  by: string | null
  f: number
  t: string | null
  ta: number
}

// A note on the table.
export interface NoteRow {
  id: string
  x: number
  y: number
  text: string
  // The tray it's stuck to, if any.
  tray: string | null
  author: string
  created: number
}

// The kinds of reaction a note can have.
export type NoteReactionKind = 'up' | 'down' | 'eyes' | 'fire'
// One player's reaction of one kind on a note.
export interface NoteReaction {
  note: string
  player: string
  kind: NoteReactionKind
}
// A reply to a note.
export interface NoteReply {
  id: string
  note: string
  author: string
  text: string
  created: number
}

// A reference image on the table. The trim is the part of the picture that shows, as fractions of it.
export interface RefRow {
  id: string
  x: number
  y: number
  w: number
  opacity: number
  trimX: number
  trimY: number
  trimW: number
  trimH: number
  author: string
  created: number
}

// A tray on the table, x and y its top left corner, with the pieces in it in the order they went in.
export interface TrayRow {
  id: string
  x: number
  y: number
  w: number
  h: number
  name: string
  color: string
  num: number
  auto: boolean
  author: string
  created: number
  pieces: number[]
}

// A tray as relayed while it changes (live): without its pieces, which go with the pieces' moves.
export type TrayUpdate = Omit<TrayRow, 'pieces'> & { pieces?: number[] }

// Notes, reference images and trays as they're sent to be saved: the server fills in what's left
// out (and sets author and created itself when saving).
export type NoteInput = Pick<NoteRow, 'id' | 'x' | 'y'> & Partial<NoteRow>
export type RefInput = Pick<RefRow, 'id' | 'x' | 'y' | 'w'> & Partial<RefRow>
export type TrayInput = Pick<TrayRow, 'id' | 'x' | 'y' | 'w' | 'h'> & Partial<TrayRow>

// How long a player has spent on a jigsaw, in seconds.
export interface TimeRow {
  user: string
  seconds: number
}

// A whole jigsaw (api.room()). annoying, longPieces and private are 0 or 1. seen: when each player
// was last in it (ms since epoch, by player id); online: the ids of players in it now.
export interface RoomDetails {
  id: string
  name: string
  created: number
  cols: number
  rows: number
  shape: string
  seed: number
  width: number
  height: number
  annoying: number
  longPieces: number
  owner: string | null
  private: number
  pieces: PieceRow[]
  notes: NoteRow[]
  noteReactions: NoteReaction[]
  noteReplies: NoteReply[]
  refs: RefRow[]
  trays: TrayRow[]
  times: TimeRow[]
  seen: Record<string, number>
  online: string[]
  players: PlayerRef[]
}

// The biggest group at time t (ms since epoch), size pieces big, its cells a base64 bitset.
export interface Snapshot {
  t: number
  size: number
  pieces: string
}

// What a new jigsaw is made from (api.create()): image and thumb are data URLs; invite: the ids of
// players to invite to a private one.
export interface NewRoom extends PuzzleSpec {
  name: string
  image: string
  thumb: string
  private: boolean
  invite: string[]
  pieces: PiecePlacement[]
  passphrase?: string
  annoying?: boolean
}

// ---- the room socket ---------------------------------------------------------

// A piece where a player put it, as sent in "moves".
export interface PieceMove {
  i: number
  x: number
  y: number
  r: number
  g: number
  by?: string | null
  t?: string | null
}

// A spin around (cx, cy) that took pieces ids to where they are, d quarter turns.
export interface Turn {
  ids: number[]
  cx: number
  cy: number
  d: number
}

// What comes in over a room's socket. client is the sender's client id. Messages from other players'
// pages (grab, live, cursor, marks, moves) are only relayed, so their fields are what those pages
// sent, and are worth checking.
export type RoomMessage =
  | { type: 'player'; client?: string; player: PlayerRef }
  | { type: 'presence'; client?: undefined; online: string[]; seen: Record<string, number> }
  | { type: 'time'; client?: string; user: string; seconds: number }
  | { type: 'note'; client: string; live: boolean; note: NoteRow }
  | { type: 'ref'; client: string; live: boolean; ref: RefRow }
  | { type: 'tray'; client: string; live: boolean; tray: TrayUpdate }
  | { type: 'note-delete'; client: string; id: string }
  | { type: 'note-react'; client: string; id: string; kind: NoteReactionKind; player: string; on: boolean }
  | { type: 'note-reply'; client: string; reply: NoteReply }
  | { type: 'note-reply-delete'; client: string; id: string }
  | { type: 'ref-delete'; client: string; id: string }
  | { type: 'tray-delete'; client: string; id: string }
  | { type: 'react'; client: string; kind: string; x: number; y: number }
  | { type: 'ink'; client: string; id?: unknown; pts?: unknown; end?: unknown }
  | { type: 'deleted'; client?: undefined }
  | { type: 'gone'; client: string }
  | { type: 'moves'; client: string; pieces: PieceMove[]; turns?: Turn[]; fix?: true }
  | { type: 'grab'; client: string; ids: number[]; ox: number[]; oy: number[]; r0: number[]; px: number; py: number; k?: number; tray?: boolean }
  | { type: 'live'; client: string; px: number; py: number; k?: number }
  | { type: 'cursor'; client: string; hide?: boolean; x?: number; y?: number; name?: string; player?: string; box?: number[] }
  | { type: 'marks'; client: string; sel?: number[]; hl?: number[]; refs?: string[]; notes?: string[]; tray?: string | null; player?: string }

// The build the server serves (see update.ts); handled here, never passed on.
type BuildMessage = { type: 'build'; build: string; client?: undefined }

// Anything sent over a room's socket. live=true marks a drag in progress, which isn't queued while
// offline.
export interface OutgoingMessage {
  type: string
  live?: unknown
}

export interface SocketOptions {
  // The logged in player's id, if any.
  player?: () => string | null | undefined
  onMessage: (msg: RoomMessage) => void
  onOpen?: (reconnect: boolean) => void
}

// An open room socket (see api.socket()).
export interface RoomSocket {
  send: <M extends OutgoingMessage>(msg: M) => void
  close: () => void
}

export const clientId = Math.random().toString(36).slice(2)

// Open room sockets, by room id.
const sockets = new Map<string, RoomSocket>()
// Messages that only matter while they're fresh; everything else is queued while offline.
const transient = (msg: OutgoingMessage) => msg.live || msg.type === 'live' || msg.type === 'grab' || msg.type === 'cursor'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

const post = <T>(url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json<T>)

export const api = {
  // Players: each resolves with { id, name, passphrase }.
  signUp: (name: string) => post<PlayerLogin>('/api/players', { name }),
  claim: (name: string) => post<PlayerLogin>('/api/players/claim', { name }),
  login: (passphrase: string) => post<PlayerLogin>('/api/players/login', { passphrase }),
  // With an email, the player's passphrase field holds this device's login token instead.
  loginEmail: (email: string, password: string) => post<PlayerLogin>('/api/players/email-login', { email, password }),
  useEmail: (passphrase: string, email: string, password: string) => post<PlayerLogin>('/api/players/email', { passphrase, email, password }),
  rename: (passphrase: string, name: string) => post<PlayerRef>('/api/players/rename', { passphrase, name }),
  lan: () => fetch('/api/lan').then(json<{ address: string | null }>),
  // Private jigsaws are only listed for the player who opened them, known by their passphrase.
  rooms: (passphrase?: string | null) => fetch('/api/rooms', { headers: passphrase ? { 'X-Passphrase': passphrase } : {} }).then(json<RoomSummary[]>),
  room: (id: string) => fetch(`/api/rooms/${id}`).then(json<RoomDetails>),
  // A player and the jigsaws they have played: { id, name, created, rooms }. Private ones only come
  // back when this player (known by their passphrase) has them too.
  player: (id: string, passphrase?: string | null) =>
    fetch(`/api/players/${encodeURIComponent(id)}`, { headers: passphrase ? { 'X-Passphrase': passphrase } : {} }).then(json<PlayerProfile>),
  // Players with an email who can be invited to a private jigsaw, as [{ id, name, joined }].
  invitable: (passphrase: string, room = '') =>
    fetch(`/api/players/invitable?room=${encodeURIComponent(room)}`, { headers: { 'X-Passphrase': passphrase } }).then(
      json<InvitablePlayer[]>,
    ),
  invite: (id: string, passphrase: string, players: string[]) => post<{ invited: number }>(`/api/rooms/${id}/invite`, { passphrase, players }),
  join: (id: string, passphrase: string) => post<{ ok: true }>(`/api/rooms/${id}/join`, { passphrase }),
  imageUrl: (id: string) => `/api/rooms/${id}/image`,
  // The biggest group each time it grew, for the timelapse: [{ t, size, pieces }] (see timelapse.ts).
  snapshots: (id: string) => fetch(`/api/rooms/${id}/snapshots`).then(json<Snapshot[]>),
  create: (body: NewRoom) =>
    fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<{ id: string }>),
  remove: (id: string, passphrase: string | undefined) =>
    fetch(`/api/rooms/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    }).then(json<{ ok: true }>),
  time: (id: string, user: string, seconds: number, beacon = false) => {
    const body = JSON.stringify({ client: clientId, user, seconds })
    if (beacon && navigator.sendBeacon) return navigator.sendBeacon(`/api/rooms/${id}/time`, body)
    return fetch(`/api/rooms/${id}/time`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  },
  // Notes, reference images and trays go over the room socket; live=true is a drag in progress (not saved).
  saveNote: (id: string, note: NoteInput, live = false) => sockets.get(id)?.send({ type: 'note', live, note }),
  deleteNote: (id: string, noteId: string) => sockets.get(id)?.send({ type: 'note-delete', id: noteId }),
  // Puts the player's reaction of this kind on a note, or takes it off.
  reactNote: (id: string, noteId: string, kind: NoteReactionKind, on: boolean) => sockets.get(id)?.send({ type: 'note-react', id: noteId, kind, on }),
  // A reply to a note ({ id, note, text }), and taking one of the player's own replies back.
  replyNote: (id: string, reply: Pick<NoteReply, 'id' | 'note' | 'text'>) => sockets.get(id)?.send({ type: 'note-reply', ...reply }),
  deleteReply: (id: string, replyId: string) => sockets.get(id)?.send({ type: 'note-reply-delete', id: replyId }),
  saveRef: (id: string, ref: RefInput, live = false) => sockets.get(id)?.send({ type: 'ref', live, ref }),
  deleteRef: (id: string, refId: string) => sockets.get(id)?.send({ type: 'ref-delete', id: refId }),
  saveTray: (id: string, tray: TrayInput, live = false) => sockets.get(id)?.send({ type: 'tray', live, tray }),
  deleteTray: (id: string, trayId: string) => sockets.get(id)?.send({ type: 'tray-delete', id: trayId }),
  // Live room channel. Reconnects on its own; onOpen(reconnect) fires on every connect.
  // Changes made while disconnected are queued and sent once the socket is back.
  socket: (id: string, { player, onMessage, onOpen }: SocketOptions): RoomSocket => {
    let ws: WebSocket | null = null
    let dead = false
    let retry = 0
    let timer = 0
    let opened = false
    const queue: OutgoingMessage[] = []
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const open = () => {
      const who = player?.() ? `&player=${player()}` : ''
      ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${id}&client=${clientId}${who}`)
      ws.onopen = () => {
        retry = 0
        for (const msg of queue.splice(0)) ws!.send(JSON.stringify(msg))
        onOpen?.(opened)
        opened = true
      }
      ws.onmessage = (e) => {
        const msg: RoomMessage | BuildMessage = JSON.parse(e.data)
        if (msg.type === 'build') newBuild(msg.build)
        else if (msg.client !== clientId) onMessage(msg)
      }
      ws.onclose = () => {
        if (dead) return
        timer = setTimeout(open, Math.min(5000, 300 * 2 ** retry++))
      }
    }
    open()
    const handle: RoomSocket = {
      send: (msg) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
        else if (!transient(msg)) queue.push(msg)
      },
      close: () => {
        dead = true
        clearTimeout(timer)
        ws?.close()
        if (sockets.get(id) === handle) sockets.delete(id)
      },
    }
    sockets.set(id, handle)
    return handle
  },
}
