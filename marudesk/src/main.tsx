import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import './index.css'
// highlight.js token colours for fenced code blocks (editor preview + AI chat).
// Theme-aware: seeded here from the pre-paint data-theme guard so first paint is
// right; the settings store re-applies it on every theme change.
import { applyHljsTheme } from './lib/hljsTheme'
import App from './App.tsx'
import { I18nProvider } from './i18n/I18nProvider'

applyHljsTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

class RootElementMissingError extends Error {
  constructor() {
    super('marudesk root element is missing.')
    this.name = 'RootElementMissingError'
  }
}

const rootElement = document.getElementById('root')
if (rootElement === null) throw new RootElementMissingError()

createRoot(rootElement).render(
  <StrictMode>
    {/* Design-benchmark polish (N4): lighter 1.5 Lucide stroke app-wide. Per-icon
        strokeWidth still overrides this default where a heavier weight is wanted. */}
    <LucideProvider strokeWidth={1.5}>
      <I18nProvider>
        <App />
      </I18nProvider>
    </LucideProvider>
  </StrictMode>,
)
