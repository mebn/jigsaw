// The service worker that makes the site installable as an app (see registerApp in src/main.tsx).
// It keeps nothing: every request goes to the network as usual, so a new build is never held back.
// Only a page that can't load at all gets a short note saying so.
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jigsaw</title><style>body{margin:0;height:100vh;display:grid;place-items:center;font:15px system-ui,sans-serif;background:#0a0a0a;color:#f5f5f5}</style>
<p>You're offline. Jigsaw needs a connection to play.</p>`

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
})
