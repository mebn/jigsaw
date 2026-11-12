// Google Analytics (GA4), only in production builds and only when VITE_GA_ID holds a measurement id
// (G-XXXXXXXXXX), set in .env before `npm run build` / `npm run start`. Page changes in the app go
// through history.pushState (see router.ts), which GA4's enhanced measurement counts as page views.

type GtagWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void }

export function startAnalytics() {
  const id: string | undefined = import.meta.env.VITE_GA_ID
  if (!import.meta.env.PROD || !id || !/^G-[A-Z0-9]+$/.test(id)) return
  const w = window as GtagWindow
  const layer = (w.dataLayer = w.dataLayer || [])
  // gtag.js wants the arguments object itself, not an array, so this must be a plain function.
  w.gtag = function () {
    layer.push(arguments)
  }
  w.gtag('js', new Date())
  w.gtag('config', id)
  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${id}`
  document.head.appendChild(script)
}
