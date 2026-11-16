import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import { api } from '../lib/api.ts'
import { LIMITS } from '../../shared/protocol.ts'
import { useApp } from '../lib/app.ts'
import type { PlayerLogin as Player } from '../../shared/protocol.ts'
import { EmailForm, looksLikePassphrase, Passphrase, PassphraseWarning } from './Account.tsx'
import { Clock, Crown, Key, Logout, Piece, User } from './icons.tsx'
import { formatDuration, plural } from '../lib/format.ts'
import Confirm from './Confirm.tsx'
import { Dot } from './Players.tsx'
import { avatarFromFile } from '../lib/avatars.ts'
import TextField from './TextField.tsx'

// Where a phone can reach this page; noLan when this machine isn't on a network.
interface PhoneOrigin {
  origin: string
  noLan?: boolean
}

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// Where a phone can open this page. "localhost" means nothing to a phone, so there it is this
// machine's address on the network, asked for once, as soon as the app loads: asked later, the
// request can wait behind a jigsaw's images. noLan when the machine isn't on a network.
const phoneOrigin: Promise<PhoneOrigin> | null = LOCAL.has(location.hostname)
  ? api
      .lan()
      .then(({ address }) =>
        address ? { origin: `${location.protocol}//${address}${location.port ? `:${location.port}` : ''}` } : { origin: location.origin, noLan: true },
      )
      .catch(() => ({ origin: location.origin }))
  : null
let phoneKnown: PhoneOrigin | null = phoneOrigin ? null : { origin: location.origin }
phoneOrigin?.then((v) => (phoneKnown = v))

// The player's name, shown on their cursor, notes and connected pieces. Saved on Enter or leaving the field.
function NameField() {
  const { name, setName } = useApp()
  const [value, setValue] = useState(name || '')
  useEffect(() => setValue(name || ''), [name])
  const save = () => {
    const v = value.trim().slice(0, LIMITS.name)
    if (v && v !== name) setName(v).catch(() => setValue(name || ''))
    else setValue(name || '')
  }
  return (
    <>
      <TextField
        value={value}
        maxLength={LIMITS.name}
        placeholder="Your name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && !looksLikePassphrase(value) && e.currentTarget.blur()}
        aria-label="Name"
        title="Your name"
      />
      <PassphraseWarning value={value} />
    </>
  )
}

// The QR code as one SVG path, a square per dark module, with the usual quiet zone around it.
function QrCode({ text }: { text: string }) {
  const { d, size } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    // A rectangle per run of dark modules in a row, rather than a square per module.
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue
        let w = 1
        while (c + w < n && qr.isDark(r, c + w)) w++
        d += `M${c + 4} ${r + 4}h${w}v1h-${w}z`
        c += w - 1
      }
    }
    return { d, size: n + 8 }
  }, [text])
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label="QR code">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

// A QR code that opens this page on a phone, logged in as this player (if logged in).
function PhoneLink({ player }: { player: Player | null }) {
  // The link opens the page this is on: a jigsaw, or the jigsaws page.
  const { roomId } = useApp()
  const [known, setKnown] = useState(phoneKnown)

  useEffect(() => {
    if (!known) phoneOrigin!.then(setKnown)
  }, [known])
  const origin = known?.origin
  const noLan = known?.noLan

  const url = origin && `${origin}${location.pathname}`
  const link = url && (player ? `${url}#login=${encodeURIComponent(player.passphrase)}` : url)

  return (
    <>
      <p className="modal-text">
        Scan to open {roomId ? 'this jigsaw' : 'the jigsaws page'} on your phone{player ? ', logged in as you' : ''}.
      </p>
      {noLan && <p className="modal-error">This computer isn't on a network, so a phone may not be able to reach it.</p>}
      <div className="qr-wrap">{link ? <QrCode text={link} /> : <span className="spin" />}</div>
    </>
  )
}

// Your profile picture, shown in your circle everywhere: pick a picture (it's cut to a square from
// its middle and made small before it's sent), or take it away.
function AvatarField({ player }: { player: Player }) {
  const { setAvatar } = useApp()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (image: string | null) => {
    setBusy(true)
    setError('')
    try {
      await setAvatar(image)
    } catch (e) {
      setError((e as Error).message || "Couldn't save the picture, try again.")
    } finally {
      setBusy(false)
    }
  }
  const pick = async (file: File | undefined) => {
    if (!file) return
    try {
      await save(await avatarFromFile(file))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="avatar-field">
      <Dot p={player} here={false} big />
      <div className="avatar-actions">
        <div className="row">
          <button className="secondary small" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <span className="spin" /> : player.avatar ? 'Change picture' : 'Choose picture'}
          </button>
          {!!player.avatar && (
            <button className="secondary small" disabled={busy} onClick={() => save(null)}>
              Remove
            </button>
          )}
        </div>
        <p className="modal-note">A JPEG, PNG, WebP or other picture. It's cut to a square from the middle.</p>
        {error && <p className="modal-error">{error}</p>}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          pick(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

// What this player has done in all their jigsaws together: jigsaws made, connections made and time
// spent, added up from their profile (see api.player()).
function Stats({ player }: { player: Player }) {
  const [stats, setStats] = useState<{ made: number; connections: number; seconds: number } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let dead = false
    setStats(null)
    setFailed(false)
    api
      .player(player.id, player.passphrase)
      .then((d) => {
        if (dead) return
        setStats({
          made: d.rooms.filter((r) => r.owner === player.id).length,
          connections: d.rooms.reduce((t, r) => t + r.connections, 0),
          seconds: d.rooms.reduce((t, r) => t + r.time, 0),
        })
      })
      .catch(() => !dead && setFailed(true))
    return () => {
      dead = true
    }
  }, [player.id, player.passphrase])

  if (failed) return <p className="modal-note">Couldn't load your stats.</p>
  if (!stats) return <span className="spin" aria-label="Loading stats" />
  return (
    <div className="profile-stats">
      <span className="profile-stat">
        <Crown />
        {plural(stats.made, 'jigsaw')} made
      </span>
      <span className="profile-stat">
        <Piece />
        {plural(stats.connections, 'connection')} made
      </span>
      <span className="profile-stat">
        <Clock />
        {formatDuration(stats.seconds)} spent
      </span>
    </div>
  )
}

// Asks before logging out, showing how to log back in. onDone runs either way.
function LogoutConfirm({ onDone }: { onDone: () => void }) {
  const { player, logout } = useApp()
  if (!player) return null
  return (
    <Confirm
      title={`Log out ${player.name}?`}
      text={
        player.email
          ? `You can log back in with ${player.email} and your password.`
          : 'You can log back in with your passphrase:'
      }
      action="Log out"
      danger
      onCancel={onDone}
      onConfirm={() => {
        logout()
        onDone()
      }}
    >
      {!player.email && <Passphrase value={player.passphrase} />}
    </Confirm>
  )
}

// Everything about who you are: name, passphrase, and a QR code to carry on on your phone.
// onClose closes what it is in, before the name or login window opens.
export function AccountPanel({ onClose }: { onClose: () => void }) {
  const { player, requireName, openLogin, switchToEmail } = useApp()
  const [shown, setShown] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const stay = useCallback(() => setLeaving(false), [])

  return (
    <>
      {player ? (
        <>
          <section className="field">
            <h2 className="label">Profile picture</h2>
            <AvatarField player={player} />
          </section>
          <section className="field">
            <h2 className="label">Name</h2>
            <NameField />
          </section>
          <section className="field">
            <h2 className="label">Stats</h2>
            <Stats player={player} />
          </section>
          {player.email ? (
            <section className="field">
              <h2 className="label">Login</h2>
              <p className="account-email">{player.email}</p>
              <p className="modal-note">You log in with this email and your password.</p>
            </section>
          ) : switching ? (
            <section className="field">
              <h2 className="label">Email and password</h2>
              <p className="modal-note">
                Log in with these instead of your passphrase. Your passphrase stops working, on every device.
              </p>
              <EmailForm action="Switch to email" create focus={false} onSubmit={switchToEmail} />
              <button type="button" className="link" onClick={() => setSwitching(false)}>
                Keep my passphrase
              </button>
            </section>
          ) : (
            <section className="field">
              <h2 className="label">Passphrase</h2>
              {shown ? (
                <>
                  <Passphrase value={player.passphrase} />
                  <p className="modal-note">Your login. Use it to play as yourself on another device.</p>
                </>
              ) : (
                <button className="secondary" onClick={() => setShown(true)}>
                  <Key />
                  Show passphrase
                </button>
              )}
              <button type="button" className="link" onClick={() => setSwitching(true)}>
                Switch to email and password
              </button>
            </section>
          )}
        </>
      ) : (
        <section className="field">
          <h2 className="label">Not logged in</h2>
          <div className="row">
            <button className="secondary" onClick={() => (onClose(), requireName())}>
              <User />
              Pick a name
            </button>
            <button className="secondary" onClick={() => (onClose(), openLogin())}>
              <Key />
              Log in
            </button>
          </div>
        </section>
      )}
      <section className="field">
        <h2 className="label">Phone</h2>
        <PhoneLink player={player} />
      </section>
      {player && (
        <button className="secondary danger" onClick={() => setLeaving(true)}>
          <Logout />
          Log out
        </button>
      )}
      {leaving && <LogoutConfirm onDone={stay} />}
    </>
  )
}
