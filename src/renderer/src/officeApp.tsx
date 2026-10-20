// Renderer entry for the standalone PlexiOffice app (plexioffice.html). Mounts
// the PlexiOffice root, which reuses the @office editors + @runtime theme + the
// shared documents store. The space-in-editable guard mirrors the desk entry so
// the "space gets eaten in editors" class of bug can't regress here either.

import React from 'react'
import ReactDOM from 'react-dom/client'
import PlexiOfficeApp from './components/officeApp/PlexiOfficeApp'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/globals.css'
// The type stack, icon font and font-picker families ship with the app, as in
// the desk window (main.tsx): PlexiiOffice loads no fonts from the network.
import 'material-symbols/outlined.css'
import '@fontsource-variable/inter'
import '@fontsource-variable/lexend'
import '@fontsource/jetbrains-mono'
import '@fontsource/patrick-hand'
import '@fontsource/atkinson-hyperlegible'
import './assets/fonts/bundled-fonts.css'

function isEditable(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    const t = (el as HTMLInputElement).type
    return t === 'text' || t === 'search' || t === 'url' || t === 'email' || t === 'password' || t === 'tel' || t === ''
  }
  return false
}
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== ' ' && e.code !== 'Space') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (!isEditable(e.target)) return
    e.stopImmediatePropagation()
  },
  true
)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PlexiOfficeApp />
    </ErrorBoundary>
  </React.StrictMode>
)
