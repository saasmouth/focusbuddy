import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon'
import { DashboardHeader, StatusPill } from '../plexi'
import ModuleDashboard from '../ModuleDashboard'
import { useQuickCreate } from '../../stores/quickCreate'
import { useLandOnContent } from '../../hooks/useLandOnContent'
import { bucketByWeek, periodDelta, countByKey } from '../../lib/dashboardMetrics'
import type { FbTable } from '@shared/fields'
import type { ReportDef, ReportSchedule } from '@shared/reports'

// PlexiReports: turn your tables into a written report, generated on a schedule
// and emailed to the people who need it. The narrative is written by the AI when
// an Anthropic key is set; without one the report is an honest data summary,
// clearly labelled as such, never a fabricated narrative. Delivery reuses the
// existing mail send, so it succeeds only with a real mail account configured.

const SCHEDULES: { value: ReportSchedule; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }
]

function fmtWhen(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function PlexiReportsView(): JSX.Element {
  const [reports, setReports] = useState<ReportDef[] | null>(null)
  const [tables, setTables] = useState<FbTable[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load(): Promise<void> {
    setError(null)
    try {
      const [r, t] = await Promise.all([window.api.reports.list(), window.api.tables.list()])
      setReports(r)
      setTables(t)
    } catch (e) {
      setError(`Could not load reports: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  useEffect(() => {
    void load()
    // Run any scheduled reports that have come due. Best-effort and honest: a
    // report with no AI key produces a data summary, never a fake narrative.
    void window.api.reports
      .runDue()
      .then(() => load())
      .catch((e) => setError(`Could not run due reports: ${e instanceof Error ? e.message : String(e)}`))
  }, [])

  async function addReport(): Promise<void> {
    setError(null)
    try {
      const created = await window.api.reports.create({ title: 'New report' })
      await load()
      setSelectedId(created.id)
    } catch (e) {
      setError(`Could not create a report: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Global quick-create (Cmd+K "New report").
  const quickPending = useQuickCreate((s) => s.pending)
  useEffect(() => {
    if (quickPending === 'reports' && useQuickCreate.getState().consume('reports')) void addReport()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickPending])

  const selected = reports?.find((r) => r.id === selectedId) ?? null
  const { showOverview } = useLandOnContent(reports !== null, reports ?? [], selectedId, setSelectedId)
  const reportList = reports ?? []
  const now = Date.now()

  return (
    <div className="h-full w-full flex bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="plexireports-view">
      {/* List */}
      <div className="w-[300px] shrink-0 border-r border-[var(--edge-soft)] flex flex-col">
        <div className="px-4 py-3.5 border-b border-[var(--edge-soft)]">
          <div className="flex items-center gap-2">
            <Icon name="summarize" size={18} className="text-[rgb(var(--accent))]" filled />
            <h1 className="fb-display text-[15px] font-bold tracking-tight">PlexiiReports</h1>
          </div>
          <p className="mt-0.5 text-[11.5px] text-[var(--ink-70)]">Reports from your tables, on a schedule.</p>
        </div>
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void addReport()}
              data-testid="report-new"
              className="flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-md bg-[rgb(var(--accent))] text-white text-[12.5px] font-medium hover:bg-[rgb(var(--accent-hover))]"
            >
              <Icon name="add" size={15} /> New report
            </button>
            {reports && reports.length > 0 && (
              <button
                onClick={showOverview}
                data-testid="report-overview"
                title="Module overview"
                aria-label="Module overview"
                className={`inline-flex items-center justify-center h-8 w-8 rounded-md border text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] ${selectedId ? 'border-[var(--edge-soft)]' : 'border-[rgb(var(--accent)/0.40)] text-[rgb(var(--accent))]'}`}
              >
                <Icon name="dashboard" size={15} />
              </button>
            )}
          </div>
          {error && <p className="mt-2 text-rose-500 text-[12px]" data-testid="reports-error">{error}</p>}
        </div>
        <div className="flex-1 overflow-auto px-2 pb-2">
          {reports === null ? (
            <p className="px-3 py-6 text-[12px] text-[var(--ink-70)]">Loading…</p>
          ) : reports.length === 0 ? (
            <div className="px-3 py-10 text-center" data-testid="reports-empty">
              <Icon name="summarize" size={24} className="text-[var(--ink-30)]" />
            </div>
          ) : (
            reports.map((r) => (
              <button
                key={r.id}
                data-testid={`report-card-${r.id}`}
                onClick={() => setSelectedId(r.id)}
                className={`w-full text-left rounded-lg px-3 py-2.5 mb-1 border transition-colors ${
                  r.id === selectedId
                    ? 'bg-[rgb(var(--accent)/0.10)] border-[rgb(var(--accent)/0.30)]'
                    : 'hover:bg-[var(--surface-sunken)] border-transparent'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-semibold truncate flex-1 min-w-0">{r.title || 'Untitled report'}</span>
                  <StatusPill tone={r.schedule === 'manual' ? 'stone' : 'accent'} label={r.schedule} dot={false} />
                </div>
                <p className="mt-0.5 text-[11px] text-[var(--ink-50)] fb-tabular">Last run {fmtWhen(r.lastRunAt)}</p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-w-0 overflow-auto">
        {selected ? (
          <ReportEditor key={selected.id} report={selected} tables={tables} onChanged={load} />
        ) : (
          <ModuleDashboard
            moduleKey="reports"
            title="Reports"
            subtitle="Turn the tables you already keep into a written report, on a schedule, emailed to your team"
            icon="summarize"
            accentClass="text-sky-500"
            stats={[
              {
                icon: 'summarize',
                label: 'Reports',
                value: reportList.length,
                tone: 'sky',
                delta: periodDelta(reportList.map((r) => r.createdAt), 7 * 86400000, now),
                sparkline: bucketByWeek(reportList.map((r) => r.createdAt), 8, now)
              },
              { icon: 'schedule', label: 'Scheduled', value: reportList.filter((r) => r.schedule !== 'manual').length, tone: 'accent' },
              { icon: 'pending_actions', label: 'Never run', value: reportList.filter((r) => !r.lastRunAt).length, tone: 'amber' },
              { icon: 'auto_awesome', label: 'AI-written', value: reportList.filter((r) => r.lastOutputIsAi).length, tone: 'violet' }
            ]}
            timeline={{
              title: 'Reports created',
              points: bucketByWeek(reportList.map((r) => r.createdAt), 8, now),
              bucketLabel: 'last 8 weeks',
              unit: 'reports',
              tone: 'sky',
              emptyHint: 'Create your first report to see your cadence here.'
            }}
            breakdown={{
              title: 'By schedule',
              icon: 'event_repeat',
              items: countByKey(reportList, (r) => SCHEDULES.find((s) => s.value === r.schedule)?.label ?? r.schedule).map((b) => ({
                label: b.label,
                value: b.value,
                tone: b.label === 'Manual' ? ('stone' as const) : ('sky' as const)
              })),
              emptyHint: 'No reports yet.'
            }}
            recentItems={{
              label: 'Your reports',
              items: reportList.slice(0, 6).map((r) => ({
                id: r.id,
                title: r.title,
                subtitle: r.recipients.length ? `${r.recipients.length} recipient(s)` : 'No recipients yet',
                meta: r.lastRunAt ? `Last run ${fmtWhen(r.lastRunAt)}` : 'Not run yet',
                status:
                  r.schedule !== 'manual'
                    ? { tone: 'sky' as const, label: SCHEDULES.find((s) => s.value === r.schedule)?.label ?? r.schedule }
                    : undefined,
                onOpen: () => setSelectedId(r.id)
              })),
              onCreate: () => void addReport(),
              createLabel: 'New report',
              emptyHint: 'No reports yet. Create one to summarise a table on a schedule and send it to the people who need it.'
            }}
          />
        )}
      </div>
    </div>
  )
}

function ReportEditor({
  report,
  tables,
  onChanged
}: {
  report: ReportDef
  tables: FbTable[]
  onChanged: () => Promise<void>
}): JSX.Element {
  const [title, setTitle] = useState(report.title)
  const [recipientsText, setRecipientsText] = useState(report.recipients.join(', '))
  const [output, setOutput] = useState<string | null>(report.lastOutput)
  const [isAi, setIsAi] = useState(report.lastOutputIsAi)
  const [needsKey, setNeedsKey] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [deliverMsg, setDeliverMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function patch(p: Parameters<typeof window.api.reports.update>[1]): Promise<void> {
    setError(null)
    try {
      await window.api.reports.update(report.id, p)
      await onChanged()
    } catch (e) {
      setError(`Could not save the report: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Flush any pending title/recipients edits if this editor unmounts (the editor
  // is keyed by report.id and remounts when the selection changes), so switching
  // reports before an input blur does not silently lose the edit.
  const flushRef = useRef<{ title: string; recipientsText: string }>({ title, recipientsText })
  flushRef.current = { title, recipientsText }
  useEffect(() => {
    return () => {
      const { title: t, recipientsText: rt } = flushRef.current
      const recipients = rt.split(',').map((s) => s.trim()).filter(Boolean)
      const sameRecipients =
        recipients.length === report.recipients.length &&
        recipients.every((r, i) => r === report.recipients[i])
      if (t !== report.title || !sameRecipients) {
        void window.api.reports.update(report.id, { title: t, recipients }).catch(() => {})
      }
    }
    // Only the report identity matters for the cleanup target; values are read
    // from the ref at unmount time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.id])

  function toggleTable(id: string): void {
    const next = report.sourceTableIds.includes(id)
      ? report.sourceTableIds.filter((x) => x !== id)
      : [...report.sourceTableIds, id]
    void patch({ sourceTableIds: next })
  }

  async function generate(): Promise<void> {
    setGenerating(true)
    setDeliverMsg(null)
    setError(null)
    try {
      const r = await window.api.reports.generate(report.id)
      setOutput(r.output)
      setIsAi(r.isAi)
      setNeedsKey(!!r.needsApiKey)
      await onChanged()
    } catch (e) {
      setError(`Could not generate the report: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGenerating(false)
    }
  }

  async function emailReport(): Promise<void> {
    const recipients = recipientsText.split(',').map((s) => s.trim()).filter(Boolean)
    if (recipients.length === 0) {
      setDeliverMsg('Add at least one recipient email first.')
      return
    }
    if (!output) {
      setDeliverMsg('Generate the report before sending it.')
      return
    }
    setDeliverMsg('Sending…')
    try {
      const res = await window.api.mail.send({ to: recipients, subject: report.title, text: output })
      setDeliverMsg(res.ok ? `Sent to ${recipients.length} recipient(s).` : `Could not send: ${res.error}`)
    } catch (e) {
      setDeliverMsg(`Could not send: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <DashboardHeader title="Report" subtitle="Choose the tables, set a schedule, generate and deliver" />

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title !== report.title && void patch({ title })}
        data-testid="report-title"
        placeholder="Report title"
        aria-label="Report title"
        className="fb-display-hero w-full bg-transparent text-[20px] font-bold text-[var(--ink-100)] placeholder:text-[var(--ink-50)] mb-4"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-50)]">Source tables</span>
          <div className="mt-1.5 space-y-1 max-h-48 overflow-auto">
            {tables.length === 0 ? (
              <p className="text-[12px] text-[var(--ink-70)]">No tables yet. Create a table in PlexiiTables or on a desk, then it can feed a report.</p>
            ) : (
              tables.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-[12.5px] text-[var(--ink-90)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={report.sourceTableIds.includes(t.id)}
                    onChange={() => toggleTable(t.id)}
                    data-testid={`report-table-${t.id}`}
                    className="accent-[rgb(var(--accent))]"
                  />
                  <span className="truncate">{t.title || 'Untitled table'}</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-50)]">Schedule</span>
            <select
              value={report.schedule}
              data-testid="report-schedule"
              onChange={(e) => void patch({ schedule: e.target.value as ReportSchedule })}
              className="fb-card mt-1.5 w-full px-2 py-1.5 text-[12.5px] text-[var(--ink-100)]"
            >
              {SCHEDULES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-50)]">Recipients</span>
            <input
              value={recipientsText}
              onChange={(e) => setRecipientsText(e.target.value)}
              onBlur={() => void patch({ recipients: recipientsText.split(',').map((s) => s.trim()).filter(Boolean) })}
              data-testid="report-recipients"
              placeholder="name@company.com, ..."
              className="fb-card mt-1.5 w-full px-2 py-1.5 text-[12.5px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)]"
            />
          </label>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-2">
        <button
          onClick={() => void generate()}
          disabled={generating}
          data-testid="report-generate"
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[rgb(var(--accent))] text-white text-[13px] font-medium hover:bg-[rgb(var(--accent-hover))] disabled:opacity-40"
        >
          <Icon name="auto_awesome" size={15} /> {generating ? 'Generating…' : 'Generate now'}
        </button>
        <button
          onClick={() => void emailReport()}
          data-testid="report-email"
          className="fb-btn-surface inline-flex items-center gap-1.5 h-9 px-4 text-[13px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
        >
          <Icon name="send" size={15} /> Email to recipients
        </button>
        {deliverMsg && <span className="text-[12px] text-[var(--ink-70)]">{deliverMsg}</span>}
      </div>

      {error && <p className="mt-3 text-rose-500 text-[12px]" data-testid="report-editor-error">{error}</p>}

      {output != null && (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-50)]">Output</span>
            {isAi ? (
              <StatusPill tone="violet" label="AI narrative" dot={false} />
            ) : (
              <StatusPill tone="stone" label="Data summary" dot={false} />
            )}
          </div>
          {needsKey && (
            <p className="mb-2 text-[12px] text-[var(--ink-70)]">
              This is a plain data summary. Add an Anthropic key in Settings to get a written narrative.
            </p>
          )}
          <pre
            data-testid="report-output"
            className="fb-card whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink-90)] p-4 font-sans"
          >
            {output}
          </pre>
        </div>
      )}
    </div>
  )
}
