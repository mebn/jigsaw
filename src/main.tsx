import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { liquidGlass } from './lib/glass.ts'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)
liquidGlass()
