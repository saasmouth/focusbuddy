import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon'
import { DashboardHeader, StatusPill, PLEXI_CARD } from '../plexi'
import { API_ENDPOINTS, type ApiServerConfig, type ApiTokenPublic, type ApiScope } from '@shared/apiAccess'

// PlexiApi: a local REST API over your workspace. The server binds only to
// 127.0.0.1 and is off until you turn it on; access needs a scoped token whose
// raw value is shown once and stored only as a hash. Everything here reflects the
// real server state, so a busy port shows an honest error rather than a running
// server that is not actually listening.

function fmtWhen(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never'
}

export default function PlexiApiView(): JSX.Element {
  const [status, setStatus] = useState<ApiServerConfig | null>(null)
  const [tokens, setTokens] = useState<ApiTokenPublic[]>([])
  const [error, setError] = useState<string | null>(null)
  const [portText, setPortText] = useState('')
  const [newName, setNewName] = useState('')
  const [newWrite, setNewWrite] = useState(false)
  const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(null)
  const [creating, setCreating] = useState(false)
  // Synchronous re-entry guard: React state updates async, so two clicks in the
  // same tick both see creating=false. A ref flips immediately and blocks the
  // second, which matters because the token secret is shown only once.
  const creatingRef = useRef(false)

  async function load(): Promise<void> {
    setError(null)
    try {
      const [s, t] = await Promise.all([window.api.apiAccess.status(), window.api.apiAccess.listTokens()])
      setStatus(s)
      setPortText(String(s.port))
      setTokens(t)
    } catch (e) {
      setError(`Could not load the API status: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function toggle(enabled: boolean): Promise<void> {
    setError(null)
    try {
      const s = await window.api.apiAccess.setEnabled(enabled)
      setStatus(s)
      setPortText(String(s.port))
      if (s.error) setError(s.error)
    } catch (e) {
      setError(`Could not change the server state: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function savePort(): Promise<void> {
    const port = Number(portText)
    if (!port || port < 1 || port > 65535) {
      setError('Enter a port between 1 and 65535.')
      return
    }
    setError(null)
    try {
      const s = await window.api.apiAccess.setPort(port)
      setStatus(s)
      setPortText(String(s.port))
      if (s.error) setError(s.error)
    } catch (e) {
      setError(`Could not set the port: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function createToken(): Promise<void> {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setError(null)
    try {
      const scopes: ApiScope[] = newWrite ? ['read', 'write'] : ['read']
      const res = await window.api.apiAccess.createToken(newName || 'Token', scopes)
      setRevealed({ id: res.token.id, secret: res.secret })
      setNewName('')
      setNewWrite(false)
      await load()
    } catch (e) {
      setError(`Could not create the token: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCreating(false)
      creatingRef.current = false
    }
  }

  async function revoke(id: string): Promise<void> {
    setError(null)
    try {
      await window.api.apiAccess.revokeToken(id)
      if (revealed?.id === id) setRevealed(null)
      await load()
    } catch (e) {
      setError(`Could not revoke the token: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const baseUrl = status ? `http://${status.host}:${status.port}` : ''

  return (
    <div className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="plexiapi-view">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <DashboardHeader title="API access" subtitle="A local REST API over your workspace, for your own scripts and tools" />

        {/* Server control */}
        <div className={`${PLEXI_CARD} p-4`}>
          <div className="flex items-center gap-3">
            <Icon name="api" size={18} className="text-[rgb(var(--accent))]" />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold">Local server</span>
                {status?.running ? (
                  <StatusPill tone="emerald" label="Running" />
                ) : (
                  <StatusPill tone="stone" label="Stopped" dot={false} />
                )}
              </div>
              <p className="mt-0.5 text-[11.5px] text-[var(--ink-70)]">Binds to 127.0.0.1 only. Off until you enable it.</p>
            </div>
            <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
              <input
                type="checkbox"
                checked={!!status?.enabled}
                data-testid="api-enabled"
                onChange={(e) => void toggle(e.target.checked)}
                className="accent-[rgb(var(--accent))]"
              />
              Enabled
            </label>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="text-[12px] text-[var(--ink-70)]">Port</span>
            <input
              value={portText}
              onChange={(e) => setPortText(e.target.value)}
              onBlur={() => void savePort()}
              data-testid="api-port"
              className="fb-field w-24 px-2 py-1 text-[12px] fb-tabular text-[var(--ink-100)]"
            />
            {status?.running && (
              <code className="ml-1 text-[11.5px] text-[var(--ink-70)] bg-[var(--surface-sunken)] px-2 py-1 rounded" data-testid="api-base-url">
                {baseUrl}
              </code>
            )}
          </div>
          {error && <p className="mt-2 text-[12px] text-rose-500" data-testid="api-error">{error}</p>}
        </div>

        {/* Tokens */}
        <div className="mt-5">
          <h2 className="fb-display text-[13px] font-semibold text-[var(--ink-90)] mb-2">Access tokens</h2>

          {revealed && (
            <div className="rounded-lg border border-[rgb(var(--accent)/0.30)] bg-[rgb(var(--accent)/0.06)] p-3 mb-3" data-testid="api-token-revealed">
              <p className="text-[11.5px] text-[var(--ink-70)]">Copy this token now. It is shown once and cannot be retrieved later.</p>
              <code className="mt-1 block break-all text-[12px] text-[var(--ink-100)] bg-[var(--surface-base)] rounded px-2 py-1.5">
                {revealed.secret}
              </code>
            </div>
          )}

          <div className="flex items-center gap-2 mb-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Token name"
              data-testid="api-token-name"
              className="fb-card flex-1 px-2 py-1.5 text-[12.5px] placeholder:text-[var(--ink-50)]"
            />
            <label className="flex items-center gap-1.5 text-[12px] text-[var(--ink-90)] cursor-pointer">
              <input type="checkbox" checked={newWrite} data-testid="api-token-write" onChange={(e) => setNewWrite(e.target.checked)} className="accent-[rgb(var(--accent))]" />
              Allow write
            </label>
            <button
              onClick={() => void createToken()}
              disabled={creating}
              data-testid="api-token-create"
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[rgb(var(--accent))] text-white text-[12.5px] font-medium hover:bg-[rgb(var(--accent-hover))] disabled:opacity-40"
            >
              <Icon name="add" size={14} /> {creating ? 'Creating…' : 'Create'}
            </button>
          </div>

          {tokens.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-50)]">No tokens yet. Create one to call the API.</p>
          ) : (
            <div className="space-y-1">
              {tokens.map((t) => (
                <div key={t.id} data-testid={`api-token-${t.id}`} className={`${PLEXI_CARD} flex items-center gap-2 px-3 py-2`}>
                  <Icon name="key" size={14} className="text-[var(--ink-70)]" />
                  <span className="text-[12.5px] font-medium truncate flex-1 min-w-0">{t.name}</span>
                  <StatusPill tone={t.scopes.includes('write') ? 'amber' : 'stone'} label={t.scopes.includes('write') ? 'read/write' : 'read'} dot={false} />
                  <span className="text-[11px] text-[var(--ink-50)] fb-tabular">used {fmtWhen(t.lastUsedAt)}</span>
                  <button onClick={() => void revoke(t.id)} aria-label="Revoke token" className="p-1 rounded text-[var(--ink-50)] hover:text-rose-500" title="Revoke">
                    <Icon name="delete" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Endpoint reference */}
        <div className="mt-6">
          <h2 className="fb-display text-[13px] font-semibold text-[var(--ink-90)] mb-2">Endpoints</h2>
          <div className={`${PLEXI_CARD} overflow-hidden`}>
            {API_ENDPOINTS.map((e, i) => (
              <div key={i} className={`flex items-center gap-3 px-3 py-2 text-[12px] ${i % 2 ? 'bg-[var(--surface-raised)]' : 'bg-[var(--surface-base)]'}`}>
                <span className={`fb-tabular font-semibold w-12 ${e.method === 'GET' ? 'text-sky-600 dark:text-sky-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{e.method}</span>
                <code className="text-[var(--ink-90)] w-56 truncate">{e.path}</code>
                <StatusPill tone={e.scope === 'write' ? 'amber' : 'stone'} label={e.scope} dot={false} />
                <span className="text-[var(--ink-70)] truncate flex-1 min-w-0">{e.summary}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11.5px] text-[var(--ink-50)]">
            Authenticate with a header: Authorization: Bearer your-token. Example: curl -H "Authorization: Bearer
            plx_..." {baseUrl || 'http://127.0.0.1:8787'}/api/tasks
          </p>
          {/* Plexii over MCP — search/read with any token, add with a write token. */}
          <p className="mt-2 text-[11.5px] text-[var(--ink-50)]" data-testid="mcp-howto">
            AI tools can work in your workspace over MCP: search and read desks, work items, documents, tables,
            knowledge, the calendar and meeting transcripts with any token; a write token also lets them add work
            items, desks, knowledge, documents, table rows and time blocks, and run flows that stay inside your
            workspace. Nothing deletes, and nothing sends or calls out — a flow that emails or hits an external URL
            is refused over MCP. Claude Code connects directly:{' '}
            <code className="text-[var(--ink-70)]">
              claude mcp add --transport http plexii {baseUrl || 'http://127.0.0.1:8787'}/mcp --header
              "Authorization: Bearer plx_..."
            </code>
            . Claude Desktop needs the Plexii bridge extension (tools/plexii-mcp-bridge in the repo) with the same URL
            and token.
          </p>
        </div>
      </div>
    </div>
  )
}
