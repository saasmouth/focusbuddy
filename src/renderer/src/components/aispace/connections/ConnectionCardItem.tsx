// One connection on the Connections screen (SPEC-CONNECTIONS.md §2 "Each card
// shows account alias, provider organisation where known, credential owner,
// status, billed account where known, last checked time, and eligible
// projects"; §1 "Only show a label when the corresponding capability has
// passed testing").
//
// The whole card opens the side panel, but only its name is the button: a
// screen reader hears the alias as the control and the rest as the card's
// content, not one long button label.

import type { KeyboardEvent } from 'react'
import type { ConnectionCard } from '@shared/aispace/api'
import type { AiWorkspace } from '@shared/aispace/model'
import { CAPABILITY_LABEL, CONNECTION_STATUS_LABEL, capabilityPassed, CAPABILITIES } from '@shared/aispace/connections'
import Icon from '../../Icon'
import { fmtAgo, StatusBadge } from '../ui'
import { ownerLabel, workspaceLabel } from './model'

export default function ConnectionCardItem(props: { card: ConnectionCard; workspace: AiWorkspace | undefined; selected: boolean; onOpen: (id: string) => void }): JSX.Element {
  const { card } = props
  const passed = CAPABILITIES.filter((cap) => capabilityPassed(card, cap))
  const metaId = `conn-card-meta-${card.id}`

  function onKey(e: KeyboardEvent<HTMLButtonElement>): void {
    // Handle Enter here (and stop the button's own click) so it opens once.
    if (e.key === 'Enter') {
      e.preventDefault()
      props.onOpen(card.id)
    }
  }

  return (
    <li
      className={`relative fb-card rounded-[var(--radius-card)] p-4 motion-safe:transition-shadow motion-safe:duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[rgb(var(--accent))] ${props.selected ? 'ring-2 ring-[rgb(var(--accent)/0.55)]' : 'hover:shadow-[var(--shadow-cast)]'}`}
      data-testid={`conn-card-${card.id}`}
      data-selected={props.selected ? 'true' : undefined}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-snug text-[var(--ink-100)]">
            <button
              type="button"
              data-card-open={card.id}
              aria-describedby={metaId}
              aria-current={props.selected ? 'true' : undefined}
              onClick={() => props.onOpen(card.id)}
              onKeyDown={onKey}
              data-testid={`conn-card-open-${card.id}`}
              // The overlay makes the whole card clickable; the ring is drawn by the card.
              className="text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-['']"
            >
              {card.alias}
            </button>
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--ink-60)] truncate">
            {card.providerName}
            {card.providerOrg ? ` · ${card.providerOrg}` : ''}
          </p>
        </div>
        <StatusBadge status={card.status} label={CONNECTION_STATUS_LABEL[card.status]} className="mt-1" />
      </div>

      <dl id={metaId} className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px] leading-[18px]">
        <dt className="text-[var(--ink-50)]">Payer</dt>
        <dd className={`min-w-0 truncate ${card.billedTo ? 'text-[var(--ink-80)]' : 'text-[var(--ink-60)]'}`} data-testid={`conn-card-payer-${card.id}`}>
          {card.payer}
        </dd>
        <dt className="text-[var(--ink-50)]">{ownerLabel(card.kind)}</dt>
        <dd className="min-w-0 truncate text-[var(--ink-80)]">{card.credentialOwner}</dd>
        <dt className="text-[var(--ink-50)]">Workspace</dt>
        <dd className="min-w-0 truncate text-[var(--ink-80)]">{workspaceLabel(props.workspace)}</dd>
        <dt className="text-[var(--ink-50)]">Last checked</dt>
        <dd className="min-w-0 truncate text-[var(--ink-80)] fb-tabular">{card.lastCheckedAt ? fmtAgo(card.lastCheckedAt) : 'Not checked yet'}</dd>
        <dt className="text-[var(--ink-50)]">Projects</dt>
        <dd className="min-w-0 truncate text-[var(--ink-80)]" data-testid={`conn-card-projects-${card.id}`}>
          {card.eligibleProjects.length ? card.eligibleProjects.map((p) => p.title || 'Untitled project').join(', ') : <span className="text-[var(--ink-60)]">None yet</span>}
        </dd>
      </dl>

      {(passed.length > 0 || card.onThisMac) && (
        <ul aria-label="Working now" className="mt-3 flex flex-wrap gap-1.5" data-testid={`conn-card-caps-${card.id}`}>
          {passed.map((cap) => (
            <li key={cap} className="inline-flex items-center gap-1 h-[22px] px-2 rounded-[var(--radius-chip,8px)] bg-[var(--surface-sunken)] text-[12px] text-[var(--ink-80)]">
              <Icon name="check" size={13} className="text-[color:var(--ais-ok)]" />
              {CAPABILITY_LABEL[cap]}
            </li>
          ))}
          {card.onThisMac && (
            <li className="inline-flex items-center gap-1 h-[22px] px-2 rounded-[var(--radius-chip,8px)] bg-[var(--surface-sunken)] text-[12px] text-[var(--ink-80)]" data-testid={`conn-card-local-${card.id}`}>
              <Icon name="laptop_mac" size={13} />
              On this Mac
            </li>
          )}
        </ul>
      )}
    </li>
  )
}
