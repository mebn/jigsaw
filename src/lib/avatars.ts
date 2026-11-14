import { useSyncExternalStore } from 'react'
import type { PlayerRef } from '../../shared/protocol.ts'

// Profile pictures: when each player's was set (ms, see PlayerRef.avatar), as the page has heard,
// for every player circle (see Dot in Players.tsx) to show it.
const versions = new Map<string, number>()
const listeners = new Set<() => void>()

export function learnAvatars(list: (PlayerRef | null | undefined)[]) {
  let changed = false
  for (const p of list) {
    if (!p?.id || p.avatar === undefined) continue
    const v = p.avatar || 0
    if ((versions.get(p.id) || 0) === v) continue
    versions.set(p.id, v)
    changed = true
  }
  if (changed) for (const fn of listeners) fn()
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// The address of a player's picture, or null when they have none.
export function useAvatar(id: string) {
  const v = useSyncExternalStore(subscribe, () => versions.get(id) || 0)
  return v ? `/api/players/${encodeURIComponent(id)}/avatar?v=${v}` : null
}

// The side of the square a picture is made into before it is sent: big enough for the largest circle
// on a sharp screen, small enough to be a few dozen KB.
const SIDE = 256

// A picture file made into a small square (cut from its middle) as a data URL: WebP where the browser
// can make one, otherwise JPEG. Rejects when the file isn't a picture the browser can read.
export async function avatarFromFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Pick a picture file.')
  if (file.size > 30 * 1024 * 1024) throw new Error('That picture is too big, pick one under 30 MB.')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error("Couldn't read that picture, try another.")
  }
  const s = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIDE
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, (bitmap.width - s) / 2, (bitmap.height - s) / 2, s, s, 0, 0, SIDE, SIDE)
  bitmap.close()
  const webp = canvas.toDataURL('image/webp', 0.85)
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85)
}
