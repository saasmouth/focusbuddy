// Outputs (SPEC-AI-SPACE §1 Outputs): one stable entry per output, filed by
// type; cards with a real preview, task, branch and review state; separate
// latest-draft and approved pointers, each previewable without moving either;
// versions with author, sources and what changed; compare; export; reuse.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import Icon from '../Icon'
import type { OutputWithMeta, ProjectViewData, VersionMeta } from '@shared/aispace/api'
import type { AiOutput, AiWorkspace, OutputKind, OutputVersion, RecordRef } from '@shared/aispace/model'
import { OUTPUT_KINDS, OUTPUT_KIND_LABEL } from '@shared/aispace/model'
import { diffLines, sharedHeadings } from '../../lib/aiSpaceDiff'
import { EmptyState, LinkButton, PrimaryButton, QuietButton, StatusBadge, announce, authorLabel, fmtAgo, fmtWhen, reviewStatus } from './ui'
import { useNoticeStore } from '../../stores/notice'

const KIND_ICON: Record<OutputKind, string> = {
  document: 'description',
  sheet: 'table',
  slides: 'slideshow',
  image: 'image',
  canvas: 'dashboard',
  site: 'language',
  code: 'code',
  media: 'movie',
  other: 'draft'
}

export function OutputsGrid(props: { view: ProjectViewData; onOpen: (outputId: string) => void; onNew: () => void; selectedId?: string | null }): JSX.Element {
  const outputs = props.view.outputs.filter((o) => o.role !== 'brief')
  const byKind = useMemo(() => {
    const m = new Map<OutputKind, OutputWithMeta[]>()
    for (const o of outputs) m.set(o.kind, [...(m.get(o.kind) ?? []), o])
    return m
  }, [outputs])
  const [filter, setFilter] = useState<OutputKind | 'all'>('all')
  if (outputs.length === 0) {
    return <EmptyState icon="inventory_2" title="No outputs yet" body="Outputs appear here when a run finishes or you add one. Each keeps every version." action={{ label: 'Add an output', run: props.onNew, testId: 'ais-outputs-empty-new' }} testId="ais-outputs-empty" />
  }
  const kinds = OUTPUT_KINDS.filter((k) => byKind.has(k))
  return (
    <div data-testid="ais-outputs">
      <div className="flex flex-wrap items-center gap-1.5 mb-4" role="group" aria-label="Filter outputs by type">
        <FilterChip on={filter === 'all'} label={`All (${outputs.length})`} onClick={() => setFilter('all')} />
        {kinds.map((k) => (
          <FilterChip key={k} on={filter === k} label={`${OUTPUT_KIND_LABEL[k]} (${byKind.get(k)!.length})`} onClick={() => setFilter(k)} />
        ))}
        <span className="ml-auto">
          <QuietButton icon="add" onClick={props.onNew} testId="ais-outputs-new">
            Add output
          </QuietButton>
        </span>
      </div>
      {(filter === 'all' ? kinds : [filter]).map((k) => (
        <section key={k} className="mb-7" aria-label={OUTPUT_KIND_LABEL[k]}>
          <h3 className="text-[13px] font-medium text-[var(--ink-60)] mb-2 inline-flex items-center gap-1.5">
            <Icon name={KIND_ICON[k]} size={15} />
            {OUTPUT_KIND_LABEL[k]}
          </h3>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {byKind.get(k)!.map((o) => (
              <li key={o.id}>
                <OutputCard o={o} view={props.view} onOpen={() => props.onOpen(o.id)} selected={props.selectedId === o.id} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function FilterChip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`h-8 px-3 rounded-lg text-[13px] border focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] ${on ? 'border-[rgb(var(--accent)/0.45)] bg-[rgb(var(--accent)/0.10)] text-[rgb(var(--accent))]' : 'border-[var(--edge-soft)] text-[var(--ink-70)]'}`}>
      {label}
    </button>
  )
}

function OutputCard({ o, view, onOpen, selected }: { o: OutputWithMeta; view: ProjectViewData; onOpen: () => void; selected: boolean }): JSX.Element {
  const task = o.aiTaskId ? view.tasks.find((t) => t.id === o.aiTaskId) : null
  const branch = o.branchId ? view.branches.find((b) => b.id === o.branchId) : null
  const v = o.latest
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="ais-output-card"
      aria-current={selected ? 'true' : undefined}
      className={`w-full h-full text-left fb-card overflow-hidden flex flex-col hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] ${selected ? 'ring-2 ring-[rgb(var(--accent)/0.5)]' : ''}`}
    >
      <Preview kind={o.kind} v={v} compact />
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium truncate">{o.title}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-[var(--ink-60)]">
          <StatusBadge status={reviewStatus(o.reviewState)} />
          {v && <span className="fb-tabular">Latest v{v.n}</span>}
          {o.approved && <span className="fb-tabular">Approved v{o.approved.n}</span>}
          {o.publishedVersionId && <span>Published</span>}
        </div>
        <div className="mt-1 text-[12px] text-[var(--ink-50)] truncate">
          {task ? task.title : 'No task'}
          {branch ? ` · branch “${branch.name}”` : ' · main'}
          {v ? ` · ${fmtAgo(v.createdAt)}` : ''}
        </div>
      </div>
    </button>
  )
}

// A real preview: images at their own aspect ratio, sites as a dated preview,
// documents and code as their text.
export function Preview({ kind, v, compact, full }: { kind: OutputKind; v: VersionMeta | OutputVersion | null; compact?: boolean; full?: boolean }): JSX.Element {
  if (!v) return <div className="h-24 bg-[var(--surface-sunken)] flex items-center justify-center text-[12px] text-[var(--ink-50)]">No version yet</div>
  const text = 'content' in v ? v.content : v.excerpt
  if (kind === 'image' && v.mediaRef && /^(data:image\/|https:\/\/)/.test(v.mediaRef)) {
    const ratio = v.mediaWidth && v.mediaHeight ? `${v.mediaWidth} / ${v.mediaHeight}` : undefined
    return (
      <div className="bg-[var(--surface-sunken)]">
        <img src={v.mediaRef} alt={text || 'Output image'} style={{ aspectRatio: ratio }} className={`w-full ${compact ? 'max-h-48' : ''} object-contain`} />
      </div>
    )
  }
  if (kind === 'site' && full) {
    return (
      <div className="border border-[var(--edge-soft)] rounded-lg overflow-hidden">
        <div className="px-3 py-1.5 text-[11.5px] text-[var(--ink-60)] bg-[var(--surface-sunken)] border-b border-[var(--edge-hairline)]">Preview of v{v.n}, saved {fmtWhen(v.createdAt)} — not the live site</div>
        {/* No scripts, no same-origin: a static, dated rendering only. */}
        <iframe title={`Site preview v${v.n}`} sandbox="" referrerPolicy="no-referrer" srcDoc={text} className="w-full h-[420px] bg-white" />
      </div>
    )
  }
  return (
    <div className={`${compact ? 'h-28 overflow-hidden' : ''} bg-[var(--surface-sunken)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--ink-80)] ${kind === 'code' || kind === 'site' ? 'font-mono text-[12px] whitespace-pre-wrap' : 'whitespace-pre-wrap'}`}>
      {kind === 'site' && compact && <span className="block text-[11px] text-[var(--ink-50)] mb-1 font-sans">Dated preview · v{v.n} · {fmtAgo(v.createdAt)}</span>}
      {compact ? text.slice(0, 360) : text}
    </div>
  )
}

// ── The output inspector ──────────────────────────────────────────────────────

export function OutputInspectorBody(props: {
  outputId: string
  focusVersionId?: string | null
  initialCompare?: [string, string] | null
  workspaces: AiWorkspace[]
  onReference: (ref: RecordRef) => void
  onChanged: () => void
}): JSX.Element {
  const [data, setData] = useState<{ output: AiOutput; versions: OutputVersion[] } | null>(null)
  const [sel, setSel] = useState<string | null>(props.focusVersionId ?? null)
  const [compare, setCompare] = useState<[string, string] | null>(props.initialCompare ?? null)
  const [editing, setEditing] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  async function load(): Promise<void> {
    const d = await window.api.aiSpace.listVersions(props.outputId)
    setData(d)
    setSel((cur) => cur ?? d.output.latestVersionId ?? d.versions[d.versions.length - 1]?.id ?? null)
  }
  useEffect(() => {
    void load()
    const off = window.api.aiSpace.onChanged((p) => {
      if (p.topic === 'event') void load()
    })
    return off
  }, [props.outputId])
  useEffect(() => {
    if (props.focusVersionId) setSel(props.focusVersionId)
  }, [props.focusVersionId])
  useEffect(() => {
    if (props.initialCompare) setCompare(props.initialCompare)
  }, [props.initialCompare])

  if (!data) return <div className="fb-skeleton h-32 rounded-lg" aria-busy="true" />
  const { output, versions } = data
  const v = versions.find((x) => x.id === sel) ?? versions[versions.length - 1] ?? null
  const latest = versions.find((x) => x.id === output.latestVersionId) ?? null
  const approved = versions.find((x) => x.id === output.approvedVersionId) ?? null
  const published = versions.find((x) => x.id === output.publishedVersionId) ?? null

  async function approve(id: string): Promise<void> {
    await window.api.aiSpace.approveVersion(output.id, id)
    setFlash(id)
    announce(`${output.title} v${versions.find((x) => x.id === id)?.n} approved.`)
    await load()
    props.onChanged()
  }

  if (compare) {
    const a = versions.find((x) => x.id === compare[0])!
    const b = versions.find((x) => x.id === compare[1])!
    return <CompareView output={output} versions={versions} a={a} b={b} onPick={(x, y) => setCompare([x, y])} onClose={() => setCompare(null)} />
  }

  return (
    <div data-testid="ais-output-inspector" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <StatusBadge status={reviewStatus(output.reviewState)} />
        <span className="text-[var(--ink-60)]">{OUTPUT_KIND_LABEL[output.kind]}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[12px]" aria-label="Pointers">
        <Pointer label="Latest draft" v={latest} active={v?.id === latest?.id} onClick={() => latest && setSel(latest.id)} />
        <Pointer label="Approved" v={approved} active={Boolean(approved) && v?.id === approved?.id} onClick={() => approved && setSel(approved.id)} />
        {output.kind === 'site' ? <Pointer label="Published" v={published} active={Boolean(published) && v?.id === published?.id} onClick={() => published && setSel(published.id)} /> : <span />}
      </div>

      {v && (
        <>
          <div className="flex items-center gap-2">
            <h3 className="text-[14px] font-semibold">Version {v.n}</h3>
            <span className="text-[12px] text-[var(--ink-50)]">
              {authorLabel(v.author)} · {fmtWhen(v.createdAt)}
            </span>
          </div>
          {v.changeSummary && <p className="text-[13px] text-[var(--ink-70)]">What changed: {v.changeSummary}</p>}
          {v.sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Made from">
              <span className="text-[12px] text-[var(--ink-50)]">Made from:</span>
              {v.sources.map((s, i) => (
                <span key={i} className="text-[12px] px-1.5 py-0.5 rounded-md border border-[var(--edge-soft)] text-[var(--ink-70)]">
                  {s.label ?? s.type}
                </span>
              ))}
            </div>
          )}
          <div className="max-h-[420px] overflow-auto rounded-lg">
            <Preview kind={output.kind} v={v} full />
          </div>
          <div className="flex flex-wrap gap-2">
            {output.approvedVersionId !== v.id && (
              <PrimaryButton onClick={() => void approve(v.id)} testId="ais-approve-version">
                Approve v{v.n}
              </PrimaryButton>
            )}
            {output.kind === 'site' && output.publishedVersionId !== v.id && output.approvedVersionId === v.id && (
              <QuietButton
                onClick={async () => {
                  await window.api.aiSpace.publishVersion(output.id, v.id)
                  announce(`Marked v${v.n} as the published version.`)
                  await load()
                  props.onChanged()
                }}
                title="Records which version is live. Plexii doesn't publish the site itself."
              >
                Mark as published
              </QuietButton>
            )}
            {output.reviewState === 'draft' && (
              <QuietButton
                onClick={async () => {
                  await window.api.aiSpace.setReviewState(output.id, 'in_review')
                  await load()
                  props.onChanged()
                }}
              >
                Ask for review
              </QuietButton>
            )}
            {versions.length > 1 && (
              <QuietButton icon="compare" onClick={() => setCompare([approved && approved.id !== v.id ? approved.id : versions[Math.max(0, versions.indexOf(v) - 1)].id, v.id])} testId="ais-compare">
                Compare
              </QuietButton>
            )}
            {(output.kind === 'document' || output.kind === 'code' || output.kind === 'site' || output.kind === 'other') && (
              <QuietButton icon="edit" onClick={() => setEditing(true)} testId="ais-edit-version">
                Edit as new version
              </QuietButton>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <LinkButton onClick={() => props.onReference({ type: 'output', id: output.id, follow: 'approved', label: `${output.title} (approved)` })} testId="ais-use-approved">
              Use approved version
            </LinkButton>
            <LinkButton onClick={() => props.onReference({ type: 'version', id: v.id, versionId: v.id, follow: 'pinned', label: `${output.title} v${v.n}` })} testId="ais-pin-version">
              Pin this version
            </LinkButton>
            <LinkButton
              onClick={async () => {
                const r = await window.api.aiSpace.exportVersion(v.id)
                if (r.ok) useNoticeStore.getState().show({ text: 'Exported.', icon: 'check' })
              }}
            >
              Export
            </LinkButton>
            {props.workspaces.length > 1 && <ShareMenu output={output} version={v} workspaces={props.workspaces} />}
          </div>
        </>
      )}

      {editing && v && (
        <EditVersion
          output={output}
          base={latest ?? v}
          onDone={async () => {
            setEditing(false)
            await load()
            props.onChanged()
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      <div>
        <h3 className="text-[13px] font-medium text-[var(--ink-60)] mb-1.5">All versions</h3>
        <ol className="space-y-1" data-testid="ais-version-list">
          {[...versions].reverse().map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => setSel(x.id)}
                aria-current={x.id === v?.id ? 'true' : undefined}
                className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center gap-2 text-[13px] hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] ${x.id === v?.id ? 'bg-[rgb(var(--accent)/0.08)]' : ''} ${flash === x.id ? 'ais-flash' : ''}`}
              >
                <span className="fb-tabular w-8 shrink-0">v{x.n}</span>
                <span className="min-w-0 flex-1 truncate">{x.changeSummary || 'No summary'}</span>
                {output.approvedVersionId === x.id && <Icon name="verified" size={14} className="text-[color:var(--ais-ok)]" aria-label="Approved" />}
                <span className="text-[11.5px] text-[var(--ink-50)] shrink-0">{authorLabel(x.author)}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function Pointer({ label, v, active, onClick }: { label: string; v: OutputVersion | null; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" disabled={!v} onClick={onClick} aria-pressed={active} className={`rounded-lg border px-2.5 py-2 text-left disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] ${active ? 'border-[rgb(var(--accent)/0.45)] bg-[rgb(var(--accent)/0.08)]' : 'border-[var(--edge-soft)]'}`}>
      <span className="block text-[var(--ink-50)]">{label}</span>
      <span className="block fb-tabular text-[13px] text-[var(--ink-90)]">{v ? `v${v.n}` : '—'}</span>
    </button>
  )
}

function ShareMenu({ output, version, workspaces }: { output: AiOutput; version: OutputVersion; workspaces: AiWorkspace[] }): JSX.Element {
  return (
    <select
      aria-label="Share this version into another workspace"
      value=""
      onChange={async (e) => {
        const ws = e.target.value
        if (!ws) return
        await window.api.aiSpace.shareVersion(output.id, version.id, ws)
        useNoticeStore.getState().show({ text: `Shared v${version.n} only. Nothing else in this project is visible there.`, icon: 'share' })
      }}
      className="fb-field h-7 rounded-md px-2 text-[12.5px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
    >
      <option value="">Share this version into…</option>
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  )
}

// Edit → a new immutable version. If someone (or an agent) saved meanwhile,
// the save is refused and the newer text is shown before anything is lost.
function EditVersion({ output, base, onDone, onCancel }: { output: AiOutput; base: OutputVersion; onDone: () => void; onCancel: () => void }): JSX.Element {
  const [text, setText] = useState(base.content)
  const [summary, setSummary] = useState('')
  const [stale, setStale] = useState<{ currentVersionId: string | null; currentContent: string } | null>(null)
  const [parent, setParent] = useState<string | null>(base.id)
  async function save(): Promise<void> {
    const r = await window.api.aiSpace.addVersion({ outputId: output.id, content: text, changeSummary: summary.trim() || 'Edited by you.', expectedParentVersionId: parent })
    if (r.ok) {
      announce(`Saved ${output.title} v${r.version.n}.`)
      onDone()
    } else setStale({ currentVersionId: r.currentVersionId, currentContent: r.currentContent })
  }
  return (
    <div className="rounded-lg border border-[var(--edge-soft)] p-3" data-testid="ais-edit-panel">
      <textarea aria-label="Content" value={text} onChange={(e) => setText(e.target.value)} className="fb-field w-full min-h-[200px] rounded-lg px-3 py-2 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] font-mono" />
      <input aria-label="What changed" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What changed (shown in the version list)" className="mt-2 fb-field w-full h-9 rounded-lg px-3 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]" />
      {stale && (
        <div role="alert" className="mt-2 rounded-lg border border-[color-mix(in_oklab,var(--ais-warn)_45%,transparent)] p-2.5 text-[13px]" data-testid="ais-stale">
          <p className="text-[color:var(--ais-warn)]">This changed while you were editing. Here’s the newer text; your edit is still in the box.</p>
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-[12px] text-[var(--ink-70)]">{stale.currentContent}</pre>
          <div className="mt-2">
            <QuietButton
              onClick={() => {
                setParent(stale.currentVersionId)
                setStale(null)
              }}
            >
              Save mine on top of the newer version
            </QuietButton>
          </div>
        </div>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <QuietButton onClick={onCancel}>Cancel</QuietButton>
        <PrimaryButton onClick={() => void save()} testId="ais-edit-save">
          Save as new version
        </PrimaryButton>
      </div>
    </div>
  )
}

// Compare two versions: aligned scroll when headings match, independent
// otherwise; Previous/Next (and swipe on touch) step through versions.
function CompareView({ output, versions, a, b, onPick, onClose }: { output: AiOutput; versions: OutputVersion[]; a: OutputVersion; b: OutputVersion; onPick: (a: string, b: string) => void; onClose: () => void }): JSX.Element {
  const headings = sharedHeadings(a.content, b.content)
  const [linked, setLinked] = useState(headings.length > 0)
  const left = useRef<HTMLDivElement>(null)
  const right = useRef<HTMLDivElement>(null)
  const ops = useMemo(() => diffLines(a.content, b.content), [a.content, b.content])
  const swipe = useRef<number | null>(null)

  function sync(from: HTMLDivElement | null, to: HTMLDivElement | null): void {
    if (!linked || !from || !to) return
    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight)
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight)
  }
  const idx = versions.findIndex((x) => x.id === b.id)
  const step = (d: number): void => {
    const nb = versions[idx + d]
    if (nb && nb.id !== a.id) onPick(a.id, nb.id)
  }
  const onDown = (e: RPointerEvent): void => {
    if (e.pointerType === 'touch') swipe.current = e.clientX
  }
  const onUp = (e: RPointerEvent): void => {
    if (swipe.current === null) return
    const dx = e.clientX - swipe.current
    swipe.current = null
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1)
  }

  const isText = output.kind !== 'image'
  return (
    <div data-testid="ais-compare-view" onPointerDown={onDown} onPointerUp={onUp}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <QuietButton icon="arrow_back" onClick={onClose} testId="ais-compare-close">
          Back
        </QuietButton>
        <span className="text-[13px] text-[var(--ink-70)]">
          v{a.n} ↔ v{b.n}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <QuietButton ariaLabel="Previous version" icon="chevron_left" onClick={() => step(-1)} disabled={idx <= 0}>
            Previous
          </QuietButton>
          <QuietButton ariaLabel="Next version" icon="chevron_right" onClick={() => step(1)} disabled={idx >= versions.length - 1}>
            Next
          </QuietButton>
        </span>
      </div>
      {isText && (
        <label className="inline-flex items-center gap-2 text-[12.5px] mb-2">
          <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
          Scroll together{headings.length ? ` (${headings.length} matching headings)` : ''}
        </label>
      )}
      {isText && ops ? (
        <div className="grid grid-cols-2 gap-2 text-[12.5px] font-mono">
          <div ref={left} onScroll={() => sync(left.current, right.current)} className="max-h-[60vh] overflow-auto rounded-lg bg-[var(--surface-sunken)] p-2" aria-label={`Version ${a.n}`}>
            {ops.filter((o) => o.kind !== 'add').map((o, i) => (
              <div key={i} className={`whitespace-pre-wrap px-1 ${o.kind === 'del' ? 'bg-[color-mix(in_oklab,var(--ais-bad)_16%,transparent)]' : ''}`}>
                {o.kind === 'del' && <span className="sr-only">Removed: </span>}
                {o.text || ' '}
              </div>
            ))}
          </div>
          <div ref={right} onScroll={() => sync(right.current, left.current)} className="max-h-[60vh] overflow-auto rounded-lg bg-[var(--surface-sunken)] p-2" aria-label={`Version ${b.n}`}>
            {ops.filter((o) => o.kind !== 'del').map((o, i) => (
              <div key={i} className={`whitespace-pre-wrap px-1 ${o.kind === 'add' ? 'bg-[color-mix(in_oklab,var(--ais-ok)_16%,transparent)]' : ''}`}>
                {o.kind === 'add' && <span className="sr-only">Added: </span>}
                {o.text || ' '}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Preview kind={output.kind} v={a} full />
          <Preview kind={output.kind} v={b} full />
        </div>
      )}
    </div>
  )
}
