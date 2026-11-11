// What this browser remembers. localStorage can be missing or full (private windows, blocked
// storage), so reading gives null and writing does nothing then.
export const store = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string | null | undefined) => {
    try {
      if (v == null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    } catch {
      // Not kept, as in a private window.
    }
  },
  // A JSON value, or null when there's none or it doesn't parse.
  json: <T>(k: string): T | null => {
    try {
      return JSON.parse(store.get(k) || 'null')
    } catch {
      return null
    }
  },
  setJson: (k: string, v: unknown) => store.set(k, v == null ? null : JSON.stringify(v)),
}

// The jigsaw this browser last had open, where it goes back to.
export const lastRoom = {
  get: () => store.get('lastRoom'),
  set: (id: string) => store.set('lastRoom', id),
  // Forgets it if it is this jigsaw (it was deleted, or can't be opened).
  forget: (id: string) => {
    if (store.get('lastRoom') === id) store.set('lastRoom', null)
  },
}

// Things this browser did once per jigsaw: showed how to play, celebrated it being finished.
export const roomOnce = (kind: 'help' | 'celebrated', id: string) => ({
  done: () => !!store.get(`${kind}:${id}`),
  mark: () => store.set(`${kind}:${id}`, '1'),
  reset: () => store.set(`${kind}:${id}`, null),
})
