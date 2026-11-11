// What the server and the pages say to each other: the rows the HTTP API returns, the messages on a
// room's socket, and the limits both sides hold them to. Used by both src/ and server/, so it must
// not touch the DOM or Node.

// ---- limits -------------------------------------------------------------------

export const LIMITS = {
  name: 32,
  email: 254,
  password: 8,
  roomName: 80,
  // Ids of notes, images and trays, and the tray a piece is in.
  id: 40,
  text: 2000,
  trayName: 40,
  trayColor: 16,
  // The highest tray number (trays can be numbered 1 to 9 for the keys).
  trayNum: 9,
  // An image's opacity, and how little of the picture a trimmed image can show.
  minOpacity: 0.1,
  minTrim: 0.01,
  // Numbers in one ink message, and in one whole stroke.
  inkPoints: 2000,
  strokePoints: 20000,
  inkId: 16,
} as const

// Error messages the pages act on, not just show.
export const ERRORS = {
  unknownPassphrase: 'unknown passphrase',
  nameTaken: 'taken',
} as const

export const NOTE_REACTIONS = ['up', 'down', 'eyes', 'fire'] as const
export type NoteReactionKind = (typeof NOTE_REACTIONS)[number]
export const isNoteReaction = (k: unknown): k is NoteReactionKind => NOTE_REACTIONS.includes(k as NoteReactionKind)

// ---- what the HTTP API returns ---------------------------------------------------

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

// What a jigsaw is cut from: its grid, the picture's size, the shape of its pieces and its seed.
// longPieces is a boolean, or 0/1 as the server stores it.
export interface PuzzleSpec {
  cols: number
  rows: number
  width: number
  height: number
  shape: string
  seed: number
  longPieces?: boolean | number
}

// A jigsaw in the list of jigsaws. private is 0 or 1; n is how many pieces it has, groups how many
// groups they are in now, seconds the time everyone spent on it.
export interface RoomSummary {
  id: string
  name: string
  created: number
  cols: number
  rows: number
  shape: string
  seed: number
  width: number
  height: number
  longPieces: number
  thumb: string
  owner: string | null
  private: number
  n: number
  groups: number
  seconds: number
  // Share of the pieces connected, 0 to 1.
  progress: number
  done: boolean
  // When it was finished (ms since epoch), or 0 when not known.
  finished: number
}

// A jigsaw a player has played: pieces is how many they connected, time how long they spent on it and
// seen when they were last in it (ms since epoch, 0 for never).
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

export interface PlayerProfile extends PlayerRef {
  created: number
  rooms: PlayerRoom[]
}

// A player who can be invited to a private jigsaw; joined when they already have it.
export interface InvitablePlayer extends PlayerRef {
  joined: boolean
}

// A piece as stored: cell i at (x, y), turned r quarter turns, in group g, last moved by player by,
// in tray t (put there at ta, ms since epoch).
export interface PieceRow {
  i: number
  x: number
  y: number
  r: number
  g: number
  by: string | null
  t: string | null
  ta: number
}

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

// One player's reaction of one kind on a note.
export interface NoteReaction {
  note: string
  player: string
  kind: NoteReactionKind
}

export interface NoteReply {
  id: string
  note: string
  author: string
  text: string
  created: number
}

// A reference image on the table, (x, y) its centre and w its width. The trim is the part of the
// picture that shows, as fractions of it.
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

// Notes, reference images and trays as they're sent to be saved: the server fills in what's left
// out (and sets author and created itself when saving). A tray's pieces go with the pieces' moves.
export type NoteInput = Pick<NoteRow, 'id' | 'x' | 'y'> & Partial<NoteRow>
export type RefInput = Pick<RefRow, 'id' | 'x' | 'y' | 'w'> & Partial<RefRow>
export type TrayInput = Pick<TrayRow, 'id' | 'x' | 'y' | 'w' | 'h'> & Partial<TrayRow>

// How long a player has spent on a jigsaw, in seconds.
export interface TimeRow {
  user: string
  seconds: number
}

// A whole jigsaw. longPieces and private are 0 or 1. seen: when each player was last in it (ms since
// epoch, by player id); online: the ids of players in it now.
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
  longPieces: number
  owner: string | null
  private: number
  // Whether it has its link preview picture yet (1) or not (0), see src/lib/preview.ts.
  preview: number
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

// Where a piece starts out: cell i at (x, y), turned r quarter turns, in group g.
export interface PiecePlacement {
  i: number
  x: number
  y: number
  r: number
  g: number
}

// The size of a jigsaw's link preview picture (see src/lib/preview.ts), the size link previews are made for.
export const PREVIEW_W = 1200
export const PREVIEW_H = 630

// What a new jigsaw is made from: image, thumb and preview (its link preview picture) are data
// URLs; invite: the ids of players to invite to a private one.
export interface NewRoom extends PuzzleSpec {
  name: string
  image: string
  thumb: string
  preview?: string
  private: boolean
  invite: string[]
  pieces: PiecePlacement[]
  passphrase?: string
}

// ---- the room socket -------------------------------------------------------------

// A piece where a player put it, as sent in "moves". t: the tray it's in (null: none).
export interface PieceMove {
  i: number
  x: number
  y: number
  r: number
  g: number
  by?: string | null
  t?: string | null
  ta?: number
}

// A spin around (cx, cy) that took pieces ids to where they are, d quarter turns.
export interface Spin {
  ids: number[]
  cx: number
  cy: number
  d: number
}

// What a page sends over its room's socket. live=true marks a change in progress (a drag), only
// relayed, never saved, and not queued while offline.
export type ClientMessage =
  // Who is logged in on the page: sent on every connect, and again when that changes.
  | { type: 'hello'; passphrase: string | null }
  | { type: 'grab'; ids: number[]; ox: number[]; oy: number[]; r0: number[]; px: number; py: number; k?: number; tray?: boolean }
  | { type: 'live'; px: number; py: number; k: number }
  // How what the page holds swings (radians, around (px, py)): its pieces, and images, notes and trays
  // by kind and id ('tray:abc'). a: 0 once it's straight again.
  | { type: 'sway'; a: number; px?: number; py?: number; pieces?: true; objs?: string[] }
  | { type: 'moves'; pieces: PieceMove[]; turns?: Spin[]; fix?: boolean }
  | { type: 'marks'; sel: number[]; hl: number[]; refs: string[]; notes: string[]; tray: string | null; player: string }
  | { type: 'cursor'; hide: true }
  | { type: 'cursor'; x: number; y: number; name: string; player: string; box?: number[] }
  | { type: 'react'; x: number; y: number }
  | { type: 'ink'; id: string; pts: number[]; end?: boolean }
  | { type: 'note'; live: boolean; note: NoteInput }
  | { type: 'note-delete'; id: string }
  | { type: 'note-react'; id: string; kind: NoteReactionKind; on: boolean }
  | { type: 'note-reply'; id: string; note: string; text: string }
  | { type: 'note-reply-delete'; id: string }
  | { type: 'ref'; live: boolean; ref: RefInput }
  | { type: 'ref-delete'; id: string }
  | { type: 'tray'; live: boolean; tray: TrayInput }
  | { type: 'tray-delete'; id: string }

// Messages from other pages that the server only relays (grab, live, sway, cursor, marks and parts of
// moves) carry whatever those pages sent: anything typed unknown or optional here may be missing or
// wrong, and is checked where it's used.
// What comes in over a room's socket. client is the sending page's client id.
export type ServerMessage =
  | { type: 'build'; build: string; client?: undefined }
  | { type: 'player'; client?: string; player: PlayerRef }
  | { type: 'presence'; client?: undefined; online: string[]; seen: Record<string, number> }
  | { type: 'time'; client?: string; user: string; seconds: number }
  | { type: 'deleted'; client?: undefined }
  | { type: 'gone'; client: string }
  | { type: 'note'; client: string; live: boolean; note: NoteRow }
  | { type: 'note-delete'; client: string; id: string }
  | { type: 'note-react'; client: string; id: string; kind: NoteReactionKind; player: string; on: boolean }
  | { type: 'note-reply'; client: string; reply: NoteReply }
  | { type: 'note-reply-delete'; client: string; id: string }
  | { type: 'ref'; client: string; live: boolean; ref: RefRow }
  | { type: 'ref-delete'; client: string; id: string }
  | { type: 'tray'; client: string; live: boolean; tray: TrayInput }
  | { type: 'tray-delete'; client: string; id: string }
  | { type: 'react'; client: string; x: number; y: number }
  | { type: 'ink'; client: string; id?: unknown; pts?: unknown; end?: unknown }
  | { type: 'moves'; client: string; pieces?: PieceMove[]; turns?: unknown; fix?: boolean }
  | { type: 'grab'; client: string; ids?: number[]; ox?: number[]; oy?: number[]; r0?: number[]; px: number; py: number; k?: number; tray?: boolean }
  | { type: 'live'; client: string; px: number; py: number; k?: number }
  | { type: 'sway'; client: string; a?: unknown; px?: unknown; py?: unknown; pieces?: unknown; objs?: unknown }
  | { type: 'marks'; client: string; sel?: unknown; hl?: unknown; refs?: unknown; notes?: unknown; tray?: unknown; player?: unknown }
  | { type: 'cursor'; client: string; hide?: boolean; x?: number; y?: number; name?: unknown; box?: unknown; player?: unknown }

export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>
