import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { overlays } from './overlays.ts'
import type { RoomSocket } from './api.ts'
import type { PlayerLogin, TimeRow } from '../../shared/protocol.ts'

// How often the time this player spends is saved (ms), besides when they leave or look away. Their
// clock goes to the others as often, so a page that's gone quiet stops counting up (see STALE_MS).
const FLUSH_MS = 15000
// Another player's clock counts up for at most this long (ms) after it was last heard from.
const STALE_MS = FLUSH_MS + 5000

// Time only accrues while this window is visible and focused, no dialog is open over the board (the
// settings drop-down doesn't count), and the jigsaw is unfinished.
const active = () => document.visibilityState === 'visible' && document.hasFocus() && !overlays.modalOpen()

// Seconds spent in the jigsaw, by player id.
export type Times = Record<string, number>

// Everyone's time in the jigsaw right now, counting up each second for those playing: this player's
// own, and the others' from their clocks (see the clock message). Kept out of React state, so only
// what shows it (see Spent in Players.tsx) is drawn again each second, not the room.
export interface LiveTimes {
  subscribe: (fn: () => void) => () => void
  // A player's whole seconds.
  get: (user: string) => number
  // Every player's.
  all: () => Times
}

// Another page's clock: its player's seconds when it was heard from (at, performance.now()), and
// whether they were counting up.
interface Clock {
  user: string
  seconds: number
  on: boolean
  at: number
}

// Everyone's time in the jigsaw as it was last saved (times), and as it counts up (live), until
// stopped. initial: the times as the room was loaded (none until it is).
export function useTimes(
  roomId: string,
  sock: RoomSocket | null,
  player: PlayerLogin | null,
  initial: TimeRow[] | undefined,
  stopped: boolean,
): { times: Times; live: LiveTimes } {
  const [times, setTimes] = useState<Times>({})
  // The same times, changed at once rather than at the next render, so the live ones never run behind them.
  const saved = useRef<Times>({})
  const pendingRef = useRef(0)
  const idRef = useRef(player?.id)
  const stoppedRef = useRef(stopped)
  const flushRef = useRef<((beacon: boolean) => void) | null>(null)
  // Sends this player's clock, see useEffect below.
  const sendRef = useRef<(() => void) | null>(null)
  // Other pages' clocks, by client id.
  const clocks = useRef(new Map<string, Clock>())
  const listeners = useRef(new Set<() => void>())
  // The live times as last worked out, so they're the same however often they're read.
  const now = useRef<Times>({})
  const refresh = () => {
    const next: Times = { ...saved.current }
    const t = performance.now()
    for (const c of clocks.current.values()) {
      const s = Math.floor(c.seconds + (c.on ? Math.min(t - c.at, STALE_MS) / 1000 : 0))
      if (s > (next[c.user] || 0)) next[c.user] = s
    }
    const id = idRef.current
    if (id) next[id] = (saved.current[id] || 0) + Math.floor(pendingRef.current)
    now.current = next
    listeners.current.forEach((fn) => fn())
  }
  const [live] = useState<LiveTimes>(() => ({
    subscribe: (fn) => {
      listeners.current.add(fn)
      return () => listeners.current.delete(fn)
    },
    get: (user) => now.current[user] || 0,
    all: () => now.current,
  }))
  const put = (next: Times) => {
    saved.current = next
    setTimes(next)
    refresh()
  }

  useEffect(() => {
    stoppedRef.current = stopped
    if (stopped) flushRef.current?.(false)
  }, [stopped])

  useEffect(() => {
    if (initial) put(Object.fromEntries(initial.map((t) => [t.user, t.seconds])))
  }, [initial])

  useEffect(() => {
    if (!sock) return
    const offs = [
      sock.on('time', (msg) => put({ ...saved.current, [msg.user]: msg.seconds })),
      sock.on('clock', (msg) => {
        clocks.current.set(msg.client, { user: msg.player, seconds: msg.seconds, on: msg.on, at: performance.now() })
        refresh()
      }),
      sock.on('gone', (msg) => {
        if (clocks.current.delete(msg.client)) refresh()
      }),
      // Someone came or went: those who just came learn where this player's clock is.
      sock.on('presence', () => sendRef.current?.()),
    ]
    // The others' clocks count up each second.
    const tick = setInterval(() => {
      for (const c of clocks.current.values()) if (c.on) return refresh()
    }, 1000)
    return () => {
      for (const off of offs) off()
      clearInterval(tick)
      clocks.current.clear()
    }
  }, [sock])

  const id = player?.id
  const passphrase = player?.passphrase
  useEffect(() => {
    idRef.current = id
    refresh()
    if (!id || !passphrase) return
    let last = performance.now()
    let on = false
    const send = () => sock?.send({ type: 'clock', seconds: (saved.current[id] || 0) + pendingRef.current, on })
    sendRef.current = send
    const flush = (beacon: boolean) => {
      const s = Math.floor(pendingRef.current)
      if (s <= 0) return
      pendingRef.current -= s
      put({ ...saved.current, [id]: (saved.current[id] || 0) + s })
      api.time(roomId, passphrase, s, beacon)
    }
    flushRef.current = flush

    const tick = setInterval(() => {
      const t = performance.now()
      const dt = (t - last) / 1000
      last = t
      const was = on
      on = active() && !stoppedRef.current
      if (on) {
        pendingRef.current += Math.min(dt, 2)
        refresh()
      }
      if (on !== was) send()
    }, 1000)
    const periodic = setInterval(() => {
      flush(false)
      if (on) send()
    }, FLUSH_MS)
    const onBlur = () => flush(true)
    const onFocus = () => (last = performance.now())
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    window.addEventListener('pagehide', onBlur)
    document.addEventListener('visibilitychange', onBlur)
    return () => {
      clearInterval(tick)
      clearInterval(periodic)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pagehide', onBlur)
      document.removeEventListener('visibilitychange', onBlur)
      flush(true)
      on = false
      send()
      flushRef.current = null
      sendRef.current = null
    }
  }, [roomId, id, passphrase, sock])

  return { times, live }
}
