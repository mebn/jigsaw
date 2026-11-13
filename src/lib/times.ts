import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { overlays } from './overlays.ts'
import type { RoomSocket } from './api.ts'
import type { PlayerLogin, TimeRow } from '../../shared/protocol.ts'

// How often the time this player spends is saved (ms), besides when they leave or look away.
const FLUSH_MS = 15000

// Time only accrues while this window is visible and focused, no dialog is open over the board (the
// settings drop-down doesn't count), and the jigsaw is unfinished.
const active = () => document.visibilityState === 'visible' && document.hasFocus() && !overlays.modalOpen()

// Seconds spent in the jigsaw, by player id.
export type Times = Record<string, number>

// This player's own time in the jigsaw, counting up each second while they play. Kept out of React
// state, so only what shows it (see Spent in Players.tsx) is drawn again each second, not the room.
export interface LiveSeconds {
  subscribe: (fn: () => void) => () => void
  get: () => number
}

// Everyone's time in the jigsaw as it was last saved (times), and this player's as it counts up
// (mine), until stopped. initial: the times as the room was loaded (none until it is).
export function useTimes(
  roomId: string,
  sock: RoomSocket | null,
  player: PlayerLogin | null,
  initial: TimeRow[] | undefined,
  stopped: boolean,
): { times: Times; mine: LiveSeconds } {
  const [times, setTimes] = useState<Times>({})
  // The same times, changed at once rather than at the next render, so mine never runs behind them.
  const saved = useRef<Times>({})
  const pendingRef = useRef(0)
  const idRef = useRef(player?.id)
  const stoppedRef = useRef(stopped)
  const flushRef = useRef<((beacon: boolean) => void) | null>(null)
  const listeners = useRef(new Set<() => void>())
  const emit = () => listeners.current.forEach((fn) => fn())
  const [mine] = useState<LiveSeconds>(() => ({
    subscribe: (fn) => {
      listeners.current.add(fn)
      return () => listeners.current.delete(fn)
    },
    // Saved seconds and those not saved yet.
    get: () => (idRef.current ? (saved.current[idRef.current] || 0) + Math.floor(pendingRef.current) : 0),
  }))
  const put = (next: Times) => {
    saved.current = next
    setTimes(next)
    emit()
  }

  useEffect(() => {
    stoppedRef.current = stopped
    if (stopped) flushRef.current?.(false)
  }, [stopped])

  useEffect(() => {
    if (initial) put(Object.fromEntries(initial.map((t) => [t.user, t.seconds])))
  }, [initial])
  useEffect(() => sock?.on('time', (msg) => put({ ...saved.current, [msg.user]: msg.seconds })), [sock])

  const id = player?.id
  const passphrase = player?.passphrase
  useEffect(() => {
    idRef.current = id
    emit()
    if (!id || !passphrase) return
    let last = performance.now()
    const flush = (beacon: boolean) => {
      const s = Math.floor(pendingRef.current)
      if (s <= 0) return
      pendingRef.current -= s
      put({ ...saved.current, [id]: (saved.current[id] || 0) + s })
      api.time(roomId, passphrase, s, beacon)
    }
    flushRef.current = flush

    const tick = setInterval(() => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      if (active() && !stoppedRef.current) {
        pendingRef.current += Math.min(dt, 2)
        emit()
      }
    }, 1000)
    const periodic = setInterval(() => flush(false), FLUSH_MS)
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
      flushRef.current = null
    }
  }, [roomId, id, passphrase])

  return { times, mine }
}
