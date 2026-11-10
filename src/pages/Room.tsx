import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { api } from '../lib/api.ts'
import type { NoteReaction, NoteReply, NoteRow, RoomSocket, TimeRow } from '../lib/api.ts'
import { Engine, warmSprites } from '../lib/engine.ts'
import { navigate, store, useApp } from '../App.tsx'
import {
  Hand,
  Pencil,
  Picture,
  Redo,
  Rooms,
  Share,
  Undo,
} from '../components/icons.tsx'
import Settings from '../components/Settings.tsx'
import type { OpenSettings } from '../components/Settings.tsx'
import Players, { rankPlayers } from '../components/Players.tsx'
import type { NameOf, Stats } from '../components/Players.tsx'
import Podium, { PodiumIcon } from '../components/Podium.tsx'
import Reactions from '../components/Reactions.tsx'
import type { ReactMessage } from '../components/Reactions.tsx'
import Timers from '../components/Timers.tsx'
import type { Times } from '../components/Timers.tsx'
import Celebration from '../components/Celebration.tsx'
import DevMenu from '../components/DevMenu.tsx'
import { useLinger } from '../lib/linger.ts'
import { NoteButton, NotesLayer } from '../components/Notes.tsx'
import type { CreateNote, NoteMessage } from '../components/Notes.tsx'
import ContextMenu from '../components/ContextMenu.tsx'
import type { MenuAt } from '../components/ContextMenu.tsx'
import { TrayButton } from '../components/Trays.tsx'
import SplitButton from '../components/SplitButton.tsx'
import type { SplitPanes } from '../components/SplitButton.tsx'
import ShareDialog from '../components/ShareDialog.tsx'
import { playSnap } from '../lib/sound.ts'
import { canFullscreen, toggleFullscreen, useNotch } from '../lib/fullscreen.ts'

// No browser menu on a right click in the bar along the top, except in a text field.
const noMenu = (e: MouseEvent) => {
  if (!(e.target as Element).closest('input, textarea, [contenteditable="true"]')) e.preventDefault()
}

// Undo and redo shortcuts as the platform writes them.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = MAC ? '⌘' : 'Ctrl+'
const REDO_KEY = MAC ? '⇧Z' : 'Y'

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
    const busy = () => over || touch || document.querySelector('.modal-bg, .players-menu, .float :focus-visible, .players :focus-visible')
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
function takeLocalRefs(id: string) {
  try {
    const list = JSON.parse(store.get(`refs:${id}`)!)
    store.set(`refs:${id}`, null)
    return Array.isArray(list) ? list.filter((r) => r && r.id && r.w > 0) : []
  } catch {
    return []
  }
}

// What the room needs once the jigsaw is loaded, besides the engine.
interface RoomData {
  notes: NoteRow[]
  noteReactions: NoteReaction[]
  noteReplies: NoteReply[]
  times: TimeRow[]
  private: boolean
  owner: string | null
}

// A player as the room learns their name: from the room, the socket or this browser.
type Named = { id?: string | null; name?: string | null } | null | undefined

interface RoomProps {
  id: string
}

export default function Room({ id }: RoomProps) {
  const { name, player, playerId, theme, ensureName, requireName, setDialog, devMenu } = useApp()
  const me = useRef(playerId)
  me.current = playerId
  const sockRef = useRef<RoomSocket | null>(null)
  // Player names by id. Names aren't unique, so everything is stored by player id and looked up here.
  const names = useRef(new Map<string, string>())
  const [, setNamesVer] = useState(0)
  const learn = useCallback((list: Named[] | null | undefined) => {
    for (const p of list || []) if (p?.id) names.current.set(p.id, String(p.name || '').slice(0, 32))
    setNamesVer((v) => v + 1)
  }, [])
  const nameOf: NameOf = useCallback((pid) => (pid ? names.current.get(pid) || 'Someone' : ''), [])
  const canvas = useRef<HTMLCanvasElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const cursors = useRef<HTMLCanvasElement>(null)
  const [engine, setEngine] = useState<Engine | null>(null)
  const [data, setData] = useState<RoomData | null>(null)
  const [done, setDone] = useState(false)
  const timeBus = useRef<((msg: TimeRow) => void) | null>(null)
  const noteBus = useRef<((msg: NoteMessage) => void) | null>(null)
  const reactBus = useRef<((msg: ReactMessage) => void) | null>(null)
  const createNote = useRef<CreateNote | null>(null)
  const openPlayers = useRef<(() => void) | null>(null)
  // Escape clears these, so it doesn't open the settings then.
  const escTaken = useCallback(
    () => !!engine && !!(engine.drag || engine.trim || engine.selCount || engine.refSel || engine.traySel || engine.selRefs.size || engine.selNotes.size),
    [engine],
  )
  const [stats, setStats] = useState<Stats>(() => new Map())
  const [times, setTimes] = useState<Times>({})
  // Player ids in the room right now, and when the others were last here (ms by id).
  const [online, setOnline] = useState(() => new Set<string>())
  const [seen, setSeen] = useState<Record<string, number>>({})
  const openSettings = useRef<OpenSettings | null>(null)
  const openAccount = useCallback(() => openSettings.current?.('account'), [])
  // How to play opens by itself the first time this player opens each jigsaw.
  useEffect(() => {
    if (store.get(`help:${id}`)) return
    store.set(`help:${id}`, '1')
    openSettings.current?.('help')
  }, [id])
  const onTimes = useCallback((t: Times) => setTimes(t), [])
  const notch = useNotch()
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
  const splitSet = useRef(false)
  // Draw mode: dragging draws strokes that fade away after a few seconds, for everyone to see.
  const [drawMode, setDrawMode] = useState(false)
  const [hist, setHist] = useState({ undo: false, redo: false })
  const [menu, setMenu] = useState<MenuAt | null>(null)
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
        store.set('lastRoom', id)
        eng = new Engine(canvas.current!, {
          room,
          image,
          pieces: room.pieces,
          refs: room.refs || [],
          trays: room.trays || [],
          overlay: cursors.current,
          user: playerId,
          userName: name,
          nameOf,
          guard: ensureName,
          tooltip: tip.current!,
          send: (msg) => sock?.send(msg),
          onRef: (ref, live) => api.saveRef(id, ref, live),
          onRefDelete: (refId) => api.deleteRef(id, refId),
          // What's in a tray goes with the pieces' moves, so the tray is sent without its list.
          onTray: (tray, live) => api.saveTray(id, { ...tray, pieces: undefined }, live),
          onTrayDelete: (trayId) => api.deleteTray(id, trayId),
          onStats: () => setStats(eng!.contributors()),
          onSnap: playSnap,
          onMenu: (x, y, kind, id, opts) => setMenu({ x, y, kind, id, rename: !!opts?.rename }),
          onHistory: setHist,
          onComplete: () => {
            setDone(true)
            // Celebrate once per player and jigsaw, whoever placed the last piece.
            if (store.get(`celebrated:${id}`)) return
            store.set(`celebrated:${id}`, '1')
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
        learn(room.players)
        setOnline(new Set(room.online || []))
        setSeen(room.seen || {})
        eng.setColors(readColors())
        setStats(eng.contributors())
        setDone(eng.isComplete())
        // Already finished before this player opened it: nothing left to celebrate.
        if (eng.isComplete()) store.set(`celebrated:${id}`, '1')
        setData({ notes: room.notes || [], noteReactions: room.noteReactions || [], noteReplies: room.noteReplies || [], times: room.times || [], private: !!room.private, owner: room.owner })
        setEngine(eng)
        sock = sockRef.current = api.socket(id, {
          player: () => me.current,
          onMessage: (msg) => {
            if (msg.type === 'deleted') {
              if (store.get('lastRoom') === id) store.set('lastRoom', null)
              navigate('/rooms')
            }
            else if (msg.type === 'player') {
              learn([msg.player])
              eng!.invalidate()
            } else if (msg.type === 'presence') {
              setOnline(new Set(msg.online || []))
              setSeen((s) => ({ ...s, ...msg.seen }))
            } else if (msg.type === 'time') timeBus.current?.(msg)
            else if (msg.type === 'note' || msg.type === 'note-delete' || msg.type === 'note-react' || msg.type === 'note-reply' || msg.type === 'note-reply-delete') noteBus.current?.(msg)
            else if (msg.type === 'react') reactBus.current?.(msg)
            else if (msg.type === 'ref') eng!.remoteRef(msg.ref)
            else if (msg.type === 'ref-delete') eng!.removeRef(msg.id, true)
            else if (msg.type === 'tray') eng!.remoteTray(msg.tray, msg.live, msg.client)
            else if (msg.type === 'tray-delete') eng!.removeTray(msg.id, true)
            else eng!.remoteMessage(msg)
          },
          onOpen: async (reconnect) => {
            if (!reconnect) return
            const fresh = await api.room(id).catch(() => null)
            if (!fresh || dead) return
            eng!.resync(fresh.pieces)
            eng!.checkGroups()
            eng!.setRefs(fresh.refs || [])
            eng!.setTrays(fresh.trays || [])
            learn(fresh.players)
            setOnline(new Set(fresh.online || []))
            setSeen(fresh.seen || {})
            noteBus.current?.({ type: 'notes-reset', notes: fresh.notes || [], reactions: fresh.noteReactions || [], replies: fresh.noteReplies || [] })
          },
        })
        // Pieces left out of line in their group (see Engine.repair) are put right, now that it can say so.
        eng.checkGroups()
        for (const ref of takeLocalRefs(id)) {
          eng.remoteRef(ref)
          api.saveRef(id, ref)
        }
      } catch {
        if (!dead) {
          if (store.get('lastRoom') === id) store.set('lastRoom', null)
          setError(true)
        }
      }
    })()
    return () => {
      dead = true
      sock?.close()
      sockRef.current = null
      eng?.destroy()
    }
  }, [id])

  // Logging in, out or renaming: act as the new player from here on, and tell the room.
  useEffect(() => {
    if (playerId) learn([{ id: playerId, name }])
    if (!engine) return
    engine.user = playerId
    engine.userName = name
    engine.invalidate()
  }, [engine, playerId, name, learn])
  useEffect(() => {
    if (engine) sockRef.current?.send({ type: 'hello', player: playerId })
  }, [engine, playerId])
  // Opening a private jigsaw's link (or logging in while here) adds it to this player's list.
  useEffect(() => {
    if (data?.private && player?.passphrase) api.join(id, player.passphrase).catch(() => {})
  }, [id, data?.private, player?.passphrase])

  useEffect(() => {
    engine?.setColors(readColors())
  }, [engine, theme])

  useEffect(() => {
    store.set('panMode', panMode ? '1' : '0')
    if (!engine) return
    engine.panMode = panMode
    engine.canvas.style.cursor = panMode ? 'grab' : ''
    engine.setHighlight(null)
  }, [engine, panMode])

  useEffect(() => {
    engine?.setDrawMode(drawMode)
  }, [engine, drawMode])

  // Escape stops drawing.
  useEffect(() => {
    if (!drawMode) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setDrawMode(false)
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [drawMode])

  useEffect(() => {
    store.set('split', split ? '1' : '0')
    store.set('splitPanes', String(splitPanes))
    if (!engine) return
    // On loading, the other panes' views come back as they were.
    engine.setLayout(split ? splitPanes : 1, !splitSet.current)
    splitSet.current = true
  }, [engine, split, splitPanes])

  useEffect(() => {
    if (error) navigate('/rooms')
  }, [error])

  // Other players only see our cursor while we're playing, not while a dialog is open.
  useEffect(() => {
    if (!engine) return
    const check = () => engine.setAway(!!document.querySelector('.modal-bg'))
    const mo = new MutationObserver(check)
    mo.observe(document.body, { childList: true, subtree: true })
    check()
    return () => mo.disconnect()
  }, [engine])

  // H help, V view mode, N note, T tray, I image, + and - zoom, C fits to screen, F fullscreen. Arrow keys and WASD pan (see the engine). New notes, trays and images go under the pointer when it's on the table.
  useEffect(() => {
    if (!engine) return
    const key = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable]')) return
      // While holding pieces, G gathers them (see the engine), and dialogs keep the keyboard.
      if (engine.drag || document.querySelector('.modal-bg')) return
      const r = engine.canvas.getBoundingClientRect()
      const p = engine.pointerAt
      const el = p && document.elementFromPoint(p[0] + engine.ox + r.left, p[1] + engine.oy + r.top)
      const over = el && !el.closest('.float, .players') ? p : null
      const k = e.key.toLowerCase()
      if (k === 'h') openSettings.current?.('help')
      else if (k === 'v') setPanMode((v) => !v)
      else if (k === 'x') setSplit((v) => !v)
      else if (k === 'e') setDrawMode((v) => !v)
      else if (k === 'n') createNote.current?.(over ? over[0] + engine.ox + r.left : null, over ? over[1] + engine.oy + r.top : null)
      else if (k === 't') (over ? engine.addTray(...over) : engine.addTray())
      else if (k === 'i') (over ? engine.addRef(...over) : engine.addRef())
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

  // The toolbar: all jigsaws and settings on the top left, the play tools at the top middle in one
  // bar, in three groups split by lines, and the players on the top right.
  const nav = (
    <>
      <button className="icon-btn" onClick={() => setDialog('rooms')} aria-label="All jigsaws" data-tip="All jigsaws">
        <Rooms />
      </button>
      {engine && <Timers roomId={id} me={playerId} initial={data!.times} busRef={timeBus} stopped={done} onTimes={onTimes} />}
      <Settings privateRoom={!!data?.private} help escTaken={escTaken} openRef={openSettings} />
    </>
  )
  const play = engine && (
    <>
      <button className="icon-btn" onClick={() => engine.undo()} disabled={!hist.undo} aria-label="Undo" aria-keyshortcuts="Control+Z Meta+Z" data-tip="Undo" data-key={`${MOD}Z`}>
        <Undo />
      </button>
      <button className="icon-btn" onClick={() => engine.redo()} disabled={!hist.redo} aria-label="Redo" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" data-tip="Redo" data-key={`${MOD}${REDO_KEY}`}>
        <Redo />
      </button>
      <span className="bar-sep" />
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
      <SplitButton
        on={split}
        panes={splitPanes}
        onToggle={() => setSplit((v) => !v)}
        onPanes={(n) => {
          setSplitPanes(n)
          setSplit(true)
        }}
       
      />
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
      <Reactions engine={engine} busRef={reactBus} />
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
  return (
    <div
      className={`room${panMode ? ' pan-mode' : ''}${split && engine ? ` split split-${splitPanes}` : ''}${idle ? ' idle' : ''}${notch ? ' notch' : ''}`}
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
      {engine && (
        <div className="notes-clip">
          <NotesLayer
            engine={engine}
            roomId={id}
            me={playerId}
            nameOf={nameOf}
            initial={data!.notes}
            initialReactions={data!.noteReactions}
            initialReplies={data!.noteReplies}
            busRef={noteBus}
            ensureName={ensureName}
            requireName={requireName}
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
          <Players stats={stats} times={times} me={playerId} owner={data?.owner} nameOf={nameOf} online={online} seen={seen} openRef={openPlayers} onAccount={openAccount} />
        </div>
      )}
      {menu && engine && <ContextMenu key={`${menu.kind}:${menu.id}:${menu.x}:${menu.y}`} engine={engine} at={menu} onClose={closeMenu} />}
      {party && <Celebration key={partyKey} onDone={endParty} />}
      {import.meta.env.DEV && devMenu && engine && (
        <DevMenu
          onConnect={() => engine.devConnect()}
          onRestart={() => {
            engine.devRestart()
            store.set(`celebrated:${id}`, null)
            setDone(false)
            setParty(false)
            setPodium(false)
          }}
          onSolve={() => {
            // Celebrate as if for the first time.
            store.set(`celebrated:${id}`, null)
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
      {podiumShown && (
        <Podium
          ranked={rankPlayers({ stats, times, nameOf })}
          closing={podiumClosing}
          onClose={closePodium}
          covered={sharing}
          onShare={() => setSharing(true)}
        />
      )}
      {engine && shareShown && (
        <ShareDialog
          engine={engine}
          ranked={rankPlayers({ stats, times, nameOf })}
          onClose={closeShare}
          closing={shareClosing}
        />
      )}
    </div>
  )
}
