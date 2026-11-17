// How messages go over a room's socket: as protobuf, in binary frames, both ways. Used by src/,
// server/ and cli/, so it must not touch the DOM or Node.
//
// The messages are written and read here from SCHEMA by a small writer and reader of the protobuf wire
// format, rather than by generated code: there's no build step, the types stay those of
// shared/protocol.ts, and the page doesn't carry a protobuf library (protobufjs's smallest build, with
// the Long it pulls in, would add about 13 kB gzipped; all of this is under 3). As a .proto:
//
//   message Envelope {
//     optional string client = 1;   // the sending page, on what the server sends
//     oneof body { Cursor cursor = 2; Live live = 3; Grab grab = 4; Sway sway = 5; Moves moves = 6;
//                  Marks marks = 7; Ink ink = 8; Gone gone = 9; RefMsg ref = 10; TrayMsg tray = 11;
//                  NoteMsg note = 12; React react = 13; Clock clock = 14; Hello hello = 15;
//                  Build build = 16; Player player = 17; Presence presence = 18; Time time = 19;
//                  Score score = 20; Deleted deleted = 21; NoteDelete note_delete = 22;
//                  NoteReact note_react = 23; NoteReply note_reply = 24;
//                  NoteReplyDelete note_reply_delete = 25; RefDelete ref_delete = 26;
//                  TrayDelete tray_delete = 27; }
//   }
//   message Live { optional sint32 px = 1; optional sint32 py = 2; optional sint32 k = 3;
//                  repeated uint32 empty = 14; repeated uint32 nulls = 15; }
//   ... and so on, field for field as in SCHEMA: 'centi', 'milli' and 'int' are sint32, 'uint' uint32,
//   'f64' double, 'str' string, the plural ones repeated (numbers packed), { one } a message, { many }
//   a repeated one, { oneOf } a uint32 index into its list of strings, and 'map' a
//   map<string, double> (repeated { string key = 1; double value = 2; }).
//
// Every message has `repeated uint32 empty = 14` and `repeated uint32 nulls = 15`: its lists (and
// maps) that are empty and its fields that are null, rather than left out, so a message comes out as
// it went in. 'centi' fields are world positions the pages round to hundredths anyway (r2() in
// engine.ts), sent as sint32 hundredths; 'milli' the same in thousandths (a sway's angle, r3()).
// Positions that are kept (moves, notes, images, trays) and times go as doubles, exactly.
//
// encode() throws on a message it can't send as it is (a value of the wrong kind for its field, or a
// type it doesn't know); fields it doesn't know are left out. decode() gives null for anything that
// isn't a whole message of a known type.
// Protobuf: the stream of pointer and drag messages is about 40% the size of JSON's (compression doesn't
// shrink such small messages), big grabs and drops are 20-25% smaller than JSON's even once both are
// compressed, and they take about as long to make and read.

import type { ClientMessage, ServerMessage } from './protocol.ts'
import { NOTE_REACTIONS } from './protocol.ts'

type Loose = Record<string, unknown>
type Kind =
  | 'centi'
  | 'milli'
  | 'f64'
  | 'int'
  | 'uint'
  | 'bool'
  | 'str'
  | 'centis'
  | 'ints'
  | 'uints'
  | 'strs'
  | 'map'
  | { one: Schema }
  | { many: Schema }
  | { oneOf: readonly string[] }
type Schema = [number, string, Kind][]

// In every message: the fields that are null rather than left out (15), and the lists that are empty
// rather than left out (14).
const NULLS = 15
const EMPTY = 14
const SPIN: Schema = [
  [1, 'ids', 'uints'],
  [2, 'cx', 'f64'],
  [3, 'cy', 'f64'],
  [4, 'd', 'int'],
]
const PIECE: Schema = [
  [1, 'i', 'uint'],
  [2, 'x', 'f64'],
  [3, 'y', 'f64'],
  [4, 'r', 'int'],
  [5, 'g', 'int'],
  [6, 'by', 'str'],
  [7, 't', 'str'],
  [8, 'ta', 'f64'],
]
const REF: Schema = [
  [1, 'id', 'str'],
  [2, 'x', 'f64'],
  [3, 'y', 'f64'],
  [4, 'w', 'f64'],
  [5, 'opacity', 'f64'],
  [6, 'trimX', 'f64'],
  [7, 'trimY', 'f64'],
  [8, 'trimW', 'f64'],
  [9, 'trimH', 'f64'],
  [10, 'author', 'str'],
  [11, 'created', 'f64'],
]
const TRAY: Schema = [
  [1, 'id', 'str'],
  [2, 'x', 'f64'],
  [3, 'y', 'f64'],
  [4, 'w', 'f64'],
  [5, 'h', 'f64'],
  [6, 'name', 'str'],
  [7, 'color', 'str'],
  [8, 'num', 'int'],
  [9, 'auto', 'bool'],
  [10, 'author', 'str'],
  [11, 'created', 'f64'],
  [12, 'pieces', 'uints'],
]
const NOTE: Schema = [
  [1, 'id', 'str'],
  [2, 'x', 'f64'],
  [3, 'y', 'f64'],
  [4, 'text', 'str'],
  [5, 'tray', 'str'],
  [6, 'author', 'str'],
  [7, 'created', 'f64'],
]
const REPLY: Schema = [
  [1, 'id', 'str'],
  [2, 'note', 'str'],
  [3, 'author', 'str'],
  [4, 'text', 'str'],
  [5, 'created', 'f64'],
]
const PLAYER: Schema = [
  [1, 'id', 'str'],
  [2, 'name', 'str'],
  [3, 'avatar', 'f64'],
]
const ID: Schema = [[1, 'id', 'str']]

// Each message's field in the envelope, and its fields. Both ways use the same ones: what only one
// side sends (the server's player and name on a pointer, a page's text on a reply) is simply left out
// by the other.
const SCHEMA: Record<ClientMessage['type'] | ServerMessage['type'], [number, Schema]> = {
  cursor: [
    2,
    [
      [1, 'x', 'centi'],
      [2, 'y', 'centi'],
      [3, 'name', 'str'],
      [4, 'player', 'str'],
      [5, 'box', 'centis'],
      [6, 'hide', 'bool'],
    ],
  ],
  live: [
    3,
    [
      [1, 'px', 'centi'],
      [2, 'py', 'centi'],
      [3, 'k', 'int'],
    ],
  ],
  grab: [
    4,
    [
      [1, 'ids', 'uints'],
      [2, 'ox', 'centis'],
      [3, 'oy', 'centis'],
      [4, 'r0', 'ints'],
      [5, 'px', 'centi'],
      [6, 'py', 'centi'],
      [7, 'k', 'int'],
      [8, 'tray', 'bool'],
    ],
  ],
  sway: [
    5,
    [
      [1, 'a', 'milli'],
      [2, 'px', 'centi'],
      [3, 'py', 'centi'],
      [4, 'pieces', 'bool'],
      [5, 'objs', 'strs'],
    ],
  ],
  moves: [
    6,
    [
      [1, 'pieces', { many: PIECE }],
      [2, 'turns', { many: SPIN }],
      [3, 'fix', 'bool'],
    ],
  ],
  marks: [
    7,
    [
      [1, 'sel', 'uints'],
      [2, 'hl', 'uints'],
      [3, 'refs', 'strs'],
      [4, 'notes', 'strs'],
      [5, 'tray', 'str'],
      [6, 'player', 'str'],
    ],
  ],
  ink: [
    8,
    [
      [1, 'id', 'str'],
      [2, 'pts', 'centis'],
      [3, 'end', 'bool'],
    ],
  ],
  gone: [9, []],
  ref: [
    10,
    [
      [1, 'live', 'bool'],
      [2, 'ref', { one: REF }],
    ],
  ],
  tray: [
    11,
    [
      [1, 'live', 'bool'],
      [2, 'tray', { one: TRAY }],
    ],
  ],
  note: [
    12,
    [
      [1, 'live', 'bool'],
      [2, 'note', { one: NOTE }],
    ],
  ],
  react: [
    13,
    [
      [1, 'x', 'f64'],
      [2, 'y', 'f64'],
    ],
  ],
  clock: [
    14,
    [
      [1, 'seconds', 'f64'],
      [2, 'on', 'bool'],
      [3, 'player', 'str'],
    ],
  ],
  hello: [15, [[1, 'passphrase', 'str']]],
  build: [16, [[1, 'build', 'str']]],
  player: [17, [[1, 'player', { one: PLAYER }]]],
  presence: [
    18,
    [
      [1, 'online', 'strs'],
      [2, 'seen', 'map'],
    ],
  ],
  time: [
    19,
    [
      [1, 'user', 'str'],
      [2, 'seconds', 'f64'],
    ],
  ],
  score: [
    20,
    [
      [1, 'player', 'str'],
      [2, 'n', 'int'],
    ],
  ],
  deleted: [21, []],
  'note-delete': [22, ID],
  'note-react': [
    23,
    [
      [1, 'id', 'str'],
      [2, 'kind', { oneOf: NOTE_REACTIONS }],
      [3, 'on', 'bool'],
      [4, 'player', 'str'],
    ],
  ],
  'note-reply': [
    24,
    [
      [1, 'id', 'str'],
      [2, 'note', 'str'],
      [3, 'text', 'str'],
      [4, 'reply', { one: REPLY }],
    ],
  ],
  'note-reply-delete': [25, ID],
  'ref-delete': [26, ID],
  'tray-delete': [27, ID],
}
// ---- the protobuf wire format ----------------------------------------------------

// Protobuf wire types.
const VARINT = 0
const I64 = 1
const LEN = 2
const I32 = 5

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

// Writes protobuf's varints, zigzag varints, doubles and length-delimited strings and
// messages into a buffer that grows as needed. fork() starts a length-delimited part, ldelim() puts
// its length in front of it.
class Writer {
  private buf = new Uint8Array(256)
  private view = new DataView(this.buf.buffer)
  private pos = 0
  private forks: number[] = []

  private room(n: number) {
    if (this.pos + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n))
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
    this.view = new DataView(next.buffer)
  }
  uint32(v: number) {
    this.room(5)
    v >>>= 0
    while (v > 0x7f) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80
      v >>>= 7
    }
    this.buf[this.pos++] = v
    return this
  }
  sint32(v: number) {
    return this.uint32((v << 1) ^ (v >> 31))
  }
  bool(v: boolean) {
    return this.uint32(v ? 1 : 0)
  }
  double(v: number) {
    this.room(8)
    this.view.setFloat64(this.pos, v, true)
    this.pos += 8
    return this
  }
  string(v: string) {
    // At most 3 bytes a UTF-16 unit, and the length in front.
    this.room(v.length * 3 + 5)
    const start = this.pos
    this.pos += 1
    const n = utf8.encodeInto(v, this.buf.subarray(this.pos)).written
    this.pos += n
    this.prefix(start, n)
    return this
  }
  fork() {
    this.forks.push(this.pos)
    return this
  }
  ldelim() {
    const start = this.forks.pop()!
    this.prefix(start, this.pos - start)
    return this
  }
  // Puts the length n in front of the n bytes from start (after 1 byte left free for it at start, for
  // a string, else none), moving them along to make room.
  private prefix(start: number, n: number) {
    const size = n < 0x80 ? 1 : n < 0x4000 ? 2 : n < 0x200000 ? 3 : n < 0x10000000 ? 4 : 5
    const at = this.pos - n
    const shift = start + size - at
    if (shift) {
      this.room(shift)
      this.buf.copyWithin(at + shift, at, this.pos)
      this.pos += shift
    }
    let v = n
    let i = start
    while (v > 0x7f) {
      this.buf[i++] = (v & 0x7f) | 0x80
      v >>>= 7
    }
    this.buf[i] = v
  }
  reset() {
    this.pos = 0
    this.forks.length = 0
    return this
  }
  // What's written, copied out.
  finish() {
    return this.buf.slice(0, this.pos)
  }
}
// One writer for every message, as each is written all at once.
const writer = new Writer()

// Reads what Writer writes, failing (throwing) on anything cut short.
class Reader {
  private buf: Uint8Array
  private view: DataView
  pos = 0
  len: number

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.len = buf.length
  }
  private need(n: number) {
    if (this.pos + n > this.len) throw new RangeError('cut short')
  }
  uint32() {
    let v = 0
    for (let shift = 0; ; shift += 7) {
      this.need(1)
      const b = this.buf[this.pos++]
      // Bits past 32 (a negative int32 takes 10 bytes) are dropped, as protobuf does.
      if (shift < 32) v |= (b & 0x7f) << shift
      if (!(b & 0x80)) return v >>> 0
      if (shift > 63) throw new RangeError('bad varint')
    }
  }
  sint32() {
    const v = this.uint32()
    return (v >>> 1) ^ -(v & 1)
  }
  bool() {
    return this.uint32() !== 0
  }
  double() {
    this.need(8)
    const v = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return v
  }
  string() {
    const n = this.uint32()
    this.need(n)
    const v = fromUtf8.decode(this.buf.subarray(this.pos, this.pos + n))
    this.pos += n
    return v
  }
  skipType(wt: number) {
    if (wt === VARINT) return void this.uint32()
    const n = wt === I64 ? 8 : wt === I32 ? 4 : wt === LEN ? this.uint32() : -1
    if (n < 0) throw new RangeError('unknown wire type')
    this.need(n)
    this.pos += n
  }
}

// ---- messages ----------------------------------------------------------------------

const TYPES: [string, Schema][] = []
for (const [type, [n, schema]] of Object.entries(SCHEMA)) TYPES[n] = [type, schema]

// Numbers as an sint32 of hundredths or thousandths, or as one.
const INT_MAX = 2 ** 31 - 1
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -INT_MAX - 1 && v <= INT_MAX
const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2 ** 32 - 1
const scaled = (v: unknown, k: number) => {
  const c = typeof v === 'number' ? Math.round(v * k) : NaN
  return isInt(c) ? c : null
}
const isNum = (v: unknown): v is number => typeof v === 'number'
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Loose => v !== null && typeof v === 'object' && !Array.isArray(v)

// Whether a field's value (not null or undefined) is what its kind takes.
function fits(kind: Kind, v: unknown): boolean {
  if (typeof kind !== 'string') {
    if ('one' in kind) return isObj(v)
    if ('many' in kind) return Array.isArray(v) && v.every(isObj)
    return kind.oneOf.includes(v as string)
  }
  switch (kind) {
    case 'centi':
      return scaled(v, 100) !== null
    case 'milli':
      return scaled(v, 1000) !== null
    case 'f64':
      return isNum(v)
    case 'int':
      return isInt(v)
    case 'uint':
      return isUint(v)
    case 'bool':
      return typeof v === 'boolean'
    case 'str':
      return isStr(v)
    case 'centis':
      return Array.isArray(v) && v.every((x) => scaled(x, 100) !== null)
    case 'ints':
      return Array.isArray(v) && v.every(isInt)
    case 'uints':
      return Array.isArray(v) && v.every(isUint)
    case 'strs':
      return Array.isArray(v) && v.every(isStr)
    case 'map':
      return isObj(v) && Object.values(v).every(isNum)
  }
}

const isList = (kind: Kind) => (typeof kind === 'string' ? kind.endsWith('s') || kind === 'map' : 'many' in kind)
const wireType = (kind: Kind) =>
  typeof kind !== 'string'
    ? 'oneOf' in kind
      ? VARINT
      : LEN
    : kind === 'centi' || kind === 'milli' || kind === 'int' || kind === 'uint' || kind === 'bool'
      ? VARINT
      : kind === 'f64'
        ? I64
        : LEN

// Writes message m's fields, as schema has them (type: its type, for what's thrown).
function write(w: Writer, schema: Schema, m: Loose, type: string) {
  let nulls: number[] | undefined
  let empty: number[] | undefined
  for (const [n, key, kind] of schema) {
    const v = m[key]
    if (v === undefined) continue
    if (v === null) {
      ;(nulls ??= []).push(n)
      continue
    }
    if (!fits(kind, v)) throw new TypeError(`${type}.${key} can't be sent: ${String(v)}`)
    if (isList(kind) && !(Array.isArray(v) ? v.length : Object.keys(v as Loose).length)) {
      ;(empty ??= []).push(n)
      continue
    }
    if (typeof kind !== 'string') {
      if ('oneOf' in kind) w.uint32((n << 3) | VARINT).uint32(kind.oneOf.indexOf(v as string))
      else
        for (const x of 'one' in kind ? [v as Loose] : (v as Loose[])) {
          w.uint32((n << 3) | LEN).fork()
          write(w, 'one' in kind ? kind.one : kind.many, x, type)
          w.ldelim()
        }
    } else
      switch (kind) {
        case 'centi':
          w.uint32((n << 3) | VARINT).sint32(scaled(v, 100)!)
          break
        case 'milli':
          w.uint32((n << 3) | VARINT).sint32(scaled(v, 1000)!)
          break
        case 'f64':
          w.uint32((n << 3) | I64).double(v as number)
          break
        case 'int':
          w.uint32((n << 3) | VARINT).sint32(v as number)
          break
        case 'uint':
          w.uint32((n << 3) | VARINT).uint32(v as number)
          break
        case 'bool':
          w.uint32((n << 3) | VARINT).bool(v as boolean)
          break
        case 'str':
          w.uint32((n << 3) | LEN).string(v as string)
          break
        // Repeated numbers are packed.
        case 'centis':
          w.uint32((n << 3) | LEN).fork()
          for (const x of v as number[]) w.sint32(scaled(x, 100)!)
          w.ldelim()
          break
        case 'ints':
          w.uint32((n << 3) | LEN).fork()
          for (const x of v as number[]) w.sint32(x)
          w.ldelim()
          break
        case 'uints':
          w.uint32((n << 3) | LEN).fork()
          for (const x of v as number[]) w.uint32(x)
          w.ldelim()
          break
        case 'strs':
          for (const x of v as string[]) w.uint32((n << 3) | LEN).string(x)
          break
        case 'map':
          for (const [k, x] of Object.entries(v as Record<string, number>)) {
            w.uint32((n << 3) | LEN).fork()
            w.uint32((1 << 3) | LEN).string(k)
            w.uint32((2 << 3) | I64).double(x)
            w.ldelim()
          }
          break
      }
  }
  for (const [n, list] of [[EMPTY, empty] as const, [NULLS, nulls] as const]) {
    if (!list) continue
    w.uint32((n << 3) | LEN).fork()
    for (const f of list) w.uint32(f)
    w.ldelim()
  }
}

// A schema's fields by number, looked up once.
const byNum = new WeakMap<Schema, Schema[number][]>()
function fieldOf(schema: Schema, n: number) {
  let list = byNum.get(schema)
  if (!list) {
    list = []
    for (const f of schema) list[f[0]] = f
    byNum.set(schema, list)
  }
  return list[n]
}

// Sets a key of an object made here, even one such as __proto__.
const put = (o: Loose, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })

function read(r: Reader, schema: Schema, end: number): Loose {
  if (end > r.len) throw new RangeError('cut short')
  const m: Loose = {}
  while (r.pos < end) {
    const tag = r.uint32()
    const n = tag >>> 3
    const wt = tag & 7
    if ((n === NULLS || n === EMPTY) && wt === LEN) {
      const e = r.uint32() + r.pos
      if (e > end) throw new RangeError('cut short')
      while (r.pos < e) {
        const f = fieldOf(schema, r.uint32())
        if (f) m[f[1]] = n === NULLS ? null : f[2] === 'map' ? {} : []
      }
      continue
    }
    const field = fieldOf(schema, n)
    if (!field || wt !== wireType(field[2])) {
      r.skipType(wt)
      continue
    }
    const [, key, kind] = field
    if (typeof kind !== 'string') {
      if ('oneOf' in kind) {
        // A value this side doesn't know is left out.
        const v = kind.oneOf[r.uint32()]
        if (v !== undefined) m[key] = v
        continue
      }
      const e = r.uint32() + r.pos
      if ('one' in kind) m[key] = read(r, kind.one, e)
      else ((m[key] ??= []) as Loose[]).push(read(r, kind.many, e))
    } else
      switch (kind) {
        case 'centi':
          m[key] = r.sint32() / 100
          break
        case 'milli':
          m[key] = r.sint32() / 1000
          break
        case 'f64':
          m[key] = r.double()
          break
        case 'int':
          m[key] = r.sint32()
          break
        case 'uint':
          m[key] = r.uint32()
          break
        case 'bool':
          m[key] = r.bool()
          break
        case 'str':
          m[key] = r.string()
          break
        case 'centis':
        case 'ints':
        case 'uints': {
          const e = r.uint32() + r.pos
          if (e > end) throw new RangeError('cut short')
          const list = (m[key] ??= []) as number[]
          while (r.pos < e) list.push(kind === 'uints' ? r.uint32() : kind === 'ints' ? r.sint32() : r.sint32() / 100)
          break
        }
        case 'strs':
          ;((m[key] ??= []) as string[]).push(r.string())
          break
        case 'map': {
          const e = r.uint32() + r.pos
          const entry = read(r, MAP_ENTRY, e)
          put((m[key] ??= {}) as Loose, String(entry.k ?? ''), entry.v ?? 0)
          break
        }
      }
  }
  if (r.pos !== end) throw new RangeError('overran')
  return m
}
const MAP_ENTRY: Schema = [
  [1, 'k', 'str'],
  [2, 'v', 'f64'],
]

// A message as protobuf. Throws when it can't go as it is: its type isn't one there is, or something
// in it isn't what SCHEMA says.
export function encode(msg: ClientMessage | ServerMessage): Uint8Array<ArrayBuffer> {
  const m = msg as Loose
  const type = m.type
  const s = typeof type === 'string' && Object.hasOwn(SCHEMA, type) ? SCHEMA[type as keyof typeof SCHEMA] : undefined
  if (!s) throw new TypeError(`No such message: ${String(type)}`)
  if (m.client !== undefined && typeof m.client !== 'string') throw new TypeError(`${type}.client can't be sent`)
  const [n, schema] = s
  const w = writer.reset()
  if (m.client !== undefined) w.uint32((1 << 3) | LEN).string(m.client as string)
  w.uint32((n << 3) | LEN).fork()
  write(w, schema, m, type as string)
  w.ldelim()
  return w.finish()
}

// A message read from protobuf; null when it isn't a whole message of a type there is.
export function decode(buf: Uint8Array): Loose | null {
  try {
    const r = new Reader(buf)
    let client: string | undefined
    let msg: Loose | null = null
    while (r.pos < r.len) {
      const tag = r.uint32()
      const n = tag >>> 3
      const wt = tag & 7
      if (n === 1 && wt === LEN) client = r.string()
      else if (TYPES[n] && wt === LEN) {
        const [type, schema] = TYPES[n]
        msg = { type, ...read(r, schema, r.uint32() + r.pos) }
      } else r.skipType(wt)
    }
    if (msg && client !== undefined) msg.client = client
    return msg
  } catch {
    return null
  }
}
