export function formatTime(total: number): string {
  const s = Math.floor(total)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const ago = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]

// When something happened (ms since epoch), from now: "just now", "5 minutes ago", "yesterday".
export function timeAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  const [unit, size] = STEPS.find(([, size]) => s >= size)!
  return ago.format(-Math.floor(s / size), unit)
}
