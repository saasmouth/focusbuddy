import { useEffect, useMemo, useState } from 'react'
import type { ChatMessage, FbNode } from '@shared/types'
import { useViewStore } from '../../stores/view'
import Icon from '../Icon'

interface Props {
  taskIds: Set<string>
  nodes: FbNode[]
}

interface HealthInsight {
  id: string
  // The headline question/observation. One short line.
  title: string
  // 1-2 line "why this matters now".
  why: string
  // 'nudge' = soft FYI, 'flag' = needs attention, 'win' = positive recognition.
  tone: 'nudge' | 'flag' | 'win'
  // Optional task or folder id the insight references — clicking jumps there.
  nodeId?: string
  // Optional one-line action.
  action?: string
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Local heuristics — run instantly and surface even before the AI returns.
// AI then adds judgement layers on top (theme detection, prioritisation,
// suggestions the heuristics can't generate). This split keeps the card
// useful when the user has no Anthropic key, and means the AI call only
// runs when explicitly requested.
function localInsights(nodes: FbNode[], taskIds: Set<string>): HealthInsight[] {
  const out: HealthInsight[] = []
  const now = Date.now()

  // 1. Stale folders — last touched 14+ days, has open tasks.
  const folders = nodes.filter((n) => n.kind === 'folder' && !n.archived)
  for (const f of folders) {
    const lastChild = nodes
      .filter((n) => n.parentId === f.id && !n.archived)
      .reduce((max, n) => Math.max(max, n.updatedAt ?? n.createdAt), 0)
    const reference = Math.max(f.updatedAt ?? f.createdAt, lastChild)
    const ageDays = Math.round((now - reference) / 86_400_000)
    const openChildren = nodes.filter(
      (n) =>
        n.parentId === f.id &&
        n.kind === 'task' &&
        n.status !== 'done' &&
        !n.archived
    ).length
    if (ageDays >= 14 && openChildren > 0) {
      out.push({
        id: `stale-${f.id}`,
        title: `${f.title || '(untitled folder)'} hasn't moved in ${ageDays} days`,
        why: `${openChildren} open task${openChildren === 1 ? '' : 's'} sitting idle. Park it, close it, or pick one to ship.`,
        tone: 'flag',
        nodeId: f.id,
        action: 'Open folder'
      })
    }
  }

  // 2. Overdue tasks in scope
  const overdue = nodes.filter(
    (n) =>
      n.kind === 'task' &&
      taskIds.has(n.id) &&
      !n.archived &&
      n.status !== 'done' &&
      n.dueDate != null &&
      n.dueDate < now
  )
  if (overdue.length > 0) {
    out.push({
      id: 'overdue',
      title: `${overdue.length} task${overdue.length === 1 ? ' is' : 's are'} past due`,
      why:
        overdue.length === 1
          ? `"${overdue[0].title || '(untitled)'}" is the oldest one. A 10-min session might be enough.`
          : `Oldest: "${overdue[0].title || '(untitled)'}". Triage 5 minutes now to either re-date or close them.`,
      tone: 'flag',
      nodeId: overdue[0].id,
      action: overdue.length === 1 ? 'Open task' : 'Open oldest'
    })
  }

  // 3. Streak/win — closed N tasks this week
  const thisWeekFloor = now - WEEK_MS
  const closedThisWeek = nodes.filter(
    (n) =>
      n.kind === 'task' &&
      taskIds.has(n.id) &&
      n.status === 'done' &&
      n.completedAt != null &&
      n.completedAt >= thisWeekFloor
  ).length
  if (closedThisWeek >= 5) {
    out.push({
      id: 'streak-win',
      title: `You've closed ${closedThisWeek} task${closedThisWeek === 1 ? '' : 's'} this week`,
      why: `Solid pace. Don't sabotage it by adding 10 new items today — pick one open task to finish first.`,
      tone: 'win'
    })
  }

  // 4. Untouched recent — created last week, no widgets, status still open
  const untouched = nodes.filter(
    (n) =>
      n.kind === 'task' &&
      taskIds.has(n.id) &&
      n.status === 'open' &&
      n.createdAt < now - 5 * 86_400_000 &&
      (n.updatedAt ?? n.createdAt) - n.createdAt < 60_000
  )
  if (untouched.length >= 3) {
    out.push({
      id: 'untouched',
      title: `${untouched.length} tasks created but never opened`,
      why: `If they're not worth a single click, they're not worth keeping. Archive ruthlessly — or pick the smallest one to start.`,
      tone: 'nudge',
      nodeId: untouched[0].id,
      action: 'Open smallest'
    })
  }

  return out.slice(0, 5)
}

function summarisePromptInput(nodes: FbNode[], taskIds: Set<string>): string {
  // Produce a concise inventory of the workspace for Anthropic. Keep this
  // tight — the model only needs shape + signals, not exhaustive lists.
  const folders = nodes
    .filter((n) => n.kind === 'folder' && !n.archived)
    .slice(0, 30)
  const tasks = nodes
    .filter((n) => n.kind === 'task' && taskIds.has(n.id) && !n.archived)
    .slice(0, 80)
  const now = Date.now()
  const lines: string[] = []
  lines.push(`## Folders (${folders.length})`)
  for (const f of folders) {
    const ageDays = Math.round((now - (f.updatedAt ?? f.createdAt)) / 86_400_000)
    lines.push(
      `- ${f.title || '(untitled)'} — id:${f.id.slice(0, 8)} — last update ${ageDays}d ago`
    )
  }
  lines.push('')
  lines.push(`## Tasks (${tasks.length})`)
  for (const t of tasks) {
    const ageDays = Math.round((now - (t.updatedAt ?? t.createdAt)) / 86_400_000)
    const due =
      t.dueDate == null
        ? 'no-due'
        : t.dueDate < now
          ? `OVERDUE-${Math.round((now - t.dueDate) / 86_400_000)}d`
          : `due-in-${Math.round((t.dueDate - now) / 86_400_000)}d`
    lines.push(
      `- ${t.title || '(untitled)'} — id:${t.id.slice(0, 8)} — status:${t.status} — ${due} — touched ${ageDays}d ago`
    )
  }
  return lines.join('\n')
}

const ANALYSIS_SYSTEM_PROMPT = `You are PlexiDesk's "Workspace Health" advisor. Given a snapshot of the user's folders and tasks, surface 3 to 5 SHORT insights that a calm friend would mention over coffee. Be specific, kind, and actionable. Never lecture. Never pile on. Avoid generic productivity advice.

Output STRICTLY a JSON array (no surrounding prose, no markdown) where each item has:
{ "title": "one short line — the observation", "why": "1-2 lines — why this matters now", "tone": "nudge" | "flag" | "win", "nodeId": "optional 8-char id from the input list" }

Prefer surfacing patterns the user can't see at a glance: themes across folders, sequencing problems, momentum signals. Skip anything obvious (e.g. "you have overdue tasks" — the user already sees that).`

// Workspace Health card. Local heuristics show by default; AI analysis
// runs only when the user clicks "Run AI analysis" — respects the
// no-surprise-spending rule for the BYO API key.
export default function WorkspaceHealthCard({ taskIds, nodes }: Props): JSX.Element {
  const goTask = useViewStore((s) => s.goTask)
  const goRoom = useViewStore((s) => s.goRoom)
  const [aiInsights, setAiInsights] = useState<HealthInsight[] | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiLastRunAt, setAiLastRunAt] = useState<number | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const ok = await window.api.chat.hasApiKey()
      if (!cancelled) setHasApiKey(ok)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const local = useMemo(() => localInsights(nodes, taskIds), [nodes, taskIds])
  const combined: HealthInsight[] = aiInsights ? [...aiInsights, ...local] : local

  function jumpTo(insight: HealthInsight): void {
    const wanted = insight.nodeId
    if (!wanted) return
    const node = nodes.find(
      (n) => n.id === wanted || n.id.startsWith(wanted)
    )
    if (!node) return
    // A room shows its desks (see goRoom in stores/view.ts), not a canvas.
    if (node.kind === 'folder') goRoom(node.id)
    else goTask(node.id)
  }

  async function runAi(): Promise<void> {
    if (aiBusy) return
    setAiBusy(true)
    setAiError(null)
    try {
      const inventory = summarisePromptInput(nodes, taskIds)
      const messages: ChatMessage[] = [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT, ts: Date.now() },
        {
          role: 'user',
          content: `Here's the workspace snapshot. Return the JSON array of 3-5 insights.\n\n${inventory}`,
          ts: Date.now()
        }
      ]
      const res = await window.api.chat.send({ taskId: null, messages })
      if (!res.ok || !res.message) {
        setAiError(res.error || 'Could not reach the model.')
        return
      }
      const raw = res.message.content.trim()
      // Strip ```json fences the model sometimes adds despite the system msg.
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim()
      const parsed = JSON.parse(cleaned) as Array<{
        title: string
        why: string
        tone: 'nudge' | 'flag' | 'win'
        nodeId?: string
      }>
      const next: HealthInsight[] = parsed.slice(0, 5).map((p, i) => ({
        id: `ai-${Date.now()}-${i}`,
        title: p.title,
        why: p.why,
        tone: p.tone === 'flag' || p.tone === 'win' ? p.tone : 'nudge',
        nodeId: p.nodeId
      }))
      setAiInsights(next)
      setAiLastRunAt(Date.now())
    } catch (err) {
      setAiError(`The model's reply wasn't valid JSON. Try again. (${(err as Error).message})`)
    } finally {
      setAiBusy(false)
    }
  }

  return (
    <div className="fb-card p-4 fb-glass-soft">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
          <Icon name="health_and_safety" size={12} />
          <span>Workspace health</span>
        </div>
        <div className="flex items-center gap-1">
          {aiLastRunAt && (
            <span className="text-[9px] text-[var(--ink-40)] font-mono">
              AI · {Math.round((Date.now() - aiLastRunAt) / 1000)}s ago
            </span>
          )}
          <button
            onClick={() => void runAi()}
            disabled={aiBusy || hasApiKey === false}
            className="btn-ghost !text-[11px] !px-2 !py-1"
            title={
              hasApiKey === false
                ? 'Add an Anthropic API key in Settings to enable AI analysis'
                : 'Send the workspace snapshot to Claude for a deeper look — uses your API key'
            }
          >
            <Icon name={aiBusy ? 'hourglass_empty' : 'auto_awesome'} size={12} />
            <span>{aiBusy ? 'Thinking…' : aiInsights ? 'Re-run AI' : 'Run AI analysis'}</span>
          </button>
        </div>
      </div>
      {aiError && (
        <div className="mb-2 p-2 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-[11px] text-amber-800 dark:text-amber-300">
          {aiError}
        </div>
      )}
      {combined.length === 0 && (
        <div className="text-center py-6 text-[12px] text-[var(--ink-50)]">
          <Icon
            name="local_florist"
            size={22}
            className="text-[var(--ink-30)] mx-auto mb-2"
          />
          Nothing to flag. Quiet workspace is a good workspace.
          {hasApiKey !== false && (
            <div className="mt-2 text-[10px]">
              Run AI analysis for a deeper look across folders.
            </div>
          )}
        </div>
      )}
      <div className="space-y-2">
        {combined.map((i) => (
          <InsightRow
            key={i.id}
            insight={i}
            onJump={i.nodeId ? () => jumpTo(i) : undefined}
          />
        ))}
      </div>
      {hasApiKey === false && combined.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[var(--edge-soft)] text-[10px] text-[var(--ink-50)] leading-snug">
          Showing local heuristics. Add an Anthropic API key in Settings for AI-driven pattern analysis on top.
        </div>
      )}
    </div>
  )
}

function InsightRow({
  insight,
  onJump
}: {
  insight: HealthInsight
  onJump?: () => void
}): JSX.Element {
  const toneCls =
    insight.tone === 'flag'
      ? 'border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-900/60'
      : insight.tone === 'win'
        ? 'border-emerald-300/60 bg-emerald-50/60 dark:bg-emerald-950/20 dark:border-emerald-900/60'
        : 'border-[var(--edge-soft)] bg-[var(--surface-sunken)]'
  const iconName =
    insight.tone === 'flag'
      ? 'priority_high'
      : insight.tone === 'win'
        ? 'celebration'
        : 'lightbulb'
  const iconCls =
    insight.tone === 'flag'
      ? 'text-amber-600 dark:text-amber-400'
      : insight.tone === 'win'
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-[var(--ink-50)]'
  return (
    <div className={`rounded-md border p-2.5 flex items-start gap-2 ${toneCls}`}>
      <Icon name={iconName} size={14} className={`mt-0.5 shrink-0 ${iconCls}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-[var(--ink-100)] leading-snug">
          {insight.title}
        </div>
        <div className="text-[11px] text-[var(--ink-70)] leading-snug mt-0.5">
          {insight.why}
        </div>
        {onJump && (
          <button
            onClick={onJump}
            className="text-[11px] text-accent mt-1 inline-flex items-center gap-0.5 hover:underline"
          >
            {insight.action || 'Jump there'}
            <Icon name="arrow_forward" size={11} />
          </button>
        )}
      </div>
    </div>
  )
}
