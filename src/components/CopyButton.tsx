import { useEffect, useState } from 'react'
import { Check, Copy } from './icons.tsx'

// A button that copies text, and shows a tick for a moment once it has. label says what it copies.
export default function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      // The browser said no (no permission, or the page isn't focused): nothing to show.
      () => {},
    )

  return (
    <button
      type="button"
      className={`icon-btn copy-btn${copied ? ' on' : ''}`}
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check /> : <Copy />}
    </button>
  )
}
