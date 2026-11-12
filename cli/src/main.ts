// Play a jigsaw in the terminal: npx @mebn/jigsaw [link]
// Without a link it opens the jigsaws page of jigsaw.marnil.dev; with one, that jigsaw.
import { Gallery } from './gallery.ts'
import { Game } from './game.ts'
import { C, Terminal } from './screen.ts'
import type { Cells, Scene } from './screen.ts'
import { Session } from './session.ts'

// The site to play on when no link is given (JIGSAW_URL to use another).
const SITE = process.env.JIGSAW_URL || 'https://jigsaw.marnil.dev'

const USAGE = `Play a jigsaw in the terminal.

Usage: jigsaw [<link>] [--login <passphrase>] [--256]

  <link>        a jigsaw's link (https://host/r/<id>), or a site's address;
                without it, the jigsaws on ${SITE}
  --login       play as your player, by your passphrase (or log in with L once it's running)
  --256         use 256 colours, for terminals without 24-bit colour
`

function fail(msg: string): never {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n')
  process.exit(1)
}

// A line of text in the middle of the screen, while something loads.
class Notice implements Scene {
  text: string
  constructor(text: string) {
    this.text = text
  }
  draw(c: Cells) {
    c.text(Math.max(0, Math.floor((c.w - [...this.text].length) / 2)), Math.floor(c.h / 2), this.text, C.dim)
  }
  input() {}
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('-h') || args.includes('--help')) fail(USAGE)
  let link = SITE
  let passphrase: string | null = null
  let truecolor = process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' || !!process.env.WT_SESSION
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--login') passphrase = args[++k] || null
    else if (args[k] === '--256') truecolor = false
    else if (args[k] === '--truecolor') truecolor = true
    else link = args[k]
  }
  // Without http(s)://: plain http on this machine or the local network, https anywhere else.
  if (!/^https?:\/\//.test(link)) link = (/^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(link) ? 'http://' : 'https://') + link
  let url: URL
  try {
    url = new URL(link)
  } catch {
    fail(`Not a link: ${link}`)
  }
  const login = /^#login=(.+)$/.exec(url.hash)
  if (login) passphrase ??= decodeURIComponent(login[1])
  if (!process.stdin.isTTY) fail('Run this in a terminal.')

  const session = new Session(url.origin)
  await session.restore(passphrase)
  const term = new Terminal(truecolor)
  let game: Game | null = null
  term.onQuit = () => game?.close()

  const gallery: Gallery = new Gallery(term, session, (r) => play(r.id, r.name))
  // The gallery lists private jigsaws for whoever is logged in.
  session.listen(() => gallery.load())
  const toGallery = () => {
    game = null
    term.replace(gallery)
    gallery.load()
  }

  async function play(id: string, name = '') {
    term.replace(new Notice(`Loading ${name || 'the jigsaw'}…`))
    try {
      const room = await session.room(id)
      const picture = await session.picture(id, 'image')
      game = new Game(term, session, room, picture, toGallery)
      term.replace(game)
    } catch (e) {
      toGallery()
      gallery.say(`Couldn't open ${name || 'that jigsaw'}: ${(e as Error).message}`)
    }
  }

  term.start()
  const id = /^\/r\/([^/?#]+)/.exec(url.pathname)?.[1]
  if (id) play(decodeURIComponent(id))
  else toGallery()
}

main().catch((e: unknown) => fail(String((e as Error)?.message || e)))
