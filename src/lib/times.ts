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

// Everyone's time in the jigsaw, this player's counting up live while they play, until stopped.
// initial: the times as the room was loaded (none until it is).
export function useTimes(roomId: string, sock: RoomSocket | null, player: PlayerLogin | null, initial: TimeRow[] | undefined, stopped: boolean): Times {
  const [times, setTimes] = useState<Times>({})
  const [pending, setPending] = useState(0)
  const pendingRef = useRef(0)
  const stoppedRef = useRef(stopped)
  const flushRef = useRef<((beacon: boolean) => void) | null>(null)

  useEffect(() => {
    stoppedRef.current = stopped
    if (stopped) flushRef.current?.(false)
  }, [stopped])

  useEffect(() => {
    if (initial) setTimes(Object.fromEntries(initial.map((t) => [t.user, t.seconds])))
  }, [initial])
  useEffect(() => sock?.on('time', (msg) => setTimes((t) => ({ ...t, [msg.user]: msg.seconds }))), [sock])

  const id = player?.id
  const passphrase = player?.passphrase
  useEffect(() => {
    if (!id || !passphrase) return
    let last = performance.now()
    const flush = (beacon: boolean) => {
      const s = Math.floor(pendingRef.current)
      if (s <= 0) return
      pendingRef.current -= s
      setPending(Math.floor(pendingRef.current))
      setTimes((t) => ({ ...t, [id]: (t[id] || 0) + s }))
      api.time(roomId, passphrase, s, beacon)
    }
    flushRef.current = flush

    const tick = setInterval(() => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      if (active() && !stoppedRef.current) {
        pendingRef.current += Math.min(dt, 2)
        setPending(Math.floor(pendingRef.current))
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

  // This player's seconds not saved yet count too, so lists update live.
  return id ? { ...times, [id]: (times[id] || 0) + pending } : times
}
