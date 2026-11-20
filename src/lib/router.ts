import { useEffect, useState } from 'react'
import type { RoomListKind } from '../../shared/protocol.ts'

// The app's addresses: plain paths, no hash. /home is the jigsaws page and /new the same with the
// new jigsaw form open; under /home are the whole lists the page shows the start of (lists); /r/<id>
// is a jigsaw. / opens the last jigsaw (see App).
export const paths = {
  rooms: '/home',
  new: '/new',
  room: (id: string) => `/r/${id}`,
  lists: { mine: '/home/playing', finished: '/home/finished', public: '/home/browse' } satisfies Record<RoomListKind, string>,
}

// The jigsaw a path opens, the whole list it shows, and whether it is the jigsaws page (with a list
// or not).
export const roomOf = (path: string) => (path.startsWith('/r/') ? path.slice(3) : null)
export const listOf = (path: string) => (Object.entries(paths.lists).find(([, p]) => p === path)?.[0] as RoomListKind | undefined) ?? null
export const isGallery = (path: string) => path === paths.rooms || path === paths.new || !!listOf(path)

// Every route change goes through here or the back button.
export function navigate(path: string, replace = false) {
  if (path === window.location.pathname) return
  window.history[replace ? 'replaceState' : 'pushState'](null, '', path)
  window.dispatchEvent(new Event('navigate'))
}

export function usePath() {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const on = () => setPath(window.location.pathname)
    window.addEventListener('popstate', on)
    window.addEventListener('navigate', on)
    return () => {
      window.removeEventListener('popstate', on)
      window.removeEventListener('navigate', on)
    }
  }, [])
  return path
}

// Tidies the address the app was opened at, and returns the login it carried, if any: old links used
// the hash (/#/r/<id>), and links from the phone QR code carry a login (/r/<id>#login=<passphrase>),
// which is taken off the address.
export function takeLinkLogin() {
  if (window.location.hash.startsWith('#/')) window.history.replaceState(null, '', window.location.hash.slice(1))
  const m = /^#login=(.+)$/.exec(window.location.hash)
  if (!m) return null
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return decodeURIComponent(m[1])
}
