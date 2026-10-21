// The retrieval trace, derived — never separately managed.
//
// `getTraceView` walks the trace's recorded facts and returns the exact lines to
// draw. Nothing about what the trace shows is stored anywhere else: no "current
// phase" field, no per-line status the UI keeps in sync. That is deliberate. A
// phase list that is state can desync from the work it describes, and a trace
// that says "Searching…" when nothing is in flight is exactly the dishonesty
// this whole surface exists to remove. Here, a line can only be drawn as done
// because the event that finished it actually arrived.
//
// Pure and DOM-free so it unit-tests directly — the derivation is where the
// honesty lives, so it is the part that gets pinned by tests.

import type { ChatMentionResolved, ChatSource, ChatToolTrace } from '@shared/types'
import { connectorForKind, connectorMeta } from './chatBlocks'

// What the assistant actually did while answering one message.
//
// Every field is set from a server event that really fired. `retrievedAt`,
// `repliedAt` and `completedAt` are renderer clock stamps for the moment each
// event landed; `retrievalMs` is the real elapsed time measured in the main
// process, because the round trip through IPC is not part of the search.
export interface AssistantTrace {
  status: 'running' | 'done' | 'error'
  startedAt: number
  // Null until the `sources` event lands.
  retrievedAt: number | null
  retrievalMs: number | null
  // Null until the reply prose lands whole.
  repliedAt: number | null
  completedAt: number | null
  // What each object the user named with "@" actually produced (Phase 4.4).
  // A separate lane from `sources` on purpose (plan D3): "you told me to read
  // this" and "I went and found this" are different claims, and merging them
  // would also renumber the [n] markers, which mean retrieval and only
  // retrieval. Empty when the request carried no mentions.
  mentions: ChatMentionResolved[]
  // Everything retrieval returned — NOT the same as what the answer cites.
  // Citation chips are derived separately, from the [n] markers in the prose.
  sources: ChatSource[]
  // How the workspace search matched (defect #15): false = keyword-only (no
  // embedding route configured), true = semantic ranking was available,
  // null/absent = unknown (older main process, restored trace without the
  // field). Optional so existing fixtures and stored traces stay valid.
  semantic?: boolean | null
  // Share of the workspace the semantic route could compare, 0..1. Below 100%
  // the search line says so: the rest was ranked by keyword. null/absent =
  // unknown, nothing disclosed.
  semanticCoverage?: number | null
  // What actually ran this turn (A4, AI-10): workspace false means the search
  // was deliberately gated (discovery ideation) and the trace must not draw a
  // search line at all. null/absent = unknown (older main process, restored
  // trace) — read as "everything ran", the pre-A4 truth.
  searched?: { workspace: boolean; web: boolean } | null
  tools: ChatToolTrace[]
  // The action the model is writing RIGHT NOW — announced the moment its
  // `"kind"` lands in the stream, before the object closes. Drawn as the
  // active line only while the action it names has not yet completed
  // (activity.index >= tools.length); a completed action supersedes it.
  activity: ChatToolTrace | null
  error: string | null
}

export interface TraceLeaf {
  key: string
  label: string
  icon: string
  // 1-based citation number, for source leaves. Matches the [n] markers.
  n?: number
  // The retrieved source this leaf stands for, so it can be opened.
  //
  // This matters more than it looks: the trace lists everything retrieval
  // found, while the chips below the answer list only what the answer cited.
  // Anything retrieved but uncited exists nowhere else in the UI — the trace is
  // the only way back to it. Absent on tool leaves, which name an action rather
  // than a document.
  source?: ChatSource
}

export interface TraceLine {
  key: string
  label: string
  icon: string
  leaves?: TraceLeaf[]
}

export interface TraceView {
  // Phases that finished, in the order they finished.
  completed: TraceLine[]
  // The one phase in flight, or null when nothing is.
  active: TraceLine | null
  // Set instead of `active` when the request failed. Never both.
  error: TraceLine | null
}

// The found sources cascade in with the app's entrance convention (AI-30,
// Caleb: the Office inbox's "graceful reveal… that's the fluidity I want").
// Rows mount together and stagger by index, exactly the inbox's numbers, so
// the panel takes its final height once and nothing below it is shoved row
// by row. The phase line leads, its rows follow.
// Caleb's closing A1 dial: the inbox numbers (25ms) read "very fast" on the
// trace — found links and documents deserve a beat each. Slower stagger,
// same loved motion.
export const CASCADE_LINE_LEAD_MS = 90
export const CASCADE_STAGGER_MS = 60
export const CASCADE_STAGGER_CAP_MS = 600
// Must match --dur-base, the fb-fade-in-up duration.
export const CASCADE_ROW_MS = 240

export function cascadeDelayMs(index: number): number {
  return CASCADE_LINE_LEAD_MS + Math.min(index * CASCADE_STAGGER_MS, CASCADE_STAGGER_CAP_MS)
}

// How long the whole cascade takes for `count` rows — the moment after which
// the answer may begin ("tree lands first"). Zero when there is nothing to
// cascade, so an answer with no sources is never made to wait.
export function cascadeDurationMs(count: number): number {
  if (count <= 0) return 0
  return cascadeDelayMs(count - 1) + CASCADE_ROW_MS
}

// The "Reading X…" ticker walks the sources after they land, one label per
// beat: it narrates the wait before the first token without moving anything
// on screen, since the rows are already in place.
export const SOURCE_READ_TICK_MS = 420

// Rotating thinking verbs (AI-29 — Caleb: "phrases it says when something is
// loading… watch the words rotate and know it's thinking"). The active line
// stays HONEST about the phase; within a phase the label cycles synonyms so a
// wait reads alive rather than stuck. Every retrieve verb is true (workspace
// and web search genuinely run in parallel); the read-N phase keeps its real
// per-source label because "Reading Henderson contract…" beats any verb.
// Pure data + a pure picker so the words are unit-locked; cadence belongs to
// the component.
export const THINKING_ROTATIONS: Record<string, string[]> = {
  retrieve: [
    'Searching your workspace…',
    'Searching the web…',
    'Scanning your desks…',
    'Gathering context…'
  ],
  answer: ['Thinking…', 'Pondering…', 'Shaping the answer…', 'Writing…']
}

export function rotatedLabel(key: string, canonical: string, tick: number): string {
  const set = THINKING_ROTATIONS[key]
  if (!set || set.length === 0 || tick < 0) return canonical
  return set[tick % set.length]
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// Icon for a prepared action. Connector-shaped kinds (mail / calendar / chat)
// reuse the same icons their proposal cards carry, so the same action looks like
// the same thing in the trace and on the card below it.
export function toolIcon(kind: string): string {
  const connector = connectorForKind(kind)
  if (connector) return connectorMeta(connector).icon
  if (kind.startsWith('create-doc') || kind === 'create-page' || kind === 'edit-document') {
    return 'description'
  }
  if (kind === 'create-table' || kind === 'add-table-row' || kind === 'set-cell') return 'table_chart'
  if (kind === 'create-task' || kind === 'update-task' || kind === 'create-todo-list') {
    return 'check_circle'
  }
  if (kind === 'create-agent') return 'smart_toy'
  if (kind === 'create-knowledge-entry') return 'menu_book'
  if (kind === 'open-url') return 'open_in_new'
  return 'bolt'
}

// Is there anything worth drawing?
//
// While a request is live the answer is yes — retrieval really is running, and
// saying so is the useful part. Once it has finished, a request that retrieved
// nothing and prepared nothing has nothing to report, and the trace disappears
// entirely rather than collapsing to a "0 sources" badge nobody asked for.
export function hasTraceContent(trace: AssistantTrace): boolean {
  if (trace.status === 'running') return true
  if (trace.status === 'error') return true
  return trace.mentions.length > 0 || trace.sources.length > 0 || trace.tools.length > 0
}

// The one-line summary the trace collapses to. Only ever names things that
// exist, so "3 sources · 2 tools" never appears over a request that had neither.
//
// A failed request says so first. Now that a failure can be folded away, a bare
// "1 source" over a broken request would read exactly like one that went fine —
// which is the one thing a collapsed summary must never do.
export function traceSummary(trace: AssistantTrace): string {
  const parts: string[] = []
  // Only references that genuinely produced content are counted as read — a
  // summary saying "2 mentioned" over one that failed would be the collapsed
  // line telling a story the expanded one contradicts.
  const readCount = trace.mentions.filter((m) => m.resolved).length
  if (readCount > 0) parts.push(`${readCount} mentioned`)
  if (trace.sources.length > 0) parts.push(plural(trace.sources.length, 'source'))
  if (trace.tools.length > 0) parts.push(plural(trace.tools.length, 'tool'))
  if (trace.status === 'error') {
    return parts.length > 0 ? `Failed · ${parts.join(' · ')}` : 'Failed'
  }
  if (parts.length === 0) return 'No sources used'
  return parts.join(' · ')
}

// The lane for the objects the user named. Resolved references are drawn as
// read; one that produced nothing is drawn as NOT read, with the reason the
// resolver gave. Both belong on screen — the user named it, so they are owed
// the outcome — but only one of them may claim the assistant read it.
function mentionLine(trace: AssistantTrace): TraceLine | null {
  if (trace.mentions.length === 0) return null
  const read = trace.mentions.filter((m) => m.resolved)
  const label =
    read.length === trace.mentions.length
      ? `Read ${plural(read.length, 'item')} you referenced`
      : read.length === 0
        ? `Could not read the ${plural(trace.mentions.length, 'item')} you referenced`
        : `Read ${read.length} of ${trace.mentions.length} items you referenced`
  return {
    key: 'mentions',
    label,
    icon: 'alternate_email',
    leaves: trace.mentions.map((m) => ({
      key: `mention-${m.kind}-${m.id}`,
      label: m.resolved
        ? m.truncated
          ? `${m.title} (shortened to fit)`
          : m.title
        : `${m.title} — ${m.reason ?? 'could not be read'}`,
      icon: m.resolved ? 'alternate_email' : 'link_off'
    }))
  }
}

// Web results ride the same sources array (they share the [n] citation
// space) but present as their OWN phase line — "Searched the web" is a
// different act from searching the workspace, and the trace never merges
// two acts into one claim (F4).
function workspaceSources(trace: AssistantTrace): ChatSource[] {
  return trace.sources.filter((s) => s.docType !== 'web')
}
function webSources(trace: AssistantTrace): ChatSource[] {
  return trace.sources.filter((s) => s.docType === 'web')
}

// With a semantic route, coverage below 100% means part of the workspace had
// no vector the route could compare and was ranked by keyword alone — which
// reads as an assistant that only knows recent things. Said once, as a share.
// Rounded DOWN so 99.6% never reads as complete; silent at full or unknown.
function partialMeaning(coverage: number | null | undefined): string {
  if (typeof coverage !== 'number' || !Number.isFinite(coverage)) return ''
  const pct = Math.max(0, Math.floor(coverage * 100))
  return pct >= 100 ? '' : ` · ${pct}% ranked by meaning`
}

function retrieveLabel(trace: AssistantTrace): string {
  const ms = trace.retrievalMs
  const timing = typeof ms === 'number' ? ` · ${ms}ms` : ''
  // Honest about HOW it searched (defect #15): with no embedding route the
  // match is literal keywords — "churn" does not find "attrition" — and the
  // label must not imply otherwise. Silent when semantic ran or is unknown.
  const how = trace.semantic === false ? ' · keyword match' : partialMeaning(trace.semanticCoverage)
  const ws = workspaceSources(trace)
  if (ws.length === 0) return `Searched your workspace · nothing relevant${timing}${how}`
  return `Searched your workspace · ${plural(ws.length, 'source')}${timing}${how}`
}

function sourceLeaves(sources: ChatSource[]): TraceLeaf[] {
  return sources.map((s) => ({
    key: `${s.n}-${s.docId}`,
    label: s.title,
    icon: s.docType === 'web' ? 'hub' : s.docType === 'knowledge' ? 'menu_book' : 'description',
    n: s.n,
    source: s
  }))
}

function toolLeaves(trace: AssistantTrace): TraceLeaf[] {
  return trace.tools.map((t) => ({
    key: `tool-${t.index}`,
    label: t.label,
    icon: toolIcon(t.kind)
  }))
}

// Walk the trace and return what to draw. `revealedCount` is how many retrieved
// sources the caller's read ticker has walked past — the one piece of
// presentation state. It only ever picks which "Reading X…" label is live;
// the leaves themselves are all drawn the moment retrieval lands (their
// cascade is CSS), and nothing here gates whether a fact is true.
export function getTraceView(trace: AssistantTrace, revealedCount: number): TraceView {
  const completed: TraceLine[] = []
  const failed = trace.status === 'error'
  // A failure replaces whatever would have been active. Phases already finished
  // stay green because they really did finish; nothing ahead of the failure is
  // ever drawn as done.
  const stop = (active: TraceLine | null): TraceView =>
    failed
      ? {
          completed,
          active: null,
          error: {
            key: 'failed',
            label: trace.error?.trim() || 'The request failed.',
            icon: 'error'
          }
        }
      : { completed, active, error: null }

  // 0 — what the user named. Resolution genuinely happens before retrieval (it
  // is what retrieval gets narrowed by), so this lane leads.
  const mentioned = mentionLine(trace)
  if (mentioned) completed.push(mentioned)

  // 1 — retrieval. Nothing else can be true until this returns.
  if (trace.retrievedAt === null) {
    return stop({ key: 'retrieve', label: 'Searching your workspace…', icon: 'search' })
  }
  // A4 gating (AI-10): a turn that deliberately did not search — discovery
  // ideation — draws no search line at all. Claiming "searched, found nothing"
  // over a search that never ran would be the exact ceremony being killed.
  const gatedOff = trace.searched ? !trace.searched.workspace : false
  if (!gatedOff) {
    const ws = workspaceSources(trace)
    const web = webSources(trace)
    completed.push({
      key: 'retrieve',
      label: retrieveLabel(trace),
      icon: 'search',
      leaves: sourceLeaves(ws)
    })
    if (web.length > 0) {
      completed.push({
        key: 'web',
        label: `Searched the web · ${plural(web.length, 'result')}`,
        icon: 'hub',
        leaves: sourceLeaves(web)
      })
    }
  }

  // 2 — reading what came back, one source at a time.
  if (revealedCount < trace.sources.length) {
    const current = trace.sources[revealedCount]
    return stop({
      key: `read-${revealedCount}`,
      label: `Reading ${current.title}…`,
      icon: 'description'
    })
  }

  // 3 — the answer. The envelope is {reply, actions}, so the prose necessarily
  // closes before any action does: this phase genuinely completes first, and the
  // trace shows that real order rather than a tidier invented one.
  if (trace.repliedAt === null && trace.completedAt === null) {
    return stop({ key: 'answer', label: 'Writing the answer…', icon: 'edit_note' })
  }
  // The reply landed (repliedAt), or the request finished without a separate
  // reply event — the prose-only fallback path, where there was no JSON envelope
  // to watch a reply field close inside. A request that FAILED before any reply
  // gets no line at all: nothing was written, so nothing claims to have been.
  if (trace.repliedAt !== null || !failed) {
    completed.push({ key: 'answer', label: 'Wrote the answer', icon: 'edit_note' })
  }

  // 4 — actions. The line exists only once one has actually arrived; a request
  // that proposed nothing says nothing about tools.
  if (trace.tools.length > 0) {
    completed.push({
      key: 'tools',
      label: `Prepared ${plural(trace.tools.length, 'tool')}`,
      icon: 'bolt',
      leaves: toolLeaves(trace)
    })
  }
  if (trace.status === 'running') {
    // The specific in-flight action, announced the moment its kind landed —
    // "Generating a document…" during the longest write instead of a generic
    // spinner. Only trusted while the action it names is still open; once it
    // completes (index < tools.length) we fall back to the count line below.
    const act = trace.activity
    if (act && act.index >= trace.tools.length) {
      return stop({ key: `activity-${act.index}`, label: `${act.label}…`, icon: toolIcon(act.kind) })
    }
    // Still streaming after at least one action landed: more may be coming, and
    // saying so is true. With none yet we stay silent rather than promising
    // tools that may never appear.
    if (trace.tools.length > 0) {
      return stop({ key: 'tools-active', label: 'Preparing actions…', icon: 'bolt' })
    }
  }

  return stop(null)
}
