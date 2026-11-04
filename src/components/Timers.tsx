import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { api } from '../lib/api.ts'
import type { TimeRow } from '../lib/api.ts'

const FLUSH_MS = 15000

// Time only accrues while this window is visible and focused, no dialog is open over the board (the
// settings drop-down doesn't count), and the jigsaw is unfinished.
const active = () =>
  document.visibilityState === 'visible' && document.hasFocus() && !document.querySelector('.modal-bg')

// Time is kept per player id (me), since names aren't unique.
// Seconds spent in the jigsaw, by player id.
export type Times = Record<string, number>

interface TimersProps {
  roomId: string
  me: string | null | undefined
  initial: TimeRow[]
  busRef: RefObject<((msg: TimeRow) => void) | null>
  stopped: boolean
  onTimes?: (times: Times) => void
}

export default function Timers({ roomId, me: name, initial, busRef, stopped, onTimes }: TimersProps) {
  const [times, setTimes] = useState<Times>(() => Object.fromEntries(initial.map((t) => [t.user, t.seconds])))
  const [pending, setPending] = useState(0)
  const pendingRef = useRef(0)
  const stoppedRef = useRef(stopped)

  // Report totals including this player's not-yet-saved seconds, so lists update live.
  useEffect(() => {
    onTimes?.(name ? { ...times, [name]: (times[name] || 0) + Math.floor(pending) } : times)
  }, [times, pending, name, onTimes])
  const flushRef = useRef<((beacon: boolean) => void) | null>(null)

  useEffect(() => {
    stoppedRef.current = stopped
    if (stopped) flushRef.current?.(false)
  }, [stopped])

  useEffect(() => {
    busRef.current = (msg) => setTimes((t) => ({ ...t, [msg.user]: msg.seconds }))
    let last = performance.now()

    const flush = (beacon: boolean) => {
      const s = Math.floor(pendingRef.current)
      if (s <= 0) return
      pendingRef.current -= s
      setPending(pendingRef.current)
      setTimes((t) => ({ ...t, [name!]: (t[name!] || 0) + s }))
      api.time(roomId, name!, s, beacon)
    }
    flushRef.current = flush

    const tick = setInterval(() => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      if (name && active() && !stoppedRef.current) {
        pendingRef.current += Math.min(dt, 2)
        setPending(pendingRef.current)
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
      busRef.current = null
    }
  }, [roomId, name, busRef])

  // Nothing to show: the times are in the player circles (see Players.tsx).
  return null
}
