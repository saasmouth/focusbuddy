import { useEffect, useMemo, useState } from 'react'
import { useVaultStore } from '../stores/vault'
import { useConnectedAppsStore } from '../stores/connectedApps'
import { useOrgStore } from '../stores/org'
import { createPortal } from 'react-dom'
import {
  STANDARD_APPS,
  categoriesOrdered,
  type StandardApp
} from '../lib/standardApps'
import Icon from './Icon'
import PlexiiIcon from './PlexiiIcon'
import { CONNECTED_ICON_ASSETS } from '../lib/plexiiIconMap'

interface Props {
  onClose: () => void
  onAdded?: (appId: string) => void
}

type Tab = 'standard' | 'custom' | 'local'

interface PickedLocal {
  title: string
  appPath: string
  bundleId: string | null
  iconPngBase64: string | null
}

function ensureHttps(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return trimmed
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default function AddConnectedAppDialog({ onClose, onAdded }: Props): JSX.Element {
  const create = useConnectedAppsStore((s) => s.create)
  const existingApps = useConnectedAppsStore((s) => s.apps)
  // The app is created in whatever org is active — including Personal, which
  // owns what it creates rather than creating on another org's behalf.
  const targetOrgName = useOrgStore(
    (s) => s.orgs.find((o) => o.id === s.activeOrgId)?.name ?? 'Personal'
  )

  const [tab, setTab] = useState<Tab>('standard')
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  // Custom form
  const [customTitle, setCustomTitle] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customBusy, setCustomBusy] = useState(false)
  // Sign-in details, saved to the Vault rather than to the app row: the vault
  // is already the encrypted store, and ConnectedAppView/WebViewWidget already
  // autofill from a bound entry — so capturing them here is what makes an app
  // stay signed in, and is why its unread count can be read at all.
  const [signInUser, setSignInUser] = useState('')
  const [signInPass, setSignInPass] = useState('')
  // On by default, per the operator; this is the opt-out.
  const [notifications, setNotifications] = useState(true)
  const [credError, setCredError] = useState<string | null>(null)
  const addVaultEntry = useVaultStore((v) => v.addEntry)
  const vaultUnlocked = useVaultStore((v) => v.unlocked)
  const setAppVaultEntry = useConnectedAppsStore((v) => v.setVaultEntry)

  /**
   * Save the typed credentials into the Vault and bind them to the new app.
   *
   * Non-fatal by design: an app that connected but whose credentials could not
   * be stored is still a working app, and failing the whole connect would be a
   * worse outcome than connecting without autofill. The reason is surfaced.
   */
  async function bindCredentials(appId: string, title: string, url: string): Promise<void> {
    if (!signInUser.trim() && !signInPass) return
    if (!vaultUnlocked) {
      setCredError('PlexiiVault is locked — connect saved, but the sign-in details were not stored.')
      return
    }
    try {
      const entry = await addVaultEntry({
        title,
        url,
        username: signInUser.trim() || undefined,
        secret: { password: signInPass }
      })
      if (entry) await setAppVaultEntry(appId, entry.id)
      else setCredError('Could not write to the PlexiiVault — connected without sign-in details.')
    } catch {
      setCredError('Could not write to the PlexiiVault — connected without sign-in details.')
    }
  }

  // Local app form
  const [picked, setPicked] = useState<PickedLocal | null>(null)
  const [localTitle, setLocalTitle] = useState('')
  const [localBusy, setLocalBusy] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)

  // Avoid duplicates — by URL match
  const existingUrls = useMemo(
    () => new Set(existingApps.map((a) => a.url)),
    [existingApps]
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function addPreset(app: StandardApp): Promise<void> {
    if (busyId) return
    setBusyId(app.id)
    try {
      const created = await create({
        title: app.title,
        url: app.url,
        icon: app.icon,
        color: app.color,
        notifications
      })
      await bindCredentials(created.id, app.title, app.url)
      onAdded?.(created.id)
      onClose()
    } finally {
      setBusyId(null)
    }
  }

  async function pickLocal(): Promise<void> {
    setPickError(null)
    const result = await window.api.localApp.pick()
    if (!result) return // user cancelled
    setPicked(result)
    setLocalTitle(result.title)
  }

  async function addLocal(): Promise<void> {
    if (!picked || localBusy) return
    setLocalBusy(true)
    try {
      const title = localTitle.trim() || picked.title
      const created = await create({
        title,
        // For local apps we put the appPath into `url` too so existing UI that
        // displays "url" has something sensible to show — but `appPath` is the
        // real source of truth used by launch.
        url: `file://${picked.appPath}`,
        icon: 'apps',
        color: null,
        kind: 'local',
        appPath: picked.appPath,
        bundleId: picked.bundleId,
        iconPngBase64: picked.iconPngBase64
      })
      onAdded?.(created.id)
      onClose()
    } finally {
      setLocalBusy(false)
    }
  }

  async function addCustom(): Promise<void> {
    const url = ensureHttps(customUrl)
    if (!url) return
    if (customBusy) return
    setCustomBusy(true)
    try {
      const title = customTitle.trim() || hostnameOf(url)
      const created = await create({
        title,
        url,
        icon: 'public',
        color: null,
        notifications
      })
      await bindCredentials(created.id, title, url)
      onAdded?.(created.id)
      onClose()
    } finally {
      setCustomBusy(false)
    }
  }

  const q = search.trim().toLowerCase()
  const visiblePresets = q
    ? STANDARD_APPS.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q)
      )
    : STANDARD_APPS

  // Portaled to <body> so a transformed ancestor (sidebar glass chrome) can't
  // trap the fixed overlay inside its own box — see plexi/Modal.tsx.
  return createPortal(
    <div
      className="fb-scrim fixed inset-0 z-[170] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="fb-glass-pillow w-full max-w-2xl mx-4 rounded-[20px] overflow-hidden flex flex-col max-h-[85vh] fb-spring-soft"
      >
        <div className="px-5 py-4 border-b border-[var(--edge-soft)] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Icon name="apps" size={18} className="text-accent shrink-0" />
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-[var(--ink-100)]">
                Add a Connected App
              </h3>
              {/* Which account this will belong to, said BEFORE anything is
                  typed. A connected app carries a saved login and a signed-in
                  session, so the organisation it lands in decides which
                  credentials it uses — and the same app is routinely a
                  different account per organisation. */}
              <p
                className="text-[11px] text-[var(--ink-50)] truncate"
                data-testid="connect-target-org"
              >
                {targetOrgName === 'Personal'
                  ? 'Connecting to your personal account'
                  : `Connecting to ${targetOrgName}`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="px-5 pt-3 shrink-0 flex gap-1 border-b border-[var(--edge-soft)]">
          <TabBtn active={tab === 'standard'} onClick={() => setTab('standard')}>
            <Icon name="grid_view" size={13} />
            <span>Standard</span>
          </TabBtn>
          <TabBtn active={tab === 'custom'} onClick={() => setTab('custom')}>
            <Icon name="link" size={13} />
            <span>Custom URL</span>
          </TabBtn>
          <TabBtn active={tab === 'local'} onClick={() => setTab('local')}>
            <Icon name="desktop_mac" size={13} />
            <span>Local app</span>
          </TabBtn>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === 'standard' && (
            <>
              <div className="relative mb-3">
                <Icon
                  name="search"
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-40)]"
                />
                <input
                  type="text"
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search apps…"
                  className="fb-field w-full bg-[var(--surface-raised)] pl-7 pr-3 py-1.5 text-sm text-[var(--ink-100)]"
                />
              </div>

              {q ? (
                <PresetGrid
                  presets={visiblePresets}
                  existingUrls={existingUrls}
                  busyId={busyId}
                  onAdd={addPreset}
                />
              ) : (
                categoriesOrdered().map((cat) => {
                  const items = STANDARD_APPS.filter((a) => a.category === cat)
                  if (items.length === 0) return null
                  return (
                    <div key={cat} className="mb-4 last:mb-0">
                      <div className="text-[10px] uppercase tracking-wider text-[var(--ink-50)] font-semibold mb-2">
                        {cat}
                      </div>
                      <PresetGrid
                        presets={items}
                        existingUrls={existingUrls}
                        busyId={busyId}
                        onAdd={addPreset}
                      />
                    </div>
                  )
                })
              )}

              {q && visiblePresets.length === 0 && (
                <p className="text-center text-sm text-[var(--ink-50)] py-6">
                  No standard apps match.{' '}
                  <button
                    onClick={() => {
                      setCustomTitle(search)
                      setTab('custom')
                    }}
                    className="text-accent hover:underline"
                  >
                    Add as custom URL
                  </button>
                </p>
              )}
            </>
          )}

          {tab === 'custom' && (
            <div className="space-y-3 max-w-md">
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-[var(--ink-50)] font-medium mb-1.5">
                  URL
                </label>
                <input
                  autoFocus
                  type="text"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--ink-100)]"
                />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-[var(--ink-50)] font-medium mb-1.5">
                  Name <span className="normal-case text-[var(--ink-40)]">(optional)</span>
                </label>
                <input
                  type="text"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder={customUrl ? hostnameOf(ensureHttps(customUrl)) : 'My App'}
                  className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--ink-100)]"
                />
              </div>
              <button
                onClick={() => void addCustom()}
                disabled={!customUrl.trim() || customBusy}
                className="btn-primary w-full justify-center"
              >
                <Icon name="add" size={14} />
                <span>{customBusy ? 'Adding…' : 'Add to sidebar'}</span>
              </button>
              <p className="text-[11px] text-[var(--ink-50)] leading-relaxed">
                Custom apps render as a full-pane browser. Sessions persist in the Electron
                profile, so you stay logged in across app restarts.
              </p>
            </div>
          )}

          {/* Sign-in and notifications — shared by both web tabs, because both
              produce a webview that can hold a session and report an unread
              count. Local apps are excluded: they are launched, not rendered,
              so there is no session here to keep and no title to read. */}
          {tab !== 'local' && (
            <div className="mt-4 pt-3 border-t border-[var(--edge-soft)] max-w-md space-y-2.5">
              <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-[var(--ink-50)]">
                Sign in (optional)
              </div>
              <p className="text-[11px] text-[var(--ink-50)] leading-snug">
                Saved to your PlexiiVault, encrypted, and filled in for you — so the app stays
                signed in and can report its unread count.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={signInUser}
                  onChange={(e) => setSignInUser(e.target.value)}
                  placeholder="username or email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-testid="connect-username"
                  className="px-2.5 py-1.5 rounded-md text-[12.5px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
                />
                <input
                  value={signInPass}
                  onChange={(e) => setSignInPass(e.target.value)}
                  type="password"
                  placeholder="password"
                  data-testid="connect-password"
                  className="px-2.5 py-1.5 rounded-md text-[12.5px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
                />
              </div>
              {!vaultUnlocked && (signInUser || signInPass) && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-snug">
                  Your PlexiiVault is locked. Unlock it in Apps → PlexiiVault first, or the app will
                  connect without these details.
                </p>
              )}
              {credError && (
                <p className="text-[11px] text-red-600 dark:text-red-400 leading-snug">
                  {credError}
                </p>
              )}
              <label className="flex items-start gap-2 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={notifications}
                  onChange={(e) => setNotifications(e.target.checked)}
                  className="mt-0.5 accent-accent"
                  data-testid="connect-notifications"
                />
                <span className="text-[12px] text-[var(--ink-80)] leading-snug">
                  Show unread count in the side menu
                  <span className="block text-[11px] text-[var(--ink-50)]">
                    Read from the app&apos;s own page title while it is open. You can turn
                    it off later from the bell in the app&apos;s own toolbar.
                  </span>
                </span>
              </label>
            </div>
          )}

          {tab === 'local' && (
            <div className="space-y-3 max-w-md">
              {!picked && (
                <div className="rounded-lg border border-dashed border-[var(--edge-firm)] p-5 text-center">
                  <Icon
                    name="desktop_mac"
                    size={24}
                    className="text-[var(--ink-40)] mx-auto mb-2"
                  />
                  <p className="text-[12px] text-[var(--ink-70)] leading-snug mb-3">
                    Pick a Mac app from your <span className="font-mono">/Applications</span>{' '}
                    folder. It can't render inside the canvas, but it shows up in the
                    sidebar with its real icon and drag-to-canvas spawns a one-click
                    launcher tile.
                  </p>
                  <button
                    onClick={() => void pickLocal()}
                    className="btn-primary"
                  >
                    <Icon name="folder_open" size={14} />
                    <span>Choose app…</span>
                  </button>
                  {pickError && (
                    <p className="text-[11px] text-red-600 dark:text-red-400 mt-2">
                      {pickError}
                    </p>
                  )}
                </div>
              )}

              {picked && (
                <>
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--surface-sunken)]">
                    {picked.iconPngBase64 ? (
                      <img
                        src={`data:image/png;base64,${picked.iconPngBase64}`}
                        alt=""
                        className="h-12 w-12 rounded-lg shrink-0"
                      />
                    ) : (
                      <span className="h-12 w-12 rounded-lg inline-flex items-center justify-center bg-accent/10 text-accent shrink-0">
                        <Icon name="apps" size={22} />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-[var(--ink-100)] truncate">
                        {picked.title}
                      </div>
                      <div className="text-[10px] text-[var(--ink-50)] truncate font-mono">
                        {picked.appPath}
                      </div>
                      {picked.bundleId && (
                        <div className="text-[10px] text-[var(--ink-40)] truncate font-mono">
                          {picked.bundleId}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        setPicked(null)
                        setLocalTitle('')
                      }}
                      className="icon-btn"
                      title="Pick a different app"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                  <div>
                    <label className="block text-[11px] uppercase tracking-wider text-[var(--ink-50)] font-medium mb-1.5">
                      Display name
                    </label>
                    <input
                      type="text"
                      value={localTitle}
                      onChange={(e) => setLocalTitle(e.target.value)}
                      className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--ink-100)]"
                    />
                  </div>
                  <button
                    onClick={() => void addLocal()}
                    disabled={localBusy}
                    className="btn-primary w-full justify-center"
                  >
                    <Icon name="add" size={14} />
                    <span>{localBusy ? 'Adding…' : 'Add to sidebar'}</span>
                  </button>
                </>
              )}

              <p className="text-[11px] text-[var(--ink-50)] leading-relaxed">
                Local apps launch the real Mac app when clicked. Dragging one onto a
                canvas creates a launcher tile bound to that task.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function TabBtn({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-accent text-[var(--ink-100)]'
          : 'border-transparent text-[var(--ink-50)] hover:text-[var(--ink-100)]'
      }`}
    >
      {children}
    </button>
  )
}

interface PresetGridProps {
  presets: StandardApp[]
  existingUrls: Set<string>
  busyId: string | null
  onAdd: (a: StandardApp) => void
}

function PresetGrid({
  presets,
  existingUrls,
  busyId,
  onAdd
}: PresetGridProps): JSX.Element {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {presets.map((p) => {
        const already = existingUrls.has(p.url)
        const busy = busyId === p.id
        return (
          <button
            key={p.id}
            onClick={() => !already && onAdd(p)}
            disabled={already || busy}
            className={`flex items-center gap-2 p-2.5 text-left ${
              already
                ? 'rounded-[10px] border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 cursor-default'
                : 'fb-tile fb-press'
            }`}
          >
            {CONNECTED_ICON_ASSETS[p.id] ? (
              <PlexiiIcon kind="connected" id={p.id} size={32} fallback={p.icon} />
            ) : (
              <span
                className="h-8 w-8 rounded-md inline-flex items-center justify-center shrink-0"
                style={{ backgroundColor: `${p.color}1a`, color: p.color }}
              >
                <Icon name={p.icon} size={16} />
              </span>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-[var(--ink-100)] truncate">
                {p.title}
              </div>
              <div className="text-[10px] text-[var(--ink-50)] truncate">
                {already ? 'already added' : busy ? 'adding…' : new URL(p.url).hostname.replace(/^www\./, '')}
              </div>
            </div>
            {already && (
              <Icon
                name="check_circle"
                size={14}
                filled
                className="text-emerald-600 dark:text-emerald-500 shrink-0"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
