import { useCallback, useEffect, useState } from 'react'
import Icon from '../Icon'

// Chrome extensions for Plexii's browser.
//
// The browser surfaces are Electron <webview>s, and Electron loads extensions
// per session, so an extension added here reaches the browser widget, the
// panel, the fullscreen browser AND every connected app. (Verified: a content
// script from an unpacked MV2 extension runs inside a webview guest.)
//
// Electron supports a SUBSET of what Chrome does, and the honest thing is to
// say so here rather than let someone discover it one broken extension at a
// time. The three that bite:
//
//   * the Chrome Web Store cannot be used — its install is a Chrome binary
//     handshake, so extensions come from an unpacked folder
//   * only some APIs exist, and a missing one fails when that code path runs,
//     not at install
//   * toolbar buttons and popups are not drawn by Electron at all

interface BrowserExtension {
  path: string
  enabled: boolean
  id?: string
  name: string
  version?: string
  error?: string
  browserAction?: { title?: string; popup?: string }
}

interface ExtensionsApi {
  list: () => Promise<BrowserExtension[]>
  pick: () => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
  setEnabled: (path: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  remove: (path: string) => Promise<{ ok: boolean }>
}

export default function BrowserExtensionsSection(): JSX.Element {
  const api = (window as unknown as { api?: { browserExtensions?: ExtensionsApi } }).api
    ?.browserExtensions
  const [items, setItems] = useState<BrowserExtension[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    if (!api) {
      // The browser build has no Electron session to load into. Not an error —
      // there is simply nothing this can do there.
      setItems([])
      return
    }
    try {
      setItems(await api.list())
    } catch (e) {
      setItems([])
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [api])

  useEffect(() => {
    void reload()
  }, [reload])

  async function add(): Promise<void> {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.pick()
      // A cancelled picker is not a failure and says nothing.
      if (!res.ok && !res.cancelled) setError(res.error ?? 'That folder could not be installed.')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  async function toggle(ext: BrowserExtension): Promise<void> {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.setEnabled(ext.path, !ext.enabled)
      if (!res.ok) setError(res.error ?? 'That could not be changed.')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  async function drop(ext: BrowserExtension): Promise<void> {
    if (!api) return
    setBusy(true)
    try {
      await api.remove(ext.path)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="px-3 py-3 space-y-2" data-testid="settings-browser-extensions">
      <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-1">
        Browser extensions
      </div>
      <p className="text-[12px] text-[var(--ink-50)]">
        Extensions run in every Plexii browser surface — the widget, the panel, the fullscreen
        browser and your connected apps.
      </p>

      {!api ? (
        <p className="text-[12px] text-[var(--ink-50)]" data-testid="browser-extensions-unavailable">
          Extensions need the desktop app.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy}
              data-testid="browser-extensions-add"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--edge-soft)] text-[12px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
            >
              <Icon name="extension" size={14} />
              Add an unpacked folder…
            </button>
          </div>

          {error && (
            <p className="text-[12px] text-rose-500" data-testid="browser-extensions-error">
              {error}
            </p>
          )}

          {items === null ? null : items.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-50)]" data-testid="browser-extensions-empty">
              No extensions installed.
            </p>
          ) : (
            <ul className="space-y-1" data-testid="browser-extensions-list">
              {items.map((ext) => (
                <li
                  key={ext.path}
                  data-testid={`browser-extension-${ext.name}`}
                  className="fb-card flex items-start gap-2 px-2.5 py-2"
                >
                  <Icon
                    name="extension"
                    size={15}
                    className={ext.enabled && !ext.error ? 'text-accent' : 'text-[var(--ink-40)]'}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[12.5px] font-medium text-[var(--ink-90)] truncate">
                        {ext.name}
                      </span>
                      {ext.version && (
                        <span className="text-[10.5px] text-[var(--ink-40)]">{ext.version}</span>
                      )}
                    </div>
                    <div className="text-[10.5px] text-[var(--ink-40)] truncate" title={ext.path}>
                      {ext.path}
                    </div>
                    {ext.error && (
                      <div className="text-[11px] text-rose-500 mt-0.5">{ext.error}</div>
                    )}
                    {ext.browserAction && (
                      // Said plainly, because an extension whose whole interface
                      // is a toolbar popup will look broken otherwise.
                      <div className="text-[11px] text-[var(--ink-50)] mt-0.5">
                        This one has a toolbar button, which Plexii does not draw yet — its
                        content scripts still run.
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void toggle(ext)}
                    disabled={busy}
                    data-testid={`browser-extension-toggle-${ext.name}`}
                    className="shrink-0 px-2 py-0.5 rounded border border-[var(--edge-soft)] text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                  >
                    {ext.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void drop(ext)}
                    disabled={busy}
                    title="Remove from Plexii — the folder on disk is left alone"
                    data-testid={`browser-extension-remove-${ext.name}`}
                    className="shrink-0 icon-btn !h-6 !w-6"
                  >
                    <Icon name="close" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <details className="mt-1">
            <summary className="text-[11.5px] text-[var(--ink-60)] cursor-pointer">
              What works, and what does not
            </summary>
            <ul className="ml-4 mt-1 list-disc text-[11px] leading-relaxed text-[var(--ink-60)]">
              <li>
                Unpacked folders only — the folder holding <code>manifest.json</code>. The Chrome
                Web Store cannot install into Plexii.
              </li>
              <li>
                Content scripts, storage and request blocking work. Manifest V2 works best for
                now, though Chrome is phasing V2 out; V3 background workers run but its
                request-blocking rules are only partly supported.
              </li>
              <li>Toolbar buttons and popups are not drawn yet.</li>
              <li>
                Anything that manages the browser itself — bookmarks, history, identity — has no
                equivalent here and will not work.
              </li>
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
