import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import type { InvitablePlayer } from '../lib/api.ts'
import { useApp } from '../App.tsx'
import { Check } from './icons.tsx'
import TextField from './TextField.tsx'

// Players with an email address to pick for an invite to a private jigsaw. selected is a Set of
// player ids. With room, players who already have that jigsaw are shown but can't be picked.
interface InviteListProps {
  room?: string
  selected: Set<string>
  onChange: (selected: Set<string>) => void
}

export default function InviteList({ room = '', selected, onChange }: InviteListProps) {
  const { player } = useApp()
  const [list, setList] = useState<InvitablePlayer[] | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!player) return
    let dead = false
    api
      .invitable(player.passphrase, room)
      .then((l) => !dead && setList(l))
      .catch(() => !dead && setList([]))
    return () => {
      dead = true
    }
  }, [player?.passphrase, room])

  if (!player) return <p className="modal-note">Log in to invite players by email.</p>
  if (!list) return <span className="spin" />
  if (!list.length) return <p className="modal-note">No players have an email address yet.</p>

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }
  const f = filter.trim().toLowerCase()
  const shown = f ? list.filter((p) => p.name.toLowerCase().includes(f)) : list

  return (
    <div className="invite">
      {list.length > 6 && (
        <TextField
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a player"
          aria-label="Find a player"
          title="Find a player"
        />
      )}
      <ul className="invite-list">
        {shown.map((p) => {
          const on = p.joined || selected.has(p.id)
          return (
            <li key={p.id}>
              <button
                type="button"
                className={`invite-row${on ? ' on' : ''}`}
                role="checkbox"
                aria-checked={on}
                disabled={p.joined}
                onClick={() => toggle(p.id)}
                title={p.joined ? `${p.name} already has this jigsaw` : `Invite ${p.name}`}
              >
                <span className="invite-box" aria-hidden="true">
                  {on && <Check />}
                </span>
                <span className="invite-name">{p.name}</span>
                {p.joined && <span className="invite-note">Has it</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <p className="modal-note">They get an email with the link, and the jigsaw shows up in their list.</p>
    </div>
  )
}
