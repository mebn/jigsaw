import { useEffect, useState } from 'react'

// The app's addresses: plain paths, no hash. /rooms is the jigsaws page and /new the same with the
// new jigsaw form open; /r/<id> is a jigsaw.
export const paths = {
  rooms: '/rooms',
  new: '/new',
  room: (id: string) => `/r/${id}`,
}

// The jigsaw a path opens, and whether it is the jigsaws page.
export const roomOf = (path: string) => (path.startsWith('/r/') ? path.slice(3) : null)
export const isGallery = (path: string) => path === paths.rooms || path === paths.new

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
