import { newBuild } from './update.js'

export const clientId = Math.random().toString(36).slice(2)

// Open room sockets, by room id.
const sockets = new Map()
// Messages that only matter while they're fresh; everything else is queued while offline.
const transient = (msg) => msg.live || msg.type === 'live' || msg.type === 'grab' || msg.type === 'cursor'

async function json(res) {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json)

export const api = {
  // Players: each resolves with { id, name, passphrase }.
  signUp: (name) => post('/api/players', { name }),
  claim: (name) => post('/api/players/claim', { name }),
  login: (passphrase) => post('/api/players/login', { passphrase }),
  // With an email, the player's passphrase field holds this device's login token instead.
  loginEmail: (email, password) => post('/api/players/email-login', { email, password }),
  useEmail: (passphrase, email, password) => post('/api/players/email', { passphrase, email, password }),
  rename: (passphrase, name) => post('/api/players/rename', { passphrase, name }),
  lan: () => fetch('/api/lan').then(json),
  // Private jigsaws are only listed for the player who opened them, known by their passphrase.
  rooms: (passphrase) => fetch('/api/rooms', { headers: passphrase ? { 'X-Passphrase': passphrase } : {} }).then(json),
  room: (id) => fetch(`/api/rooms/${id}`).then(json),
  // A player and the jigsaws they have played: { id, name, created, rooms }. Private ones only come
  // back when this player (known by their passphrase) has them too.
  player: (id, passphrase) =>
    fetch(`/api/players/${encodeURIComponent(id)}`, { headers: passphrase ? { 'X-Passphrase': passphrase } : {} }).then(json),
  // Players with an email who can be invited to a private jigsaw, as [{ id, name, joined }].
  invitable: (passphrase, room = '') =>
    fetch(`/api/players/invitable?room=${encodeURIComponent(room)}`, { headers: { 'X-Passphrase': passphrase } }).then(
      json,
    ),
  invite: (id, passphrase, players) => post(`/api/rooms/${id}/invite`, { passphrase, players }),
  join: (id, passphrase) => post(`/api/rooms/${id}/join`, { passphrase }),
  imageUrl: (id) => `/api/rooms/${id}/image`,
  // The biggest group each time it grew, for the timelapse: [{ t, size, pieces }] (see timelapse.js).
  snapshots: (id) => fetch(`/api/rooms/${id}/snapshots`).then(json),
  create: (body) =>
    fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  remove: (id, passphrase) =>
    fetch(`/api/rooms/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    }).then(json),
  time: (id, user, seconds, beacon = false) => {
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
  saveNote: (id, note, live = false) => sockets.get(id)?.send({ type: 'note', live, note }),
  deleteNote: (id, noteId) => sockets.get(id)?.send({ type: 'note-delete', id: noteId }),
  saveRef: (id, ref, live = false) => sockets.get(id)?.send({ type: 'ref', live, ref }),
  deleteRef: (id, refId) => sockets.get(id)?.send({ type: 'ref-delete', id: refId }),
  saveTray: (id, tray, live = false) => sockets.get(id)?.send({ type: 'tray', live, tray }),
  deleteTray: (id, trayId) => sockets.get(id)?.send({ type: 'tray-delete', id: trayId }),
  // Live room channel. Reconnects on its own; onOpen(reconnect) fires on every connect.
  // Changes made while disconnected are queued and sent once the socket is back.
  socket: (id, { player, onMessage, onOpen }) => {
    let ws = null
    let dead = false
    let retry = 0
    let timer = 0
    let opened = false
    const queue = []
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const open = () => {
      const who = player?.() ? `&player=${player()}` : ''
      ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${id}&client=${clientId}${who}`)
      ws.onopen = () => {
        retry = 0
        for (const msg of queue.splice(0)) ws.send(JSON.stringify(msg))
        onOpen?.(opened)
        opened = true
      }
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'build') newBuild(msg.build)
        else if (msg.client !== clientId) onMessage(msg)
      }
      ws.onclose = () => {
        if (dead) return
        timer = setTimeout(open, Math.min(5000, 300 * 2 ** retry++))
      }
    }
    open()
    const handle = {
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
