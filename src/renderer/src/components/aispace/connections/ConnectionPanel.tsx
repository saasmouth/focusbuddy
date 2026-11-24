// The side panel for one connection: Overview, Access, Usage, Activity
// (SPEC-CONNECTIONS.md §2 "Open a side panel with Overview, Access, Usage and
// Activity"). It reloads its detail whenever the connection changes, here or
// anywhere else.

import { useCallback, useEffect, useState } from 'react'
import type { ConnectionCard, ConnectionDetailData } from '@shared/aispace/api'
import type { AiWorkspace } from '@shared/aispace/model'
import { CONNECTION_STATUS_LABEL } from '@shared/aispace/connections'
import { Inspector, QuietButton, StatusBadge, Tabs } from '../ui'
import AccessImpactDialog, { type ImpactRequest } from './AccessImpactDialog'
import AccessTab from './AccessTab'
import ActivityTab from './ActivityTab'
import { activeGrantFor, errorText } from './model'
import OverviewTab from './OverviewTab'
import UsageTab from './UsageTab'

type PanelTab = 'overview' | 'access' | 'usage' | 'activity'
const TAB_LABEL: Record<PanelTab, string> = { overview: 'Overview', access: 'Access', usage: 'Usage', activity: 'Activity' }

export default function ConnectionPanel(props: {
  connectionId: string
  card: ConnectionCard | null
  workspaces: AiWorkspace[]
  docked: boolean
  // Bumps whenever main says something changed.
  refreshTick: number
  onClose: () => void
  onChanged: () => void
  onAddSeparate: (providerId: string, workspaceId: string) => void
}): JSX.Element {
  const { connectionId } = props
  const [detail, setDetail] = useState<ConnectionDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<PanelTab>('overview')
  const [impact, setImpact] = useState<ImpactRequest | null>(null)
  const [localTick, setLocalTick] = useState(0)

  useEffect(() => {
    let live = true
    window.api.aiSpace
      .connectionDetail(connectionId)
      .then((d) => {
        if (!live) return
        setDetail(d)
        setError(null)
      })
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [connectionId, props.refreshTick, localTick])

  // A different connection starts on Overview.
  useEffect(() => {
    setTab('overview')
    setDetail(null)
  }, [connectionId])

  const { onChanged } = props
  const changed = useCallback(() => {
    setLocalTick((n) => n + 1)
    onChanged()
  }, [onChanged])

  const card = detail?.connection ?? props.card
  const now = Date.now()
  const grantCount = detail ? detail.projects.filter((p) => activeGrantFor(detail.grants, p.id, now)).length : 0
  const usageCount = card?.usage.calls ?? 0

  return (
    <>
      <Inspector
        open
        docked={props.docked}
        onClose={props.onClose}
        title={card?.alias ?? 'Connection'}
        testId="ais-inspector"
        subtitle={
          card ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{card.providerName}</span>
              <StatusBadge status={card.status} label={CONNECTION_STATUS_LABEL[card.status]} />
            </span>
          ) : undefined
        }
      >
        <div className="ais-touch" data-testid="conn-panel" data-connection-id={connectionId}>
          {error && !detail && (
            <div role="alert" className="py-6 text-[14px] text-[var(--ink-80)]">
              <p>{error}</p>
              <div className="mt-3">
                <QuietButton onClick={() => setLocalTick((n) => n + 1)}>Try again</QuietButton>
              </div>
            </div>
          )}
          {!error && !card && (
            <p role="status" className="py-6 text-[13px] text-[var(--ink-60)]">
              Loading…
            </p>
          )}
          {card && (
            <>
              <Tabs<PanelTab>
                label="Connection details"
                testIdPrefix="conn-tab"
                active={tab}
                onChange={setTab}
                tabs={[
                  { id: 'overview', label: TAB_LABEL.overview },
                  { id: 'access', label: TAB_LABEL.access, count: grantCount },
                  { id: 'usage', label: TAB_LABEL.usage, count: usageCount },
                  { id: 'activity', label: TAB_LABEL.activity }
                ]}
              />
              <div role="tabpanel" aria-label={TAB_LABEL[tab]} className="mt-4" data-testid={`conn-tabpanel-${tab}`}>
                {tab === 'overview' && <OverviewTab card={card} workspaces={props.workspaces} onChanged={changed} onAskImpact={setImpact} onAddSeparate={props.onAddSeparate} />}
                {tab !== 'overview' && !detail && (
                  <p role="status" className="text-[13px] text-[var(--ink-60)]">
                    Loading…
                  </p>
                )}
                {tab === 'access' && detail && <AccessTab card={card} detail={detail} onChanged={changed} onAskImpact={setImpact} />}
                {tab === 'usage' && detail && <UsageTab card={card} detail={detail} />}
                {tab === 'activity' && detail && <ActivityTab card={card} detail={detail} onChanged={changed} />}
              </div>
            </>
          )}
        </div>
      </Inspector>
      {impact && <AccessImpactDialog request={impact} onClose={() => setImpact(null)} />}
    </>
  )
}
