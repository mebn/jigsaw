import { useEffect, useState } from 'react'

// How long a closing dialog stays up to animate out (ms); matches the CSS.
export const CLOSE_MS = 160

// Keeps showing the last value for a moment after it goes falsy, so a dialog can animate out.
// Returns [what to show, whether it is closing].
export function useLinger<T>(value: T, ms = CLOSE_MS): [T | null, boolean] {
  const [kept, setKept] = useState<T | null>(value)
  useEffect(() => {
    if (value) return setKept(value)
    const t = setTimeout(() => setKept(null), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return [value || kept, !value && !!kept]
}
