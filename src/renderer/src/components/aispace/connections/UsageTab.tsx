// Side panel › Usage (SPEC-CONNECTIONS.md §7 "Label costs Reported, Estimated,
// or Unavailable … keep budgets distinct from provider invoices"). Tokens and
// amounts carry their own labels: a provider can report tokens while the
// amount is Plexii's estimate. An amount nobody knows reads Unavailable, never
// a made-up zero.

import type { ConnectionCard, ConnectionDetailData } from '@shared/aispace/api'
import Icon from '../../Icon'
import { EmptyState, fmtMoney, LinkButton } from '../ui'
import { combinedSource, fmtCount, SOURCE_LABEL } from './model'

export default function UsageTab(props: { card: ConnectionCard; detail: ConnectionDetailData }): JSX.Element {
  const { card, detail } = props
  const u = card.usage
  const finals = detail.usage.filter((e) => e.state === 'final')
  const tokensLabel = combinedSource(finals.map((e) => e.tokensSource))
  const amountKnown = u.calls - u.unknownAmounts
  const amountLabel = u.calls === 0 ? null : amountKnown === 0 ? 'unavailable' : u.estimated ? 'estimated' : combinedSource(finals.filter((e) => e.amountMicros !== null).map((e) => e.amountSource)) ?? 'estimated'
  const projectTitle = new Map(detail.projects.map((p) => [p.id, p.title]))

  return (
    <div className="space-y-6" data-testid="conn-usage">
      {u.calls === 0 ? (
        <EmptyState icon="query_stats" title="No usage yet" body={card.kind === 'ai_account' ? 'Web accounts don’t report usage to Plexii. Your plan’s usage is on the provider’s site.' : 'Calls made through this connection will show here with tokens and cost.'} testId="conn-usage-empty" />
      ) : (
        <dl className="grid grid-cols-2 gap-3" data-testid="conn-usage-totals">
          <Total term="Calls" value={fmtCount(u.calls)} />
          <Total term="Amount" value={amountLabel === 'unavailable' ? 'Unavailable' : fmtMoney(u.amountMicros)} source={amountLabel ? SOURCE_LABEL[amountLabel] : null} note={u.unknownAmounts > 0 && amountKnown > 0 ? `${fmtCount(u.unknownAmounts)} call${u.unknownAmounts === 1 ? '' : 's'} without an amount` : null} testId="conn-usage-amount" />
          <Total term="Input tokens" value={fmtCount(u.inputTokens)} source={tokensLabel ? SOURCE_LABEL[tokensLabel] : null} testId="conn-usage-input" />
          <Total term="Output tokens" value={fmtCount(u.outputTokens)} source={tokensLabel ? SOURCE_LABEL[tokensLabel] : null} testId="conn-usage-output" />
        </dl>
      )}

      <div className="rounded-[var(--radius-row)] bg-[var(--surface-sunken)] p-3 text-[13px] leading-relaxed text-[var(--ink-70)]" data-testid="conn-usage-note">
        <p className="flex items-start gap-1.5">
          <Icon name="info" size={15} className="mt-0.5 shrink-0 text-[var(--ink-50)]" />
          <span>Budgets are Plexii limits, not your provider invoice. Only calls made through Plexii are counted here.</span>
        </p>
        {card.billingUrl && (
          <div className="mt-1.5 pl-[21px]">
            <LinkButton onClick={() => void window.api.aiSpace.openOriginal(card.billingUrl!)} testId="conn-usage-billing">
              Open {card.providerName} billing
              <Icon name="open_in_new" size={14} />
            </LinkButton>
          </div>
        )}
      </div>

      {detail.usage.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]" data-testid="conn-usage-table">
            <caption className="sr-only">Usage entries for {card.alias}</caption>
            <thead>
              <tr className="text-left text-[12px] text-[var(--ink-50)]">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Date
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Project
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Model
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium text-right">
                  Tokens in / out
                </th>
                <th scope="col" className="py-1.5 font-medium text-right">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--edge-hairline)]">
              {detail.usage.map((e) => (
                <tr key={e.id} className="align-top text-[var(--ink-80)]">
                  <td className="py-2 pr-3 whitespace-nowrap fb-tabular">{new Date(e.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td>
                  <td className="py-2 pr-3">{e.projectId ? projectTitle.get(e.projectId) ?? 'Another project' : '—'}</td>
                  <td className="py-2 pr-3">
                    {e.model ?? '—'}
                    {e.state !== 'final' && <span className="block text-[12px] text-[var(--ink-50)]">{e.state === 'reserved' ? 'Reserved, not final' : 'Released'}</span>}
                  </td>
                  <td className="py-2 pr-3 text-right fb-tabular whitespace-nowrap">
                    {e.inputTokens === null && e.outputTokens === null ? 'Unavailable' : `${e.inputTokens === null ? '—' : fmtCount(e.inputTokens)} / ${e.outputTokens === null ? '—' : fmtCount(e.outputTokens)}`}
                    <span className="block text-[12px] text-[var(--ink-50)]">{SOURCE_LABEL[e.tokensSource]}</span>
                  </td>
                  <td className="py-2 text-right fb-tabular whitespace-nowrap">
                    {fmtMoney(e.amountMicros, e.currency)}
                    <span className="block text-[12px] text-[var(--ink-50)]">{SOURCE_LABEL[e.amountMicros === null ? 'unavailable' : e.amountSource]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Total(props: { term: string; value: string; source?: string | null; note?: string | null; testId?: string }): JSX.Element {
  return (
    <div className="rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-3 py-2.5" data-testid={props.testId}>
      <dt className="text-[12px] text-[var(--ink-50)]">{props.term}</dt>
      <dd className="mt-0.5 text-[18px] font-semibold text-[var(--ink-100)] fb-tabular">{props.value}</dd>
      {props.source && <dd className="text-[12px] text-[var(--ink-60)]">{props.source}</dd>}
      {props.note && <dd className="text-[12px] text-[var(--ink-50)]">{props.note}</dd>}
    </div>
  )
}
