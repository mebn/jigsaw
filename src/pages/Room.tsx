import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { api, openRoomSocket } from '../lib/api.ts'
import { renderPreview } from '../lib/preview.ts'
import type { RoomSocket } from '../lib/api.ts'
import type { PlayerRef, RefRow, RoomDetails } from '../../shared/protocol.ts'
import { LIMITS } from '../../shared/protocol.ts'
import { Engine } from '../lib/engine.ts'
import { warmSprites } from '../lib/spriteBuilder.ts'
import { cursorColor } from '../lib/colors.ts'
import { useApp } from '../lib/app.ts'
import { lastRoom, roomOnce, store } from '../lib/storage.ts'
import { navigate, paths } from '../lib/router.ts'
import { useTimes } from '../lib/times.ts'
import { isPlainKey, isTyping, onTable, overlays, useEscapeFallback, useOverlay } from '../lib/overlays.ts'
import { Hand, Pencil, Picture, Rooms, Share } from '../components/icons.tsx'
import Settings from '../components/Settings.tsx'
import { BasicsDialog } from '../components/Help.tsx'
import type { OpenSettings } from '../components/Settings.tsx'
import Players, { rankPlayers } from '../components/Players.tsx'
import type { NameOf, Stats } from '../components/Players.tsx'
import Podium, { PodiumIcon } from '../components/Podium.tsx'
import Reactions from '../components/Reactions.tsx'
import Celebration from '../components/Celebration.tsx'
import DevMenu from '../components/DevMenu.tsx'
import { useLinger } from '../lib/linger.ts'
import { NoteButton, NotesLayer } from '../components/Notes.tsx'
import type { CreateNote } from '../components/Notes.tsx'
import ContextMenu from '../components/ContextMenu.tsx'
import type { MenuAt } from '../components/ContextMenu.tsx'
import { TrayButton } from '../components/Trays.tsx'
import SplitButton from '../components/SplitButton.tsx'
import type { SplitPanes } from '../components/SplitButton.tsx'
import ShareDialog from '../components/ShareDialog.tsx'
import PictureMap from '../components/PictureMap.tsx'
import Search from '../components/Search.tsx'
import { playSnap } from '../lib/sound.ts'
import { canFullscreen, toggleFullscreen } from '../lib/fullscreen.ts'

// No browser menu on a right click in the bar along the top, except in a text field.
const noMenu = (e: MouseEvent) => {
  if (!(e.target as Element).closest('input, textarea, [contenteditable="true"]')) e.preventDefault()
}

// The controls fade away after this long without the pointer moving or a key being pressed.
const IDLE_MS = 3000

// True once nothing has happened for IDLE_MS. Stays false while the pointer is over the controls,
// a menu or dialog is open, or the last input was touch (a tap on a hidden button would reach the
// table instead).
function useIdle() {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    let timer = 0
    let over = false
    let touch = false
    const busy = () => over || touch || overlays.count() > 0 || document.querySelector('.float :focus-visible, .players :focus-visible')
    const sleep: () => void = () => (busy() ? (timer = setTimeout(sleep, IDLE_MS)) : setIdle(true))
    const wake = (e: Event) => {
      if (e.type !== 'keydown') over = !!(e.target as Element | null)?.closest?.('.float, .players, .podium-btn, .share-btn')
      if ((e as PointerEvent).pointerType) touch = (e as PointerEvent).pointerType === 'touch'
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(sleep, IDLE_MS)
    }
    const events = ['pointermove', 'pointerdown', 'wheel', 'keydown']
    for (const ev of events) window.addEventListener(ev, wake, { capture: true, passive: true })
    timer = setTimeout(sleep, IDLE_MS)
    return () => {
      clearTimeout(timer)
      for (const ev of events) window.removeEventListener(ev, wake, { capture: true })
    }
  }, [])
  return idle
}

function readColors() {
  const s = getComputedStyle(document.documentElement)
  return {
    bg: s.getPropertyValue('--canvas').trim(),
    // Notes and the buttons on trays and images.
    card: s.getPropertyValue('--bg').trim(),
    edge: s.getPropertyValue('--line').trim(),
    muted: s.getPropertyValue('--muted').trim(),
    dot: s.getPropertyValue('--dot').trim(),
    shadow: s.getPropertyValue('--shadow').trim(),
    line: s.getPropertyValue('--fg').trim(),
    sel: s.getPropertyValue('--sel').trim(),
  }
}

// Reference images used to be kept per browser; these get uploaded to the room once.
function takeLocalRefs(id: string): RefRow[] {
  const list = store.json<RefRow[]>(`refs:${id}`)
  store.set(`refs:${id}`, null)
  return Array.isArray(list) ? list.filter((r) => r && r.id && r.w > 0) : []
}

// An open jigsaw: its engine, the room's socket and the room as last loaded (again after a reconnect).
interface Session {
  engine: Engine
  sock: RoomSocket
  room: RoomDetails
}

// leaving: the jigsaws page is coming over it, so it zooms out. arriving: it was opened from the
// jigsaws page, which waits over it until it is ready (onArrived), and then it zooms in.
interface RoomProps {
  id: string
  leaving?: boolean
  arriving?: boolean
  onArrived?: () => void
}

export default function Room({ id, leaving = false, arriving = false, onArrived }: RoomProps) {
  const { name, player, playerId, theme, ensureName, devMenu } = useApp()
  const passphrase = useRef(player?.passphrase ?? null)
  passphrase.current = player?.passphrase ?? null
  // Player names by id. Names aren't unique, so everything is stored by player id and looked up here.
  const names = useRef(new Map<string, string>())
  const [, setNamesVer] = useState(0)
  const learn = useCallback((list: (PlayerRef | null)[]) => {
    for (const p of list) if (p?.id) names.current.set(p.id, String(p.name || '').slice(0, LIMITS.name))
    setNamesVer((v) => v + 1)
  }, [])
  const nameOf: NameOf = useCallback((pid) => (pid ? names.current.get(pid) || 'Someone' : ''), [])
  const canvas = useRef<HTMLCanvasElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const cursors = useRef<HTMLCanvasElement>(null)
  const [session, setSession] = useState<Session | null>(null)
  const engine = session?.engine ?? null
  const [done, setDone] = useState(false)
  const createNote = useRef<CreateNote | null>(null)
  const openPlayers = useRef<(() => void) | null>(null)
  // Escape with nothing open over the table is for the table first, then for the settings.
  useEscapeFallback(engine && (() => engine.escape()), 1)
  const [stats, setStats] = useState<Stats>(() => new Map())
  const { times, mine: myTime } = useTimes(id, session?.sock ?? null, player, session?.room.times, done)
  // Player ids in the room right now, and when the others were last here (ms by id).
  const [online, setOnline] = useState(() => new Set<string>())
  const [seen, setSeen] = useState<Record<string, number>>({})
  const openSettings = useRef<OpenSettings | null>(null)
  const openAccount = useCallback(() => openSettings.current?.('account'), [])
  // The basic controls show by themselves the first time this player opens each jigsaw, once it has
  // arrived; H there opens how to play with all of them.
  const [basics, setBasics] = useState(false)
  const [basicsShown, basicsClosing] = useLinger(basics)
  const closeBasics = useCallback(() => setBasics(false), [])
  const allControls = useCallback(() => {
    setBasics(false)
    openSettings.current?.('help')
  }, [])
  useEffect(() => {
    const help = roomOnce('help', id)
    if (arriving || help.done()) return
    help.mark()
    setBasics(true)
  }, [id, arriving])
  const idle = useIdle()
  const [error, setError] = useState(false)
  // Why the table can't be drawn here (WebGPU didn't start), shown instead of it.
  const [gpuError, setGpuError] = useState<string | null>(null)
  // View mode: dragging with the left button (or a finger) moves the table, never pieces or notes.
  const [panMode, setPanMode] = useState(() => store.get('panMode') === '1')
  // Split screen: the table two to four times, to carry pieces between far apart places, cut up as
  // splitPanes says (see SplitButton).
  const [split, setSplit] = useState(() => store.get('split') === '1')
  const [splitPanes, setSplitPanes] = useState<SplitPanes>(() => {
    const n = Number(store.get('splitPanes'))
    return n === 3 || n === 4 ? n : 2
  })
  // Draw mode: dragging draws strokes that fade away after a few seconds, for everyone to see.
  const [drawMode, setDrawMode] = useState(false)
  // The picture as a map over the table, just for this player (Q, see PictureMap).
  const [map, setMap] = useState(false)
  const [mapShown, mapClosing] = useLinger(map)
  const closeMap = useCallback(() => setMap(false), [])
  const [menu, setMenu] = useState<MenuAt | null>(null)
  // Ctrl+F: search the notes and named trays (see Search).
  const [search, setSearch] = useState(false)
  const [searchShown, searchClosing] = useLinger(search)
  const closeSearch = useCallback(() => setSearch(false), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const [podium, setPodium] = useState(false)
  const closePodium = useCallback(() => setPodium(false), [])
  const [sharing, setSharing] = useState(false)
  const closeShare = useCallback(() => setSharing(false), [])
  const [shareShown, shareClosing] = useLinger(sharing)
  const [podiumShown, podiumClosing] = useLinger(podium)
  const [party, setParty] = useState(false)
  // Bumped to play the celebration again from the start, see the dev menu.
  const [partyKey, setPartyKey] = useState(0)
  // After the celebration, bring up the podium.
  const endParty = useCallback(() => {
    setParty(false)
    setPodium(true)
  }, [])
  const celebrate = useCallback(() => {
    setPodium(false)
    setPartyKey((k) => k + 1)
    setParty(true)
  }, [])

  useEffect(() => {
    let dead = false
    let eng: Engine | null = null
    let sock: RoomSocket | null = null
    let disconnect = () => {}
    const celebrated = roomOnce('celebrated', id)
    // The room as it is now, on the table and in the lists.
    const show = (room: RoomDetails) => {
      learn(room.players)
      setOnline(new Set(room.online))
      setSeen(room.seen)
    }
    ;(async () => {
      try {
        // The workers that cut the pieces start loading, and the picture with the jigsaw.
        warmSprites()
        const image = new Image()
        image.src = api.imageUrl(id)
        const decoded = image.decode()
        decoded.catch(() => {})
        const room = await api.room(id)
        await decoded
        if (dead) return
        lastRoom.set(id)
        eng = new Engine(canvas.current!, {
          room,
          image,
          pieces: room.pieces,
          refs: room.refs,
          trays: room.trays,
          overlay: cursors.current,
          user: playerId,
          userName: name,
          nameOf,
          guard: ensureName,
          tooltip: tip.current!,
          onStats: () => setStats(eng!.contributors()),
          onSnap: playSnap,
          onMenu: (x, y, kind, id, opts) => setMenu({ x, y, kind, id, rename: !!opts?.rename }),
          onComplete: () => {
            setDone(true)
            // Celebrate once per player and jigsaw, whoever placed the last piece.
            if (celebrated.done()) return
            celebrated.mark()
            setParty(true)
          },
        })
        try {
          await eng.ready
        } catch (err) {
          if (!dead) setGpuError(String((err as Error)?.message || err))
          return
        }
        if (dead) return
        show(room)
        eng.setColors(readColors())
        setStats(eng.contributors())
        setDone(eng.isComplete())
        // Already finished before this player opened it: nothing left to celebrate.
        if (eng.isComplete()) celebrated.mark()
        // A jigsaw from before link previews gets one when its maker opens it (anyone logged in, when
        // it has no maker). Private ones never show theirs, see sharing() in server/rooms.ts.
        const mine = passphrase.current && (!room.owner || room.owner === playerId)
        if (!room.preview && !room.private && mine)
          setTimeout(() => !dead && passphrase.current && api.preview(id, passphrase.current, renderPreview(image)).catch(() => {}), 1000)
        const e = eng
        sock = openRoomSocket(
          id,
          () => passphrase.current,
          async (reconnect) => {
            if (!reconnect) return
            const fresh = await api.room(id).catch(() => null)
            if (!fresh || dead) return
            e.resync(fresh.pieces)
            e.checkGroups()
            e.setRefs(fresh.refs)
            e.setTrays(fresh.trays)
            show(fresh)
            setSession((s) => s && { ...s, room: fresh })
          },
        )
        const offEngine = e.connect(sock)
        const offs = [
          sock.on('deleted', () => {
            lastRoom.forget(id)
            navigate(paths.rooms)
          }),
          sock.on('player', (msg) => learn([msg.player])),
          sock.on('presence', (msg) => {
            setOnline(new Set(msg.online))
            setSeen((s) => ({ ...s, ...msg.seen }))
          }),
        ]
        disconnect = () => {
          offEngine()
          offs.forEach((off) => off())
        }
        setSession({ engine: e, sock, room })
        // Pieces left out of line in their group (see Engine.repair) are put right, now that it can say so.
        e.checkGroups()
        for (const ref of takeLocalRefs(id)) {
          e.remoteRef(ref)
          e.saveRef(ref, false)
        }
      } catch {
        if (!dead) {
          lastRoom.forget(id)
          setError(true)
        }
      }
    })()
    return () => {
      dead = true
      disconnect()
      sock?.close()
      eng?.destroy()
    }
  }, [id])

  // Logging in, out or renaming: act as the new player from here on, and tell the room.
  useEffect(() => {
    if (playerId) learn([{ id: playerId, name: name || '' }])
    if (!engine) return
    engine.user = playerId
    engine.userName = name
    engine.invalidate()
  }, [engine, playerId, name, learn])
  const sock = session?.sock
  const passphraseNow = player?.passphrase
  useEffect(() => sock?.hello(), [sock, passphraseNow])
  // Opening a private jigsaw's link (or logging in while here) adds it to this player's list.
  const isPrivate = !!session?.room.private
  useEffect(() => {
    if (isPrivate && player?.passphrase) api.join(id, player.passphrase).catch(() => {})
  }, [id, isPrivate, player?.passphrase])

  useEffect(() => {
    engine?.setColors(readColors())
  }, [engine, theme])

  useEffect(() => {
    store.set('panMode', panMode ? '1' : '0')
    if (!engine) return
    engine.setPanMode(panMode)
  }, [engine, panMode])

  useEffect(() => {
    engine?.setDrawMode(drawMode)
  }, [engine, drawMode])

  useOverlay(drawMode, () => setDrawMode(false), { keepTyping: true })

  useEffect(() => {
    store.set('split', split ? '1' : '0')
    store.set('splitPanes', String(splitPanes))
    if (!engine) return
    engine.setLayout(split ? splitPanes : 1)
  }, [engine, split, splitPanes])

  useEffect(() => {
    if (error) navigate(paths.rooms)
  }, [error])

  // Off to the jigsaws page: the table zooms out under it.
  useEffect(() => {
    if (!engine || !leaving) return
    engine.zoomAway()
  }, [engine, leaving])
  // Opened from the jigsaws page: once the table is ready it says so, and as the page then fades
  // (arriving goes false) the table zooms in to all of it, centred.
  const zoomPending = useRef(false)
  useEffect(() => {
    if (arriving) {
      if (engine) {
        zoomPending.current = true
        onArrived?.()
      } else if (gpuError) onArrived?.()
      return
    }
    if (!engine || !zoomPending.current) return
    zoomPending.current = false
    engine.arrive()
  }, [arriving, engine, gpuError, onArrived])

  // Other players only see our cursor while we're playing, not while a dialog is open.
  useEffect(() => {
    if (!engine) return
    const check = () => engine.setAway(overlays.modalOpen())
    check()
    return overlays.watch(check)
  }, [engine])

  // H help, V view mode, N note, T tray, I image, Q the picture as a map, + and - zoom, C fits to screen, F fullscreen. Arrow keys and WASD pan (see the engine). New notes, trays and images go under the pointer when it's on the table.
  useEffect(() => {
    if (!engine) return
    const key = (e: KeyboardEvent) => {
      if (!isPlainKey(e) || isTyping(e)) return
      // While holding pieces, the keys are the engine's, and windows keep the keyboard.
      if (engine.drag || overlays.modalOpen()) return
      // Where the pointer is, if it's on the table and not over the toolbars.
      const p = engine.pointerClient()
      const over = p && onTable(...p) ? p : null
      const there = over ? engine.clientToWorld(...over) : undefined
      const k = e.key.toLowerCase()
      if (k === 'h') openSettings.current?.('help')
      else if (k === 'v') setPanMode((v) => !v)
      else if (k === 'x') setSplit((v) => !v)
      else if (k === 'e') setDrawMode((v) => !v)
      else if (k === 'n') createNote.current?.(over?.[0] ?? null, over?.[1] ?? null)
      else if (k === 't') engine.addTray(there)
      else if (k === 'i') engine.addRef(there)
      else if (k === 'q') setMap(true)
      else if (k === '+' || k === '=') engine.zoomBy(1.4)
      else if (k === '-' || k === '_') engine.zoomBy(1 / 1.4)
      else if (k === 'c') engine.fit()
      else if (k === 'f' && canFullscreen()) toggleFullscreen()
      else if (k === 'p') openPlayers.current?.()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [engine])

  // Ctrl+F (Cmd+F on a Mac) opens and closes the search of the notes and named trays, instead of the page's.
  useEffect(() => {
    if (!engine) return
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return
      // Another window keeps the keyboard.
      if (overlays.modalOpen() && !search) return
      e.preventDefault()
      setMenu(null)
      setSearch((v) => !v)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [engine, search])

  // The toolbar: all jigsaws and settings on the top left, the play tools at the top middle in one
  // bar, in two groups split by lines, and the players on the top right.
  const nav = (
    <>
      <button className="icon-btn" onClick={() => navigate(paths.rooms)} aria-label="All jigsaws" data-tip="All jigsaws">
        <Rooms />
      </button>
      <Settings privateRoom={isPrivate} help openRef={openSettings} />
    </>
  )
  const play = session && engine && (
    <>
      <button
        className={`icon-btn view-btn${panMode ? ' on' : ''}`}
        onClick={() => setPanMode((v) => !v)}
        aria-pressed={panMode}
        aria-label="View mode"
        aria-keyshortcuts="V"
        data-tip={panMode ? 'View mode on: dragging moves the table' : 'View mode: drag to move the table'}
        data-key="V"
      >
        <Hand />
      </button>
      <button
        className={`icon-btn draw-btn${drawMode ? ' on' : ''}`}
        onClick={() => setDrawMode((v) => !v)}
        aria-pressed={drawMode}
        aria-label="Draw"
        aria-keyshortcuts="E"
        data-tip={drawMode ? 'Draw on: drag to draw, it fades away after a few seconds' : 'Draw: lines that fade away'}
        data-key="E"
      >
        <Pencil />
      </button>
      <Reactions engine={engine} sock={session.sock} />
      <SplitButton
        on={split}
        panes={splitPanes}
        onToggle={() => setSplit((v) => !v)}
        onPanes={(n) => {
          setSplitPanes(n)
          setSplit(true)
        }}
      />
      <span className="bar-sep" />
      <TrayButton engine={engine} />
      <button
        className="icon-btn"
        onClick={() => engine.addRef()}
        aria-label="Reference image"
        aria-keyshortcuts="I"
        data-tip="Add the reference image to the board"
        data-key="I"
      >
        <Picture />
      </button>
      <NoteButton createRef={createNote} />
    </>
  )
  // The players by rank, for the podium and the picture to share.
  // With this player's seconds not saved yet.
  const ranked = (podiumShown || shareShown) && rankPlayers({ stats, times: playerId ? { ...times, [playerId]: myTime.get() } : times, nameOf })
  return (
    <div
      className={`room${panMode ? ' pan-mode' : ''}${split && engine ? ` split split-${splitPanes}` : ''}${idle ? ' idle' : ''}${leaving ? ' leaving' : ''}`}
    >
      <canvas ref={canvas} className="board" tabIndex={0} />
      <div ref={tip} className="tip" />
      {!engine && (
        <div className="center">
          {gpuError ? (
            <p className="gpu-error">
              This browser can't draw the jigsaw: it needs WebGPU, which didn't start here ({gpuError}). Try another browser,
              or turn on hardware acceleration in this one.
            </p>
          ) : (
            <span className="spin" />
          )}
        </div>
      )}
      {engine && split && <div className="split-line" />}
      {engine && split && splitPanes > 2 && <div className="split-line across" />}
      {session && (
        <div className="notes-clip">
          <NotesLayer
            engine={session.engine}
            sock={session.sock}
            room={session.room}
            me={playerId}
            nameOf={nameOf}
            createRef={createNote}
          />
        </div>
      )}
      <canvas ref={cursors} className="cursors" />
      <div className="float tl" onContextMenu={noMenu}>
        {nav}
      </div>
      {play && (
        <div className="float play-tools tc" onContextMenu={noMenu}>
          {play}
        </div>
      )}
      {engine && (
        <div className="tr" onContextMenu={noMenu}>
          <Players stats={stats} times={times} myTime={myTime} me={playerId} owner={session?.room.owner} nameOf={nameOf} online={online} seen={seen} openRef={openPlayers} onAccount={openAccount} />
        </div>
      )}
      {menu && engine && <ContextMenu key={`${menu.kind}:${menu.id}:${menu.x}:${menu.y}`} engine={engine} at={menu} onClose={closeMenu} />}
      {basicsShown && <BasicsDialog onClose={closeBasics} onAll={allControls} closing={basicsClosing} />}
      {party && <Celebration key={partyKey} onDone={endParty} />}
      {import.meta.env.DEV && devMenu && engine && (
        <DevMenu
          onConnect={() => engine.devConnect()}
          onRestart={() => {
            engine.devRestart()
            roomOnce('celebrated', id).reset()
            setDone(false)
            setParty(false)
            setPodium(false)
          }}
          onSolve={() => {
            roomOnce('celebrated', id).reset()
            engine.devSolve()
          }}
          onCelebrate={() => {
            engine.fit()
            celebrate()
          }}
        />
      )}
      {engine && done && (
        <button className="podium-btn" onClick={() => setPodium(true)} aria-label="Podium" data-tip="Top players">
          <PodiumIcon />
        </button>
      )}
      {engine && done && (
        <button className="share-btn" onClick={() => setSharing(true)} aria-label="Share" data-tip="Share a picture or a timelapse">
          <Share />
        </button>
      )}
      {podiumShown && ranked && (
        <Podium
          ranked={ranked}
          closing={podiumClosing}
          onClose={closePodium}
          onShare={() => setSharing(true)}
        />
      )}
      {engine && shareShown && ranked && (
        <ShareDialog
          engine={engine}
          ranked={ranked}
          onClose={closeShare}
          closing={shareClosing}
        />
      )}
      {engine && searchShown && (
        <Search
          engine={engine}
          nameOf={nameOf}
          closing={searchClosing}
          onClose={closeSearch}
        />
      )}
      {engine && mapShown && (
        <PictureMap roomId={id} src={api.imageUrl(id)} color={cursorColor(playerId || 'me')} closing={mapClosing} onClose={closeMap} />
      )}
    </div>
  )
}
