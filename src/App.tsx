import { useCallback, useEffect, useRef, useState } from 'react'
import Gallery, { GALLERY_OUT_MS } from './pages/Rooms.tsx'
import Room from './pages/Room.tsx'
import Tooltips from './components/Tooltips.tsx'
import AccountPrompt from './components/Account.tsx'
import type { AccountMode } from './components/Account.tsx'
import { api } from './lib/api.ts'
import { AppCtx } from './lib/app.ts'
import type { AppContext, Theme } from './lib/app.ts'
import { ERRORS } from '../shared/protocol.ts'
import type { PlayerLogin } from '../shared/protocol.ts'
import { useLinger } from './lib/linger.ts'
import { useNotch } from './lib/fullscreen.ts'
import { navigate, isGallery, paths, roomOf, takeLinkLogin, usePath } from './lib/router.ts'
import { setSound, soundOn } from './lib/sound.ts'
import { lastRoom, store } from './lib/storage.ts'

const linkLogin = takeLinkLogin()

interface Prompt {
  mode: AccountMode
  name?: string
  player?: PlayerLogin
  resolve: (id: string | null) => void
}

// The logged in player, kept in this browser. For a player who switched to an email and password,
// passphrase is this device's login token, never shown.
function readPlayer() {
  const p = store.json<PlayerLogin>('player')
  return p?.id && p.name ? p : null
}

const media = window.matchMedia('(prefers-color-scheme: dark)')

// The theme: the system's, unless this browser chose the other one.
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
    setChoice(value)
  }
  return [theme, toggle] as const
}

// How long a jigsaw stays on the screen, zooming out, as the jigsaws page comes over it (ms).
const LEAVE_MS = 900
// The longest the jigsaws page waits over a jigsaw that is opening, for it to be ready (ms).
const ARRIVE_MAX_MS = 10000

export default function App() {
  const path = usePath()
  const roomId = roomOf(path)
  const onGallery = isGallery(path)
  // Going from a jigsaw to the jigsaws page, the jigsaw stays a moment, zooming out, under it
  // (leaving). Going from the page to a jigsaw, the page stays over it until it is ready to zoom
  // in (arriving). Worked out as the path changes, so the jigsaw isn't unmounted in between.
  const [leaving, setLeaving] = useState<string | null>(null)
  const [arriving, setArriving] = useState<string | null>(null)
  const [prevPath, setPrevPath] = useState(path)
  if (path !== prevPath) {
    setPrevPath(path)
    const from = roomOf(prevPath)
    setLeaving(onGallery && from ? from : null)
    setArriving(roomId && isGallery(prevPath) ? roomId : null)
  }
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setLeaving(null), LEAVE_MS)
    return () => clearTimeout(t)
  }, [leaving])
  useEffect(() => {
    if (!arriving) return
    const t = setTimeout(() => setArriving(null), ARRIVE_MAX_MS)
    return () => clearTimeout(t)
  }, [arriving])
  const arrived = useCallback(() => setArriving(null), [])
  const [galleryShown, galleryClosing] = useLinger(onGallery || !!arriving, GALLERY_OUT_MS)
  const shownRoom = roomId || leaving
  const [theme, toggleTheme] = useTheme()
  // Windows and toolbars keep below a MacBook's notch in fullscreen.
  const notch = useNotch()
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--notch', `${notch}px`)
    if (notch) root.dataset.notch = ''
    else delete root.dataset.notch
  }, [notch])
  const [sound, setSoundState] = useState(soundOn)
  const toggleSound = useCallback(() => {
    setSound(!soundOn())
    setSoundState(soundOn())
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
  const savePlayer = useCallback((p: PlayerLogin | null) => {
    store.setJson('player', p && { id: p.id, name: p.name, passphrase: p.passphrase, email: p.email || null })
    playerRef.current = p
    setPlayerState(p)
  }, [])

  // Log in from a QR code link, and move browsers that only knew a name (from before passphrases)
  // over to the player made for that name. The first such browser gets that player and is shown
  // its new passphrase; any later one is asked to log in with it, or start fresh.
  useEffect(() => {
    if (linkLogin) api.login(linkLogin).then(savePlayer, () => {})
    // Check the saved login still works: a passphrase stops working once its player switches to
    // an email on another device.
    else if (playerRef.current)
      api.login(playerRef.current.passphrase).then(
        (p) => playerRef.current && savePlayer(p),
        (err: Error) => err.message === ERRORS.unknownPassphrase && savePlayer(null),
      )
    const old = store.get('name')
    if (!old) return
    if (playerRef.current || linkLogin) return store.set('name', null)
    // Kept until the server answers, so a network failure tries again next time.
    api.claim(old).then(
      (p) => {
        store.set('name', null)
        if (playerRef.current) return
        savePlayer(p)
        setPrompt({ mode: 'show', player: p, resolve: () => {} })
      },
      (err: Error) => {
        if (err.message !== ERRORS.nameTaken) return
        store.set('name', null)
        if (!playerRef.current) setPrompt({ mode: 'returning', name: old, resolve: () => {} })
      },
    )
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
  const requireName = useCallback(() => (playerRef.current ? Promise.resolve(playerRef.current.id) : ask('name')), [ask])
  const openLogin = useCallback(() => ask('login'), [ask])
  const ensureName = useCallback(() => {
    if (playerRef.current) return true
    requireName()
    return false
  }, [requireName])

  // Any other path goes to the last jigsaw, or the jigsaws page when there isn't one.
  useEffect(() => {
    if (roomId || onGallery) return
    const last = lastRoom.get()
    navigate(last ? paths.room(last) : paths.rooms, true)
  }, [path, roomId, onGallery])

  const ctx: AppContext = {
    theme,
    toggleTheme,
    sound,
    toggleSound,
    devMenu,
    toggleDevMenu,
    player,
    playerId: player?.id || null,
    currentPlayer: () => playerRef.current,
    name: player?.name || null,
    setName,
    requireName,
    ensureName,
    openLogin,
    logout,
    switchToEmail,
    roomId,
  }

  return (
    <AppCtx.Provider value={ctx}>
      <Tooltips />
      {shownRoom && (
        <Room key={shownRoom} id={shownRoom} leaving={!roomId} arriving={arriving === shownRoom} onArrived={arrived} />
      )}
      {galleryShown && <Gallery here={onGallery} closing={galleryClosing} newOpen={path === paths.new} />}
      {prompt && (
        <AccountPrompt
          key={prompt.mode}
          mode={prompt.mode}
          name={prompt.name}
          player={prompt.player}
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
    </AppCtx.Provider>
  )
}
