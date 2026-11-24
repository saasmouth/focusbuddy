// Branches (SPEC-AI-SPACE §1 Tasks, runs and branches; acceptance "Exercise
// branches"): compare draft directions side by side with their actual
// outputs, the sources they rest on and the work left; bring a selected
// change back to the main output with a diff. If the main output changed
// during the review, the change is refused until the person resolves it.

import { useMemo, useState } from 'react'
import Icon from '../Icon'
import type { ProjectViewData, OutputWithMeta } from '@shared/aispace/api'
import { diffLines } from '../../lib/aiSpaceDiff'
import { EmptyState, PrimaryButton, QuietButton, announce, fmtAgo } from './ui'

export default function BranchReview({ view, onChanged }: { view: ProjectViewData; onChanged: () => Promise<void> }): JSX.Element {
  const branches = view.branches.filter((b) => b.status === 'open')
  const [picked, setPicked] = useState<string[]>(() => branches.slice(0, 2).map((b) => b.id))
  if (branches.length === 0) {
    return <EmptyState icon="call_split" title="No branches yet" body="Start a branch from the header to try a different direction without touching the main outputs." testId="ais-branches-empty" />
  }
  const toggle = (id: string): void => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2)))
  return (
    <div data-testid="ais-branch-review">
      <p className="text-[13px] text-[var(--ink-60)]">Pick up to two directions to compare.</p>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Branches to compare">
        {branches.map((b) => (
          <button key={b.id} type="button" aria-pressed={picked.includes(b.id)} onClick={() => toggle(b.id)} className={`h-8 px-3 rounded-lg text-[13px] border focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] ${picked.includes(b.id) ? 'border-[rgb(var(--accent)/0.45)] bg-[rgb(var(--accent)/0.10)] text-[rgb(var(--accent))]' : 'border-[var(--edge-soft)] text-[var(--ink-70)]'}`}>
            {b.name}
          </button>
        ))}
      </div>
      <div className={`mt-4 grid gap-4 ${picked.length === 2 ? 'lg:grid-cols-2' : ''}`}>
        {picked.map((id) => {
          const b = branches.find((x) => x.id === id)
          return b ? <BranchColumn key={id} view={view} branchId={id} name={b.name} createdAt={b.createdAt} onChanged={onChanged} /> : null
        })}
      </div>
    </div>
  )
}

function BranchColumn({ view, branchId, name, createdAt, onChanged }: { view: ProjectViewData; branchId: string; name: string; createdAt: number; onChanged: () => Promise<void> }): JSX.Element {
  const outputs = view.outputs.filter((o) => o.branchId === branchId)
  const tasks = view.tasks.filter((t) => t.branchId === branchId)
  const left = tasks.filter((t) => t.status !== 'done').length
  return (
    <section className="fb-card px-4 py-3" aria-label={`Branch ${name}`} data-testid="ais-branch-column">
      <h3 className="text-[15px] font-semibold inline-flex items-center gap-1.5">
        <Icon name="call_split" size={16} />
        {name}
      </h3>
      <p className="text-[12px] text-[var(--ink-50)]">
        Started {fmtAgo(createdAt)} · {outputs.length} output{outputs.length === 1 ? '' : 's'} · {left === 0 ? 'no tasks left' : `${left} task${left === 1 ? '' : 's'} left`}
      </p>
      {outputs.length === 0 ? (
        <p className="mt-3 text-[13.5px] text-[var(--ink-60)]">Nothing drafted on this branch yet. Switch to it in the header and ask for a deliverable.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {outputs.map((o) => (
            <BranchOutput key={o.id} view={view} branchId={branchId} branchName={name} o={o} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  )
}

function BranchOutput({ view, branchId, branchName, o, onChanged }: { view: ProjectViewData; branchId: string; branchName: string; o: OutputWithMeta; onChanged: () => Promise<void> }): JSX.Element {
  const mains = view.outputs.filter((x) => !x.branchId && x.role !== 'brief' && x.kind === o.kind)
  const guess = mains.find((m) => o.title.toLowerCase().startsWith(m.title.toLowerCase())) ?? mains[0] ?? null
  const [mainId, setMainId] = useState<string>(guess?.id ?? '')
  const [showDiff, setShowDiff] = useState(false)
  const [mainText, setMainText] = useState<string | null>(null)
  const [branchText, setBranchText] = useState<string | null>(null)
  const [sources, setSources] = useState<string[]>([])
  const [conflict, setConflict] = useState<{ currentVersionId: string | null; currentContent: string } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const main = mains.find((m) => m.id === mainId) ?? null

  async function openDiff(): Promise<void> {
    const [b, m] = await Promise.all([window.api.aiSpace.listVersions(o.id), main ? window.api.aiSpace.listVersions(main.id) : Promise.resolve(null)])
    const bv = b.versions.find((v) => v.id === b.output.latestVersionId) ?? b.versions[b.versions.length - 1]
    setBranchText(bv?.content ?? '')
    setSources((bv?.sources ?? []).map((s) => s.label ?? s.type))
    const mv = m ? m.versions.find((v) => v.id === m.output.latestVersionId) : null
    setMainText(mv?.content ?? '')
    setShowDiff(true)
  }

  async function apply(resolvedAgainst?: string | null): Promise<void> {
    if (!main || !o.latestVersionId) return
    const r = await window.api.aiSpace.applyBranchSelection({ branchId, mainOutputId: main.id, fromVersionId: o.latestVersionId, resolvedAgainstVersionId: resolvedAgainst ?? undefined })
    if (r.ok) {
      setConflict(null)
      setDone(`Brought back as ${main.title} v${r.version.n}.`)
      announce(`Applied “${branchName}” to ${main.title}.`)
      await onChanged()
    } else setConflict({ currentVersionId: r.currentVersionId, currentContent: r.currentContent })
  }

  const ops = useMemo(() => (showDiff && mainText !== null && branchText !== null ? diffLines(mainText, branchText) : null), [showDiff, mainText, branchText])
  return (
    <li className="rounded-lg border border-[var(--edge-hairline)] px-3 py-2.5">
      <p className="text-[14px] font-medium">{o.title}</p>
      <p className="mt-1 text-[13px] text-[var(--ink-70)] whitespace-pre-wrap line-clamp-4">{o.latest?.excerpt ?? 'No version yet.'}</p>
      {mains.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-[12px] text-[var(--ink-60)] inline-flex items-center gap-1.5">
            Main output
            <select value={mainId} onChange={(e) => { setMainId(e.target.value); setShowDiff(false) }} className="fb-field h-8 rounded-lg px-2 text-[12.5px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]">
              {mains.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </label>
          <QuietButton icon="compare" onClick={() => void openDiff()} testId="ais-branch-diff">
            Compare with main
          </QuietButton>
        </div>
      )}
      {showDiff && ops && (
        <div className="mt-2">
          {sources.length > 0 && <p className="text-[12px] text-[var(--ink-60)]">Made from: {sources.join(', ')}</p>}
          <div className="mt-1 max-h-64 overflow-auto rounded-lg bg-[var(--surface-sunken)] p-2 font-mono text-[12px]" data-testid="ais-branch-diffview">
            {ops.map((op, i) => (
              <div key={i} className={`whitespace-pre-wrap px-1 ${op.kind === 'add' ? 'bg-[color-mix(in_oklab,var(--ais-ok)_16%,transparent)]' : op.kind === 'del' ? 'bg-[color-mix(in_oklab,var(--ais-bad)_16%,transparent)] line-through' : ''}`}>
                <span className="sr-only">{op.kind === 'add' ? 'Added: ' : op.kind === 'del' ? 'Removed: ' : ''}</span>
                {op.text || ' '}
              </div>
            ))}
          </div>
          <div className="mt-2">
            <PrimaryButton onClick={() => void apply()} testId="ais-branch-apply">
              Bring this back to {main?.title}
            </PrimaryButton>
          </div>
        </div>
      )}
      {conflict && (
        <div role="alert" className="mt-2 rounded-lg border border-[color-mix(in_oklab,var(--ais-warn)_45%,transparent)] p-2.5 text-[13px]" data-testid="ais-branch-conflict">
          <p className="text-[color:var(--ais-warn)]">{main?.title} changed during the review. Here’s what it says now; check it before replacing it.</p>
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-[12px] text-[var(--ink-70)] font-sans">{conflict.currentContent}</pre>
          <div className="mt-2 flex gap-2">
            <QuietButton onClick={() => void apply(conflict.currentVersionId)} testId="ais-branch-resolve">
              Apply on top of the current version
            </QuietButton>
            <QuietButton onClick={() => setConflict(null)}>Not now</QuietButton>
          </div>
        </div>
      )}
      {done && (
        <p className="mt-2 text-[12.5px] text-[color:var(--ais-ok)] inline-flex items-center gap-1" role="status">
          <Icon name="check_circle" size={14} />
          {done}
        </p>
      )}
    </li>
  )
}
