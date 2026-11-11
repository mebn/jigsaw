// The page's link preview tags (og: and twitter:, see index.html) for a jigsaw's own link, so a
// shared link shows that jigsaw's picture, name and progress instead of the site's.

// What a jigsaw's link preview shows; see sharing() in rooms.ts.
export interface SharedRoom {
  id: string
  name: string
  // The picture's size in pixels.
  width: number
  height: number
  pieces: number
  progress: number
  done: boolean
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Sets the content of the <meta> with this property (or name) in html, if it's there.
function setMeta(html: string, key: string, value: string) {
  const re = new RegExp(`(<meta (?:property|name)="${key}" content=")[^"]*(")`)
  return html.replace(re, (_, a: string, b: string) => a + escape(value) + b)
}

// index.html with room's preview tags. The site's address comes from og:url, as in index.html.
export function roomPage(html: string, room: SharedRoom) {
  const origin = /<meta property="og:url" content="([^"]*)"/.exec(html)?.[1]?.replace(/\/+$/, '') || ''
  const title = room.name.trim() || 'Jigsaw'
  const state = room.done ? 'finished' : `${Math.floor(room.progress * 100)}% done`
  const description = `${room.pieces} pieces, ${state}. Do it together with friends.`
  const tags: [string, string][] = [
    ['og:title', title],
    ['og:description', description],
    ['description', description],
    ['og:url', `${origin}/r/${room.id}`],
    ['og:image', `${origin}/api/rooms/${room.id}/image`],
    ['og:image:width', String(Math.round(room.width))],
    ['og:image:height', String(Math.round(room.height))],
    ['og:image:alt', `The picture of the jigsaw ${title}`],
  ]
  // The <title> stays, as the page doesn't change it when leaving the jigsaw.
  return tags.reduce((out, [key, value]) => setMeta(out, key, value), html)
}
