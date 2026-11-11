import { useCallback, useEffect, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useApp } from '../lib/app.ts'
import {
  Changelog as ChangelogIcon,
  External,
  Gear,
  GitHub,
  Help,
  Lock,
  Moon,
  Sound,
  User,
  Wrench,
} from './icons.tsx'
import Changelog from './Changelog.tsx'
import Dialog from './Dialog.tsx'
import { AccountPanel } from './AccountPanel.tsx'
import HelpPanel from './Help.tsx'
import { useLinger } from '../lib/linger.ts'
import PrivateRoom from './PrivateRoom.tsx'
import { isPlainKey, useEscapeFallback } from '../lib/overlays.ts'

// Header button that opens the settings dialog, with its panels in a list down the side:
// general (dark mode, sounds, changelog and source link), account, and in a jigsaw (help) how to play.
// In development (npm run dev) general also has the dev menu switch.
// In a private jigsaw general also has a button that shows its link.
// openRef.current(panel) opens it on that panel, as H does with how to play (see Room).
// Escape opens it when nothing else takes it (see overlays.ts). The dialog closes on Escape.
type SettingsPanel = 'general' | 'account' | 'help'
// What Settings puts in openRef: opens the dialog on a panel.
export type OpenSettings = (panel: SettingsPanel) => void

interface SettingsProps {
  privateRoom?: boolean
  help?: boolean
  openRef?: RefObject<OpenSettings | null>
}

interface PanelRow {
  key: SettingsPanel
  title: string
  icon: ReactNode
  shortcut?: string
}

export default function Settings({ privateRoom = false, help = false, openRef }: SettingsProps) {
  const { theme, toggleTheme, sound, toggleSound, devMenu, toggleDevMenu, roomId } = useApp()
  const [sharing, setSharing] = useState(false)
  const closeSharing = useCallback(() => setSharing(false), [])
  // Null when closed. The last panel stays up while the dialog closes.
  const [panel, setPanel] = useState<SettingsPanel | null>(null)
  const close = useCallback(() => setPanel(null), [])
  const [shown, closing] = useLinger(panel)
  const [changelog, setChangelog] = useState(false)
  const closeChangelog = useCallback(() => setChangelog(false), [])
  const [changelogShown, changelogClosing] = useLinger(changelog)
  const dark = theme === 'dark'

  const panels = ([
    { key: 'general', title: 'General', icon: <Gear /> },
    { key: 'account', title: 'Account', icon: <User /> },
    help && { key: 'help', title: 'How to play', icon: <Help />, shortcut: 'H' },
  ] as (PanelRow | false)[]).filter((p) => !!p)

  useEffect(() => {
    if (!openRef) return
    openRef.current = setPanel
    return () => {
      openRef.current = null
    }
  }, [openRef])

  useEscapeFallback((e) => {
    if (e.repeat || e.shiftKey) return false
    setPanel('general')
    return true
  }, 0)

  // While it's open, H goes to how to play, and from there closes it.
  const helpKey = (e: KeyboardEvent) => {
    if (!help || e.key.toLowerCase() !== 'h' || !isPlainKey(e)) return
    e.preventDefault()
    setPanel((p) => (p === 'help' ? null : 'help'))
  }

  // Closes the dialog, then opens what the row is for.
  const then = (fn: () => void) => () => {
    setPanel(null)
    fn()
  }

  return (
    <span className="settings">
      <button
        className={`icon-btn${panel ? ' on' : ''}`}
        onClick={() => setPanel((p) => (p ? null : 'general'))}
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-keyshortcuts="Escape"
        data-tip="Settings"
        data-key="Esc"
      >
        <Gear />
      </button>
      {shown && (
        <Dialog title="Settings" className="settings-dialog" bodyClass="settings-body" onClose={close} closing={closing} onKey={helpKey}>
          <nav className="settings-nav" aria-label="Settings">
            {panels.map((p) => (
              <button
                key={p.key}
                className={`settings-row${p.key === shown ? ' on' : ''}`}
                aria-current={p.key === shown ? 'page' : undefined}
                aria-keyshortcuts={p.shortcut}
                onClick={() => setPanel(p.key)}
              >
                {p.icon}
                <span>{p.title}</span>
                {p.shortcut && <kbd className="settings-key">{p.shortcut}</kbd>}
              </button>
            ))}
          </nav>
          <div className={`settings-panel settings-${shown}`} key={shown}>
            {shown === 'general' && (
              <>
                <section className="settings-section" aria-labelledby="settings-prefs">
                  <h2 className="label" id="settings-prefs">Preferences</h2>
                  <button className="settings-row" role="switch" aria-checked={dark} onClick={toggleTheme}>
                    <Moon />
                    <span>Dark mode</span>
                    <span className={`switch${dark ? ' on' : ''}`} aria-hidden="true" />
                  </button>
                  <button className="settings-row" role="switch" aria-checked={sound} onClick={toggleSound}>
                    <Sound />
                    <span>Sounds</span>
                    <span className={`switch${sound ? ' on' : ''}`} aria-hidden="true" />
                  </button>
                  {import.meta.env.DEV && (
                    <button className="settings-row" role="switch" aria-checked={devMenu} onClick={toggleDevMenu}>
                      <Wrench />
                      <span>Dev menu</span>
                      <span className={`switch${devMenu ? ' on' : ''}`} aria-hidden="true" />
                    </button>
                  )}
                </section>
                {privateRoom && (
                  <section className="settings-section" aria-labelledby="settings-jigsaw">
                    <h2 className="label" id="settings-jigsaw">This jigsaw</h2>
                    <button className="settings-row" onClick={then(() => setSharing(true))}>
                      <Lock />
                      <span>Private room</span>
                    </button>
                  </section>
                )}
                <section className="settings-section" aria-labelledby="settings-about">
                  <h2 className="label" id="settings-about">About</h2>
                  <button className="settings-row" onClick={then(() => setChangelog(true))}>
                    <ChangelogIcon />
                    <span>Changelog</span>
                  </button>
                  <a
                    className="settings-row"
                    href="https://github.com/mebn/jigsaw"
                    title="Opens in a new tab"
                    aria-label="Source on GitHub (opens in a new tab)"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <GitHub />
                    <span>Source on GitHub</span>
                    <External className="settings-ext" />
                  </a>
                </section>
              </>
            )}
            {shown === 'account' && <AccountPanel onClose={close} />}
            {shown === 'help' && <HelpPanel />}
          </div>
        </Dialog>
      )}
      {sharing && roomId && <PrivateRoom id={roomId} onClose={closeSharing} />}
      {changelogShown && <Changelog onClose={closeChangelog} closing={changelogClosing} />}
    </span>
  )
}
