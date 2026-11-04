import { useCallback, useEffect, useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'
import { api } from '../lib/api.ts'
import { useApp } from '../App.tsx'
import type { Player } from '../App.tsx'
import { EmailForm, looksLikePassphrase, Passphrase, PassphraseWarning } from './Account.tsx'
import { Key, Logout, User } from './icons.tsx'
import Confirm from './Confirm.tsx'
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
    const v = value.trim().slice(0, 32)
    if (v && v !== name) setName(v).catch(() => setValue(name || ''))
    else setValue(name || '')
  }
  return (
    <>
      <TextField
        value={value}
        maxLength={32}
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

// A QR code that opens this page on a phone, logged in as this player.
function PhoneLink({ player }: { player: Player | null }) {
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
      <p className="modal-text">Scan to open this jigsaw on your phone, logged in as you. Only scan it with your own phone.</p>
      {noLan && <p className="modal-error">This computer isn't on a network, so a phone may not be able to reach it.</p>}
      <div className="qr-wrap">{link ? <QrCode text={link} /> : <span className="spin" />}</div>
    </>
  )
}

// Asks before logging out, showing how to log back in. onDone runs either way.
export function LogoutConfirm({ onDone }: { onDone: () => void }) {
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
            <h2 className="label">Name</h2>
            <NameField />
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
