import type { PlayerRef, ServerMessage } from '../shared/protocol.ts'
import { encode } from '../shared/wire.ts'
import type { Db } from './db.ts'
import { Message } from './ws.ts'
import type { Socket } from './ws.ts'

// A socket of a room, with the page's client id, the address it's from and the player on it.
export type RoomSocket = Socket & { client: string; ip: string; player: PlayerRef | null }

// A message made ready to go out (see shared/wire.ts), or null when it can't be.
function made(msg: ServerMessage) {
  try {
    return new Message(encode(msg))
  } catch (e) {
    console.error('room socket:', e)
    return null
  }
}

// Who is in which room right now: their sockets, what goes out to them, and when players were last
// in each room.
export function createHub({ prepare }: Db) {
  const rooms = new Map<string, Set<RoomSocket>>()
  const setSeen = prepare(`
    INSERT INTO times (room_id, user, seen) VALUES (?, ?, ?)
    ON CONFLICT (room_id, user) DO UPDATE SET seen = excluded.seen`)

  // The message is made once (and compressed once), for every socket it goes to.
  function broadcast(roomId: string, msg: ServerMessage, except?: RoomSocket) {
    const set = rooms.get(roomId)
    if (!set?.size) return
    const m = made(msg)
    if (m) for (const ws of set) if (ws !== except) ws.sendMessage(m)
  }

  // Player ids in a room right now.
  function online(roomId: string) {
    const ids = new Set<string>()
    for (const ws of rooms.get(roomId) || []) if (ws.player) ids.add(ws.player.id)
    return [...ids]
  }

  // Tells the room who is here, and when anyone who just left was last seen.
  function presence(roomId: string, left?: PlayerRef | null) {
    const seen: Record<string, number> = {}
    if (left) {
      seen[left.id] = Date.now()
      setSeen.run(roomId, left.id, seen[left.id])
    }
    broadcast(roomId, { type: 'presence', online: online(roomId), seen })
  }

  // Everyone in a room counts as seen now, once a minute: if the server stops without their sockets
  // closing, "last played" is still about right.
  setInterval(() => {
    const now = Date.now()
    for (const roomId of rooms.keys()) for (const id of online(roomId)) setSeen.run(roomId, id, now)
  }, 60000).unref()

  return {
    broadcast,
    // A message to one socket.
    send(ws: RoomSocket, msg: ServerMessage) {
      const m = made(msg)
      if (m) ws.sendMessage(m)
    },
    online,
    // Puts the socket in the room, and takes it out when it closes.
    join(roomId: string, ws: RoomSocket) {
      if (!rooms.has(roomId)) rooms.set(roomId, new Set())
      rooms.get(roomId)!.add(ws)
      presence(roomId)
      ws.onClose = () => {
        const set = rooms.get(roomId)
        if (!set?.delete(ws)) return
        // A room nobody is in is forgotten, until someone opens it again.
        if (!set.size) rooms.delete(roomId)
        broadcast(roomId, { type: 'gone', client: ws.client })
        presence(roomId, ws.player)
      }
    },
    // The player on a socket logged in, out or signed up.
    setPlayer(roomId: string, ws: RoomSocket, player: PlayerRef | null) {
      const before = ws.player
      ws.player = player
      if (player) broadcast(roomId, { type: 'player', client: ws.client, player: { id: player.id, name: player.name, avatar: player.avatar } }, ws)
      if (before?.id !== player?.id) presence(roomId, before)
    },
    // The room was deleted: its pages are told, and their sockets closed.
    end(roomId: string) {
      const set = rooms.get(roomId)
      broadcast(roomId, { type: 'deleted' })
      rooms.delete(roomId)
      for (const ws of set || []) ws.closed()
    },
    // Everyone's pages learn a player's new name.
    renamed(p: PlayerRef) {
      for (const [roomId, set] of rooms) {
        for (const ws of set) if (ws.player?.id === p.id) ws.player = p
        broadcast(roomId, { type: 'player', player: p })
      }
    },
    players: (roomId: string) => [...(rooms.get(roomId) || [])].flatMap((ws) => (ws.player ? [ws.player] : [])),
  }
}

export type Hub = ReturnType<typeof createHub>
