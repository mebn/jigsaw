import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import RoomsDialog from './pages/Rooms.tsx'
import Room from './pages/Room.tsx'
import Settings from './components/Settings.tsx'
import Tooltips from './components/Tooltips.tsx'
import AccountPrompt from './components/Account.tsx'
import { api } from './lib/api.ts'
import type { PlayerLogin } from './lib/api.ts'
import { useLinger } from './lib/linger.ts'
import { useNotch } from './lib/fullscreen.ts'
import { setSound } from './lib/sound.ts'

const store = {
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
    } catch {}
  },
}
export { store }

// The logged in player. For a player with an email, passphrase is this device's login token.
export type Player = PlayerLogin

export type Theme = 'light' | 'dark'
// What the jigsaws window shows.
export type RoomsView = 'rooms' | 'new'
// What the sign up or log in prompt shows (see Account.tsx).
export type AccountMode = 'name' | 'login' | 'email' | 'show' | 'returning'

interface Prompt {
  mode: AccountMode
  name?: string
  player?: Player
  resolve: (id: string | null) => void
}

export interface AppContext {
  theme: Theme
  toggleTheme: () => void
  sound: boolean
  toggleSound: () => void
  devMenu: boolean
  toggleDevMenu: () => void
  player: Player | null
  playerId: string | null
  currentPlayer: () => Player | null
  name: string | null
  setName: (v: string) => Promise<void>
  requireName: () => Promise<string | null>
  ensureName: () => boolean
  openLogin: () => Promise<string | null>
  logout: () => void
  switchToEmail: (email: string, password: string) => Promise<void>
  roomId: string | null
  setDialog: Dispatch<SetStateAction<RoomsView | null>>
  openRoom: (id: string) => void
}

const Ctx = createContext<AppContext | null>(null)
export const useApp = () => useContext(Ctx)!

// Plain paths (/r/<id>), no hash. Every route change goes through here or the back button.
export function navigate(path: string, replace = false) {
  if (path === window.location.pathname) return
  window.history[replace ? 'replaceState' : 'pushState'](null, '', path)
  window.dispatchEvent(new Event('navigate'))
}

// Old links used the hash (/#/r/<id>); move them over to the plain path.
if (window.location.hash.startsWith('#/')) window.history.replaceState(null, '', window.location.hash.slice(1))

// Links from the phone QR code carry a login: /r/<id>#login=<passphrase>. Take it off the address.
const linkLogin = (() => {
  const m = /^#login=(.+)$/.exec(window.location.hash)
  if (!m) return null
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return decodeURIComponent(m[1])
})()

// The logged in player, { id, name, passphrase, email }, kept in this browser. For a player who
// switched to an email and password, passphrase is this device's login token, never shown.
function readPlayer() {
  try {
    const p: Player | null = JSON.parse(store.get('player')!)
    return p?.id && p.name ? p : null
  } catch {
    return null
  }
}

function usePath() {
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

const media = window.matchMedia('(prefers-color-scheme: dark)')

function useTheme() {
  const [choice, setChoice] = useState(() => store.get('theme') as Theme | null)
  const [system, setSystem] = useState<Theme>(media.matches ? 'dark' : 'light')
  useEffect(() => {
    const on = () => setSystem(media.matches ? 'dark' : 'light')
    media.addEventListener('change', on)
    return () => media.removeEventListener('change', on)
  }, [])
  const theme = choice || system
  useEffect(() => {
    if (choice) document.documentElement.dataset.theme = choice
    else delete document.documentElement.dataset.theme
  }, [choice])
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    const value = next === system ? null : next
    store.set('theme', value)
    if (value) document.documentElement.dataset.theme = value
    else delete document.documentElement.dataset.theme
    setChoice(value)
  }
  return [theme, toggle] as const
}

export default function App() {
  const path = usePath()
  // The jigsaws window over the board: null, or which view it shows ('rooms' or 'new').
  const [dialog, setDialog] = useState<RoomsView | null>(null)
  const [shownDialog, dialogClosing] = useLinger(dialog)
  const [theme, toggleTheme] = useTheme()
  // Windows over the board keep below a MacBook's notch in fullscreen, like the room's toolbars.
  const notch = useNotch()
  useEffect(() => {
    document.documentElement.style.setProperty('--notch', `${notch}px`)
  }, [notch])
  // Sound effects, such as the click when pieces connect. On unless turned off.
  const [sound, setSoundState] = useState(() => store.get('sound') !== '0')
  setSound(sound)
  const toggleSound = useCallback(() => {
    setSoundState((v) => {
      store.set('sound', v ? '0' : null)
      return !v
    })
  }, [])
  // The dev menu over the board, only in development (npm run dev). Off unless turned on.
  const [devMenu, setDevMenu] = useState(() => import.meta.env.DEV && store.get('devMenu') === '1')
  const toggleDevMenu = useCallback(() => {
    setDevMenu((v) => {
      store.set('devMenu', v ? null : '1')
      return !v
    })
  }, [])
  const [player, setPlayerState] = useState(readPlayer)
  const playerRef = useRef(player)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const savePlayer = useCallback((p: Player | null) => {
    store.set(
      'player',
      p ? JSON.stringify({ id: p.id, name: p.name, passphrase: p.passphrase, email: p.email || null }) : null,
    )
    playerRef.current = p
    setPlayerState(p)
  }, [])

  // Log in from a QR code link, and move browsers that only knew a name (from before passphrases)
  // over to the player made for that name. The first such browser gets that player and is shown
  // its new passphrase; any later one is asked to log in with it, or start fresh.
  useEffect(() => {
    if (linkLogin) api.login(linkLogin).then(savePlayer).catch(() => {})
    // Check the saved login still works: a passphrase stops working once its player switches to
    // an email on another device.
    else if (playerRef.current)
      api
        .login(playerRef.current.passphrase)
        .then((p) => playerRef.current && savePlayer(p))
        .catch((err) => err.message === 'unknown passphrase' && savePlayer(null))
    const old = store.get('name')
    if (!old) return
    if (playerRef.current || linkLogin) return store.set('name', null)
    const done = () => {}
    api
      .claim(old)
      .then((p) => {
        store.set('name', null)
        if (playerRef.current) return
        savePlayer(p)
        setPrompt({ mode: 'show', player: p, resolve: done })
      })
      .catch((err) => {
        if (err.message !== 'taken') return
        store.set('name', null)
        if (!playerRef.current) setPrompt({ mode: 'returning', name: old, resolve: done })
      })
  }, [savePlayer])

  const setName = useCallback(
    async (v: string) => {
      const p = playerRef.current
      if (!p) return
      savePlayer({ ...(await api.rename(p.passphrase, v)), passphrase: p.passphrase, email: p.email })
    },
    [savePlayer],
  )
  const logout = useCallback(() => savePlayer(null), [savePlayer])
  // Switch this player's login from their passphrase to an email and password.
  const switchToEmail = useCallback(
    async (email: string, password: string) => {
      const p = playerRef.current
      if (p) savePlayer(await api.useEmail(p.passphrase, email, password))
    },
    [savePlayer],
  )

  // Opens the sign up or log in prompt; resolves with the player's id, or null if they cancel.
  const ask = useCallback(
    (mode: AccountMode) =>
      new Promise<string | null>((resolve) =>
        setPrompt((p) => {
          p?.resolve(null)
          return { mode, resolve }
        }),
      ),
    [],
  )

  // Resolves with the player's id, asking for a name first if needed (null if they cancel).
  const requireName = useCallback(() => {
    if (playerRef.current) return Promise.resolve(playerRef.current.id)
    return ask('name')
  }, [ask])
  const openLogin = useCallback(() => ask('login'), [ask])

  // Synchronous check for event handlers: true if logged in, otherwise opens the prompt.
  const ensureName = useCallback(() => {
    if (playerRef.current) return true
    requireName()
    return false
  }, [requireName])

  const roomId = path.startsWith('/r/') ? path.slice(3) : null

  // /rooms and /new open the jigsaws window over the last jigsaw; any other path goes to the last jigsaw.
  // With no jigsaw to show, the list stays open over an empty table.
  useEffect(() => {
    if (roomId) return
    if (path === '/new') setDialog('new')
    else if (path === '/rooms' || !store.get('lastRoom')) setDialog((d) => d || 'rooms')
    const last = store.get('lastRoom')
    navigate(last ? `/r/${last}` : '/', true)
  }, [path, roomId])

  const openRoom = useCallback((id: string) => {
    setDialog(null)
    navigate(`/r/${id}`)
  }, [])

  const ctx: AppContext = {
    theme,
    toggleTheme,
    sound,
    toggleSound,
    devMenu,
    toggleDevMenu,
    player,
    playerId: player?.id || null,
    // The player right now, for code that runs after an await (state in a closure may be stale).
    currentPlayer: () => playerRef.current,
    name: player?.name || null,
    setName,
    requireName,
    ensureName,
    openLogin,
    logout,
    switchToEmail,
    roomId,
    setDialog,
    openRoom,
  }

  return (
    <Ctx.Provider value={ctx}>
      <Tooltips />
      {roomId ? (
        <Room key={roomId} id={roomId} />
      ) : (
        <div className="room">
          <div className="float tl">
            <Settings />
          </div>
        </div>
      )}
      {shownDialog && (
        <RoomsDialog
          view={shownDialog}
          setView={setDialog}
          closing={dialogClosing}
          onClose={roomId ? () => setDialog(null) : null}
        />
      )}
      {prompt && (
        <AccountPrompt
          key={prompt.mode}
          mode={prompt.mode}
          name={prompt.name}
          player={prompt.player}
          onSignUp={api.signUp}
          onLogin={api.login}
          onLoginEmail={api.loginEmail}
          onDone={(p) => {
            savePlayer(p)
            prompt.resolve(p.id)
            setPrompt(null)
          }}
          onCancel={() => {
            prompt.resolve(null)
            setPrompt(null)
          }}
        />
      )}
    </Ctx.Provider>
  )
}
