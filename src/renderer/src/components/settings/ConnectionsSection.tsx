// Settings › Connections (SPEC-CONNECTIONS.md §2 "Add Connections to workspace
// settings"): a short summary of what's connected and anything that needs the
// person, with one way through to the full Connections screen. Desktop only:
// SettingsPanel shows this tab only where aiSpaceAvailable() is true.

import { useEffect, useState } from 'react'
import type { ConnectionCard } from '@shared/aispace/api'
import { CONNECTION_STATUS_LABEL, CONNECTION_STATUSES, type ConnectionStatus } from '@shared/aispace/connections'
import Icon from '../Icon'

const NEEDS_YOU: ReadonlySet<ConnectionStatus> = new Set(['reconnect_required', 'limited', 'unavailable', 'draft'])

export default function ConnectionsSection({ onManage }: { onManage: () => void }): JSX.Element {
  const [cards, setCards] = useState<ConnectionCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.api.aiSpace
      .listConnections({})
      .then((c) => live && setCards(c))
      .catch((e) => live && setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : String(e)))
    return () => {
      live = false
    }
  }, [])

  const counts = new Map<ConnectionStatus, number>()
  for (const c of cards ?? []) counts.set(c.status, (counts.get(c.status) ?? 0) + 1)
  const attention = (cards ?? []).filter((c) => NEEDS_YOU.has(c.status))

  return (
    <section className="px-3 py-3 space-y-2" data-testid="settings-connections">
      <div className="fb-t-caption uppercase tracking-[0.12em] font-medium">Connections</div>
      <p className="text-[12px] leading-relaxed text-[var(--ink-60)]">AI accounts, model API keys, MCP servers and app APIs. Each project uses only the ones you give it.</p>

      {error && (
        <p role="alert" className="text-[12px] text-[var(--ink-70)]" data-testid="settings-connections-error">
          Couldn’t load connections: {error}
        </p>
      )}
      {!cards && !error && <p className="text-[12px] text-[var(--ink-50)]">Loading…</p>}

      {cards && cards.length === 0 && (
        <p className="text-[12px] text-[var(--ink-50)]" data-testid="settings-connections-empty">
          Nothing connected yet.
        </p>
      )}

      {cards && cards.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--ink-70)]" data-testid="settings-connections-counts">
          {CONNECTION_STATUSES.filter((s) => counts.get(s)).map((s) => (
            <li key={s}>
              <span className="fb-tabular font-medium text-[var(--ink-90)]">{counts.get(s)}</span> {CONNECTION_STATUS_LABEL[s].toLowerCase()}
            </li>
          ))}
        </ul>
      )}

      {attention.length > 0 && (
        <div className="space-y-0.5" data-testid="settings-connections-attention">
          <div className="text-[12px] font-medium text-[var(--ink-80)]">Needs you</div>
          {attention.map((c) => (
            <div key={c.id} className="flex items-center gap-2 px-1.5 py-1 rounded-[var(--radius-row)] text-[12px]">
              <Icon name={c.status === 'reconnect_required' ? 'link_off' : c.status === 'draft' ? 'edit_note' : 'warning'} size={13} className="text-[color:var(--ais-warn,currentColor)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--ink-80)]">{c.alias}</span>
              <span className="text-[var(--ink-60)]">{CONNECTION_STATUS_LABEL[c.status]}</span>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onManage}
        data-testid="settings-connections-manage"
        className="fb-btn-surface inline-flex items-center gap-1.5 min-h-[28px] px-2.5 rounded-[var(--radius-field)] text-[12px] text-[var(--ink-90)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
      >
        <Icon name="hub" size={13} />
        Manage connections
      </button>
    </section>
  )
}
