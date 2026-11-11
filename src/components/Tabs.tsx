// Tabs in a row, one of them on. tabs is a list of { key, title, hint }.
interface Tab<K extends string = string> {
  key: K
  title: string
  hint?: string
}

export default function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: readonly Tab<K>[]; value: K; onChange: (key: K) => void; label?: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`tab${t.key === value ? ' on' : ''}`}
          role="tab"
          aria-selected={t.key === value}
          onClick={() => onChange(t.key)}
          title={t.hint || t.title}
        >
          {t.title}
        </button>
      ))}
    </div>
  )
}
