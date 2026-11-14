import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { startAnalytics } from './lib/analytics.ts'
import { liquidGlass } from './lib/glass.ts'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)
liquidGlass()
startAnalytics()

// Installable as an app on phones (see public/manifest.webmanifest and public/sw.js). Not while
// developing, where a service worker would only get in the way.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
