import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// highlight.js token colours for fenced code blocks (editor preview + AI chat).
// The app is dark-first; this dark palette is loaded once globally.
import 'highlight.js/styles/github-dark.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
