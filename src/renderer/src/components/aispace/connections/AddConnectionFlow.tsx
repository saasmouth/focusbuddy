// Add connection: a five-step, keyboard-first dialog (SPEC-CONNECTIONS.md §2
// Connect flow).
//
//  1. What to connect: an addable catalogue entry, or an MCP server by address.
//  2. Which workspace.
//  3. Authorise the way that service supports: a masked key field, a browser
//     sign-in (the result comes back here whatever it was), or nothing at all
//     for a web account. An MCP server's verified origin is shown before
//     anything is sent to it.
//  4. Which projects may use it: none by default, and reads only.
//  5. The result: what works, which account, who pays.
//
// Closing part-way keeps a draft (drafts.ts) so the person can pick up where
// they left off. Keys are never part of that draft.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import type { CatalogueData, ConnectionCard, ConnectionDetailData, McpInspectResult } from '@shared/aispace/api'
import type { AiWorkspace } from '@shared/aispace/model'
import { CAPABILITY_LABEL, CONNECTION_KIND_LABEL, passedCapabilities, type ConnectionKind, type ProviderDefinition } from '@shared/aispace/connections'
import Modal from '../../plexi/Modal'
import Icon from '../../Icon'
import { useNoticeStore } from '../../../stores/notice'
import { announce, fmtAgo, LinkButton, PrimaryButton, QuietButton, StatusBadge } from '../ui'
import { clearLocalDraft, emptyDraft, readLocalDraft, writeLocalDraft, type LocalDraft } from './drafts'
import { CERTIFICATION_LABEL, defaultActions, defaultAlias, errorText, operationUsable, shortProviderName, workspaceLabel } from './model'
import { OnThisMac } from './OverviewTab'
import { FIELD_CLASS, readAndClear, SecretField } from './SecretField'

type Step = LocalDraft['step']
type ServerDraft = Awaited<ReturnType<typeof window.api.aiSpace.listDrafts>>[number]

const MCP_ID = 'mcp_remote'
const KIND_ORDER: ConnectionKind[] = ['ai_account', 'model_api', 'app_api', 'agent', 'local']
const KIND_HINT: Record<ConnectionKind, string> = {
  ai_account: 'Open your chats from Plexii and bring in what you pick.',
  model_api: 'Run models from a Desk on this key and its billing.',
  app_api: 'Allow single actions, like reading a page or creating a draft.',
  agent: 'Start and follow runs at an outside agent.',
  mcp: 'Find a server’s tools and choose which projects may use them.',
  local: 'Run models on this device.'
}

export default function AddConnectionFlow(props: {
  catalogue: CatalogueData
  workspaces: AiWorkspace[]
  activeWorkspaceIds: string[]
  // "Add it as a separate connection": skip straight to step 3 for this provider.
  preset?: { providerId: string; workspaceId: string } | null
  onClose: () => void
  onFinished: (connectionId: string | null, alias: string) => void
}): JSX.Element {
  const api = window.api.aiSpace
  const { catalogue, workspaces, activeWorkspaceIds } = props
  const headId = useId()
  const headRef = useRef<HTMLHeadingElement>(null)

  const firstActive = workspaces.find((w) => activeWorkspaceIds.includes(w.id)) ?? workspaces[0] ?? null
  const [phase, setPhase] = useState<'loading' | 'resume' | 'flow'>(props.preset ? 'flow' : 'loading')
  const [savedLocal, setSavedLocal] = useState<LocalDraft | null>(null)
  const [serverDrafts, setServerDrafts] = useState<ServerDraft[]>([])
  const [d, setD] = useState<LocalDraft>(() => (props.preset ? { ...emptyDraft(), providerId: props.preset.providerId, workspaceId: props.preset.workspaceId, step: 3 } : { ...emptyDraft(), workspaceId: firstActive?.id ?? null }))
  const [confirmed, setConfirmed] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string; lines?: string[] } | null>(null)

  const provider = useMemo(() => catalogue.providers.find((p) => p.id === d.providerId) ?? null, [catalogue.providers, d.providerId])
  const workspace = workspaces.find((w) => w.id === d.workspaceId) ?? null
  const kind: ConnectionKind | null = provider?.kind ?? null

  // Offer to continue anything left half-done.
  useEffect(() => {
    if (props.preset) return
    let live = true
    const local = readLocalDraft()
    api
      .listDrafts()
      .catch(() => [] as ServerDraft[])
      .then((server) => {
        if (!live) return
        setSavedLocal(local)
        setServerDrafts(server)
        setPhase(local || server.length ? 'resume' : 'flow')
      })
    return () => {
      live = false
    }
  }, [api, props.preset])

  // Keep the draft as the person goes (never a key; see drafts.ts).
  useEffect(() => {
    if (phase !== 'flow' || !d.providerId || d.step === 5) return
    writeLocalDraft(d)
  }, [d, phase])

  // Each step announces itself: focus lands on its heading.
  useEffect(() => {
    if (phase === 'loading') return
    const t = setTimeout(() => headRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [d.step, phase])

  const patch = (p: Partial<LocalDraft>): void => setD((x) => ({ ...x, ...p }))
  const go = (step: Step): void => {
    setMessage(null)
    patch({ step })
  }

  function close(): void {
    if (phase === 'flow' && d.step === 5) {
      void finish()
      return
    }
    if (phase === 'flow' && d.providerId) useNoticeStore.getState().show({ text: 'Setup saved. Continue it from Add connection.', icon: 'bookmark' })
    props.onClose()
  }

  async function discard(): Promise<void> {
    clearLocalDraft()
    const ids = new Set<string>()
    if (d.serverDraftId) ids.add(d.serverDraftId)
    if (d.connectionId && d.providerId === MCP_ID) ids.add(`mcp_${d.connectionId}`)
    for (const id of ids) await api.deleteDraft(id).catch(() => undefined)
    if (d.connectionId && d.step < 4) useNoticeStore.getState().show({ text: 'Setup discarded. The unfinished server stays listed until you sign in or disconnect it.', icon: 'info' })
    props.onClose()
  }

  async function finish(): Promise<void> {
    clearLocalDraft()
    const ids = new Set<string>()
    if (d.serverDraftId) ids.add(d.serverDraftId)
    if (d.connectionId && d.providerId === MCP_ID) ids.add(`mcp_${d.connectionId}`)
    for (const id of ids) await api.deleteDraft(id).catch(() => undefined)
    props.onFinished(d.connectionId, d.alias.trim())
  }

  // ── Resume ──────────────────────────────────────────────────────────────────

  function continueLocal(x: LocalDraft): void {
    setD(x)
    setPhase('flow')
  }

  function continueServer(s: ServerDraft): void {
    const endpoint = typeof s.state.endpoint === 'string' ? s.state.endpoint : ''
    const connectionId = typeof s.state.connectionId === 'string' ? s.state.connectionId : null
    setD({ ...emptyDraft(), step: 3, providerId: s.providerId || MCP_ID, mcpUrl: endpoint, workspaceId: s.workspaceId ?? firstActive?.id ?? null, connectionId, serverDraftId: s.id })
    setPhase('flow')
  }

  async function dropServer(s: ServerDraft): Promise<void> {
    await api.deleteDraft(s.id).catch(() => undefined)
    const rest = serverDrafts.filter((x) => x.id !== s.id)
    setServerDrafts(rest)
    if (!rest.length && !savedLocal) setPhase('flow')
  }

  function startNew(): void {
    clearLocalDraft()
    setSavedLocal(null)
    setD({ ...emptyDraft(), workspaceId: firstActive?.id ?? null })
    setPhase('flow')
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const stepTitle =
    phase === 'resume'
      ? 'Pick up where you left off?'
      : d.step === 1
        ? 'What do you want to connect?'
        : d.step === 2
          ? 'Which workspace?'
          : d.step === 3
            ? kind === 'model_api'
              ? `Add your ${shortProviderName(provider?.name ?? '')} API key`
              : kind === 'app_api'
                ? `Add your ${provider?.name ?? ''} token`
                : kind === 'mcp'
                  ? 'Check the server and sign in'
                  : 'Name this account'
            : d.step === 4
              ? 'Which projects can use it?'
              : 'Connected'

  return (
    <Modal onClose={close} labelledById={headId} z={240} closeOnBackdrop={false} className="fb-card w-[min(640px,94vw)] max-h-[90vh] flex flex-col" testId="conn-add-dialog">
      <div className="ais-touch flex flex-col min-h-0">
        <header className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-[var(--edge-hairline)]">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-[var(--ink-50)]">
              Add a connection{phase === 'flow' ? <span className="fb-tabular"> · Step {d.step} of 5</span> : null}
            </p>
            <h2 id={headId} ref={headRef} tabIndex={-1} className="mt-0.5 text-[18px] font-semibold text-[var(--ink-100)] outline-none" data-testid="conn-add-title">
              {stepTitle}
            </h2>
            {phase === 'flow' && <StepDots step={d.step} />}
          </div>
          <button type="button" onClick={close} aria-label="Close. Your progress is kept." title="Close (Esc). Your progress is kept." className="icon-btn h-8 w-8 rounded-md inline-flex items-center justify-center text-[var(--ink-60)] hover:text-[var(--ink-100)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]" data-testid="conn-add-close">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
          {phase === 'loading' && (
            <p role="status" className="text-[13px] text-[var(--ink-60)]">
              Loading…
            </p>
          )}
          {phase === 'resume' && (
            <Resume local={savedLocal} server={serverDrafts} catalogue={catalogue} onLocal={continueLocal} onServer={continueServer} onDropServer={(s) => void dropServer(s)} onNew={startNew} />
          )}
          {phase === 'flow' && d.step === 1 && <StepWhat catalogue={catalogue} draft={d} onPatch={patch} onNext={() => go(2)} />}
          {phase === 'flow' && d.step === 2 && <StepWorkspace workspaces={workspaces} activeIds={activeWorkspaceIds} draft={d} onPatch={patch} onBack={() => go(1)} onNext={() => go(3)} />}
          {phase === 'flow' && d.step === 3 && provider && workspace && (
            <StepAuthorise
              provider={provider}
              catalogue={catalogue}
              workspace={workspace}
              draft={d}
              busy={busy}
              setBusy={setBusy}
              message={message}
              setMessage={setMessage}
              onPatch={patch}
              // Once the connection exists, its workspace and type are fixed.
              onBack={d.connectionId ? null : () => go(2)}
              onConnected={(connectionId, lines) => {
                setConfirmed(lines)
                patch({ connectionId, step: 4 })
                setMessage(null)
                announce('Connected. Now choose which projects can use it.')
              }}
            />
          )}
          {phase === 'flow' && d.step === 3 && (!provider || !workspace) && (
            <p role="alert" className="text-[14px] text-[var(--ink-80)]">
              {provider ? 'Pick a workspace first.' : 'That connection type isn’t available any more. Go back and pick another.'}{' '}
              <LinkButton onClick={() => go(provider ? 2 : 1)}>Go back</LinkButton>
            </p>
          )}
          {phase === 'flow' && d.step === 4 && d.connectionId && kind && <StepProjects connectionId={d.connectionId} kind={kind} confirmed={confirmed} onDone={() => go(5)} />}
          {phase === 'flow' && d.step === 5 && d.connectionId && <StepResult connectionId={d.connectionId} confirmed={confirmed} onDone={() => void finish()} />}
        </div>

        {phase === 'flow' && d.step < 4 && (
          <footer className="flex items-center gap-2 px-6 py-3 border-t border-[var(--edge-hairline)]">
            <QuietButton onClick={() => void discard()} testId="conn-add-discard">
              Discard setup
            </QuietButton>
            <span className="ml-auto text-[12px] text-[var(--ink-50)]">Closing keeps your progress. Keys are never saved in it.</span>
          </footer>
        )}
      </div>
    </Modal>
  )
}

function StepDots({ step }: { step: Step }): JSX.Element {
  const names = ['What', 'Workspace', 'Authorise', 'Projects', 'Result']
  return (
    <ol className="mt-2 flex items-center gap-1.5" aria-label="Steps">
      {names.map((n, i) => (
        <li key={n} aria-current={i + 1 === step ? 'step' : undefined} className="flex items-center gap-1.5 text-[12px]">
          <span className={`h-1.5 w-6 rounded-full ${i + 1 < step ? 'bg-[var(--ink-40)]' : i + 1 === step ? 'bg-[rgb(var(--accent))]' : 'bg-[var(--edge-soft)]'}`} aria-hidden />
          <span className="sr-only">
            {n}
            {i + 1 < step ? ', done' : i + 1 === step ? ', current' : ''}
          </span>
        </li>
      ))}
    </ol>
  )
}

// ── Resume ────────────────────────────────────────────────────────────────────

function Resume(props: { local: LocalDraft | null; server: ServerDraft[]; catalogue: CatalogueData; onLocal: (d: LocalDraft) => void; onServer: (s: ServerDraft) => void; onDropServer: (s: ServerDraft) => void; onNew: () => void }): JSX.Element {
  const name = (id: string | null): string => props.catalogue.providers.find((p) => p.id === id)?.name ?? 'Connection'
  // A server draft the local draft already covers is shown once.
  const server = props.server.filter((s) => !(props.local?.connectionId && s.state.connectionId === props.local.connectionId))
  return (
    <div data-testid="conn-add-resume">
      <ul className="space-y-2">
        {props.local && (
          <li className="flex items-center gap-3 rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-[var(--ink-90)]">
                {props.local.alias || name(props.local.providerId)}
                {props.local.providerId === MCP_ID && props.local.mcpUrl ? <span className="font-normal text-[var(--ink-60)]"> · {props.local.mcpUrl}</span> : null}
              </p>
              <p className="text-[12px] text-[var(--ink-50)]">
                Step <span className="fb-tabular">{props.local.step}</span> of 5 · {fmtAgo(props.local.updatedAt)}
              </p>
            </div>
            <PrimaryButton onClick={() => props.onLocal(props.local!)} testId="conn-add-resume-local">
              Continue
            </PrimaryButton>
          </li>
        )}
        {server.map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-[var(--ink-90)]">Finish signing in</p>
              <p className="text-[12px] text-[var(--ink-50)] break-all">
                {typeof s.state.endpoint === 'string' ? s.state.endpoint : name(s.providerId)} · {fmtAgo(s.updatedAt)}
              </p>
            </div>
            <QuietButton onClick={() => props.onDropServer(s)}>Discard</QuietButton>
            <PrimaryButton onClick={() => props.onServer(s)} testId={`conn-add-resume-${s.id}`}>
              Continue
            </PrimaryButton>
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <QuietButton icon="add" onClick={props.onNew} testId="conn-add-new">
          Start a new connection
        </QuietButton>
      </div>
    </div>
  )
}

// ── Step 1: what ──────────────────────────────────────────────────────────────

function StepWhat(props: { catalogue: CatalogueData; draft: LocalDraft; onPatch: (p: Partial<LocalDraft>) => void; onNext: () => void }): JSX.Element {
  const { catalogue, draft } = props
  const urlId = useId()
  const addable = catalogue.providers.filter((p) => catalogue.addable.includes(p.id) && p.id !== MCP_ID)
  const mcpDef = catalogue.providers.find((p) => p.id === MCP_ID) ?? null
  const mcpAddable = catalogue.addable.includes(MCP_ID)
  const canNext = Boolean(draft.providerId) && (draft.providerId !== MCP_ID || draft.mcpUrl.trim().length > 0)

  function pick(p: ProviderDefinition): void {
    props.onPatch({ providerId: p.id, alias: '', connectionId: null })
  }

  function submit(e: FormEvent): void {
    e.preventDefault()
    if (canNext) props.onNext()
  }

  return (
    <form onSubmit={submit} data-testid="conn-add-step-1">
      <fieldset>
        <legend className="sr-only">What do you want to connect?</legend>
        {KIND_ORDER.map((k) => {
          const list = addable.filter((p) => p.kind === k)
          if (!list.length) return null
          return (
            <div key={k} className="mt-5 first:mt-0">
              <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ink-50)]">{CONNECTION_KIND_LABEL[k]}</h3>
              <p className="text-[12px] text-[var(--ink-60)]">{KIND_HINT[k]}</p>
              <div className="mt-2 space-y-1.5">
                {list.map((p) => (
                  <Choice key={p.id} name="conn-provider" value={p.id} checked={draft.providerId === p.id} onPick={() => pick(p)} testId={`conn-add-provider-${p.id}`} title={p.name} aside={p.group !== p.name ? p.group : undefined} small={`${CERTIFICATION_LABEL[p.certification.status]}: ${p.certification.basis}`} />
                ))}
              </div>
            </div>
          )
        })}
        {mcpAddable && mcpDef && (
          <div className="mt-5">
            <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ink-50)]">{CONNECTION_KIND_LABEL.mcp}</h3>
            <p className="text-[12px] text-[var(--ink-60)]">{KIND_HINT.mcp}</p>
            <div className="mt-2">
              <Choice name="conn-provider" value={MCP_ID} checked={draft.providerId === MCP_ID} onPick={() => pick(mcpDef)} testId="conn-add-provider-mcp" title="MCP server by address" small={`${CERTIFICATION_LABEL[mcpDef.certification.status]}: ${mcpDef.certification.basis}`} />
            </div>
            {draft.providerId === MCP_ID && (
              <div className="mt-3 pl-7">
                <label htmlFor={urlId} className="block text-[12px] text-[var(--ink-60)]">
                  Server address
                </label>
                <input id={urlId} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://example.com/mcp" value={draft.mcpUrl} onChange={(e) => props.onPatch({ mcpUrl: e.target.value })} className={`${FIELD_CLASS} fb-mono`} data-testid="conn-add-mcp-url" />
                <p className="mt-1 text-[12px] text-[var(--ink-50)]">An address on this Mac (localhost) works too and is labelled On this Mac.</p>
                {catalogue.mcp.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[12px] text-[var(--ink-60)]">Or pick a known server. Each is certified only once its own checks pass.</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {catalogue.mcp.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => props.onPatch({ mcpUrl: m.endpoint, alias: m.name })}
                          aria-pressed={draft.mcpUrl === m.endpoint}
                          title={m.description}
                          data-testid={`conn-add-mcp-pick-${m.id}`}
                          className={`min-h-[32px] px-3 rounded-lg text-[13px] border focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] ${draft.mcpUrl === m.endpoint ? 'border-[rgb(var(--accent)/0.5)] text-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.08)]' : 'border-[var(--edge-soft)] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'}`}
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </fieldset>
      <div className="mt-6 flex justify-end">
        <PrimaryButton type="submit" disabled={!canNext} testId="conn-add-next">
          Next
        </PrimaryButton>
      </div>
    </form>
  )
}

function Choice(props: { name: string; value: string; checked: boolean; onPick: () => void; title: string; aside?: string; small?: string; testId?: string; disabled?: boolean }): JSX.Element {
  return (
    <label className={`flex items-start gap-3 rounded-[var(--radius-row)] px-3 py-2.5 cursor-pointer border has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[rgb(var(--accent))] ${props.checked ? 'border-[rgb(var(--accent)/0.45)] bg-[rgb(var(--accent)/0.06)]' : 'border-transparent bg-[var(--surface-sunken)] hover:border-[var(--edge-soft)]'} ${props.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <input type="radio" name={props.name} value={props.value} checked={props.checked} disabled={props.disabled} onChange={props.onPick} data-testid={props.testId} className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]" />
      <span className="min-w-0">
        <span className="block text-[14px] font-medium text-[var(--ink-90)]">
          {props.title}
          {props.aside && <span className="font-normal text-[var(--ink-50)]"> · {props.aside}</span>}
        </span>
        {props.small && <span className="block mt-0.5 text-[12px] leading-relaxed text-[var(--ink-60)]">{props.small}</span>}
      </span>
    </label>
  )
}

// ── Step 2: workspace ─────────────────────────────────────────────────────────

function StepWorkspace(props: { workspaces: AiWorkspace[]; activeIds: string[]; draft: LocalDraft; onPatch: (p: Partial<LocalDraft>) => void; onBack: () => void; onNext: () => void }): JSX.Element {
  const ok = Boolean(props.draft.workspaceId && props.activeIds.includes(props.draft.workspaceId))
  return (
    <form
      data-testid="conn-add-step-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (ok) props.onNext()
      }}
    >
      <p className="text-[14px] text-[var(--ink-70)]">A connection belongs to one workspace. Only projects in that workspace can use it, and its usage stays separate.</p>
      <fieldset className="mt-4 space-y-1.5">
        <legend className="sr-only">Workspace</legend>
        {props.workspaces.map((w) => {
          const active = props.activeIds.includes(w.id)
          return (
            <Choice
              key={w.id}
              name="conn-workspace"
              value={w.id}
              checked={props.draft.workspaceId === w.id}
              disabled={!active}
              onPick={() => props.onPatch({ workspaceId: w.id, alias: '' })}
              testId={`conn-add-ws-${w.id}`}
              title={workspaceLabel(w)}
              small={active ? undefined : 'Not one you’re working in right now. Switch to it first.'}
            />
          )
        })}
      </fieldset>
      <div className="mt-6 flex justify-end gap-2">
        <QuietButton onClick={props.onBack} testId="conn-add-back">
          Back
        </QuietButton>
        <PrimaryButton type="submit" disabled={!ok} testId="conn-add-next">
          Next
        </PrimaryButton>
      </div>
    </form>
  )
}

// ── Step 3: authorise ─────────────────────────────────────────────────────────

function StepAuthorise(props: {
  provider: ProviderDefinition
  catalogue: CatalogueData
  workspace: AiWorkspace
  draft: LocalDraft
  busy: string | null
  setBusy: (b: string | null) => void
  message: { tone: 'error' | 'info'; text: string; lines?: string[] } | null
  setMessage: (m: { tone: 'error' | 'info'; text: string; lines?: string[] } | null) => void
  onPatch: (p: Partial<LocalDraft>) => void
  onBack: (() => void) | null
  onConnected: (connectionId: string, confirmed: string[]) => void
}): JSX.Element {
  const { provider, draft } = props
  const kind = provider.kind
  const ids = { alias: useId(), payer: useId(), secret: useId(), secretHelp: useId(), model: useId(), parent: useId() }
  const secretRef = useRef<HTMLInputElement>(null)
  const [hasSecret, setHasSecret] = useState(false)

  // A sensible name the first time this step shows: "SaaSMouth Claude".
  useEffect(() => {
    if (draft.alias || draft.connectionId) return
    props.onPatch({ alias: kind === 'mcp' ? '' : defaultAlias(provider, props.workspace) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const message = props.message && (
    <div role={props.message.tone === 'error' ? 'alert' : 'status'} data-testid="conn-add-message" className={`mt-4 rounded-[var(--radius-row)] px-3 py-2.5 text-[13px] leading-relaxed ${props.message.tone === 'error' ? 'bg-[color-mix(in_oklab,var(--ais-bad)_8%,transparent)] text-[var(--ink-90)]' : 'bg-[var(--surface-sunken)] text-[var(--ink-80)]'}`}>
      <p className="flex items-start gap-1.5">
        <Icon name={props.message.tone === 'error' ? 'error' : 'hourglass_top'} size={15} className={`mt-0.5 shrink-0 ${props.message.tone === 'error' ? 'text-[color:var(--ais-bad)]' : 'text-[var(--ink-50)]'}`} />
        <span>{props.message.text}</span>
      </p>
      {props.message.lines && props.message.lines.length > 0 && (
        <ul className="mt-1 pl-[21px] space-y-0.5 text-[12px] text-[var(--ink-70)]">
          {props.message.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  )

  if (kind === 'mcp') return <McpAuthorise {...props} ids={ids} secretRef={secretRef} hasSecret={hasSecret} setHasSecret={setHasSecret} messageNode={message} />

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (props.busy) return
    const api = window.api.aiSpace
    const alias = draft.alias.trim() || defaultAlias(provider, props.workspace)
    if (kind === 'ai_account') {
      props.setBusy('add')
      props.setMessage(null)
      try {
        const card = await api.addChatAccount({ providerId: provider.id, workspaceId: props.workspace.id, alias })
        props.onConnected(card.id, ['Nothing is stored: links open in your browser, signed in as you.', ...card.capabilities.filter((h) => h.state === 'passed').map((h) => `${CAPABILITY_LABEL[h.capability]}: ${h.detail}`)])
      } catch (err) {
        props.setMessage({ tone: 'error', text: errorText(err) })
      } finally {
        props.setBusy(null)
      }
      return
    }
    // Key or token: out of the field before anything else, success or not.
    const secret = readAndClear(secretRef)
    setHasSecret(false)
    if (!secret) {
      props.setMessage({ tone: 'error', text: kind === 'app_api' ? 'Paste the token first.' : 'Paste the API key first.' })
      return
    }
    props.setBusy('add')
    props.setMessage({ tone: 'info', text: 'Checking with a free, read-only call…' })
    try {
      const r =
        kind === 'model_api'
          ? await api.addModelApi({ providerId: provider.id, workspaceId: props.workspace.id, alias, billedTo: draft.payer.trim() || null, secret, defaultModel: draft.defaultModel ?? provider.models[0]?.id ?? null })
          : await api.addAppApi({ providerId: provider.id, workspaceId: props.workspace.id, alias, token: secret, draftParentId: draft.draftParentId.trim() || null })
      if (r.ok) props.onConnected(r.connection.id, r.confirmed)
      else props.setMessage({ tone: 'error', text: r.detail, lines: [...(r.confirmed ?? []), 'Nothing was saved. Paste the key again to retry.'] })
    } catch (err) {
      props.setMessage({ tone: 'error', text: errorText(err), lines: ['Nothing was saved. Paste the key again to retry.'] })
    } finally {
      props.setBusy(null)
    }
  }

  const word = kind === 'app_api' ? 'token' : 'key'
  return (
    <form onSubmit={(e) => void submit(e)} data-testid="conn-add-step-3" autoComplete="off">
      <Field id={ids.alias} label="Name">
        <input id={ids.alias} value={draft.alias} onChange={(e) => props.onPatch({ alias: e.target.value })} className={FIELD_CLASS} data-testid="conn-add-alias" />
        <Hint>The name you’ll see everywhere, like “{defaultAlias(provider, props.workspace)}”. Each key is its own connection.</Hint>
      </Field>

      {kind === 'ai_account' && <p className="mt-4 text-[14px] leading-relaxed text-[var(--ink-70)]">Nothing is stored: links open in your browser, signed in as you.</p>}

      {kind === 'model_api' && (
        <>
          <Field id={ids.payer} label="Payer (optional)">
            <input id={ids.payer} value={draft.payer} onChange={(e) => props.onPatch({ payer: e.target.value })} placeholder="e.g. SaaSMouth Ltd" className={FIELD_CLASS} data-testid="conn-add-payer" />
            <Hint>Leave blank if you’re not sure. It shows as Unknown payer until you set it.</Hint>
          </Field>
          {provider.models.length > 0 && (
            <Field id={ids.model} label="Default model">
              <select id={ids.model} value={draft.defaultModel ?? provider.models[0].id} onChange={(e) => props.onPatch({ defaultModel: e.target.value })} className={FIELD_CLASS} data-testid="conn-add-model">
                {provider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}

      {(kind === 'model_api' || kind === 'app_api') && (
        <Field id={ids.secret} label={kind === 'app_api' ? 'Internal integration token' : 'API key'}>
          <SecretField ref={secretRef} id={ids.secret} describedBy={ids.secretHelp} onPresenceChange={setHasSecret} testId="conn-add-secret" />
          <p id={ids.secretHelp} className="mt-1.5 text-[12px] leading-relaxed text-[var(--ink-60)]">
            Plexii checks the {word} with a free, read-only call, then stores it encrypted on this Mac. It never shows it again.
          </p>
          {provider.keySettingsUrl && (
            <div className="mt-1">
              <LinkButton onClick={() => void window.api.aiSpace.openOriginal(provider.keySettingsUrl!)} testId="conn-add-key-link">
                Where do I get a {word}?
                <Icon name="open_in_new" size={14} />
              </LinkButton>
            </div>
          )}
        </Field>
      )}

      {kind === 'app_api' && (
        <>
          <p className="mt-4 text-[13px] leading-relaxed text-[var(--ink-70)]">Share the pages Plexii may read with your integration in {provider.name}. Plexii can only see what you share.</p>
          <Field id={ids.parent} label="Draft pages go under (optional)">
            <input id={ids.parent} value={draft.draftParentId} onChange={(e) => props.onPatch({ draftParentId: e.target.value })} placeholder="Page id or link" className={`${FIELD_CLASS} fb-mono`} data-testid="conn-add-parent" />
            <Hint>Where new drafts are created. You can set it later.</Hint>
          </Field>
        </>
      )}

      {message}

      <div className="mt-6 flex justify-end gap-2">
        {props.onBack && (
          <QuietButton onClick={props.onBack} disabled={Boolean(props.busy)} testId="conn-add-back">
            Back
          </QuietButton>
        )}
        <PrimaryButton type="submit" disabled={Boolean(props.busy) || ((kind === 'model_api' || kind === 'app_api') && !hasSecret)} testId="conn-add-submit">
          {props.busy ? 'Checking…' : kind === 'ai_account' ? 'Add account' : 'Check and connect'}
        </PrimaryButton>
      </div>
    </form>
  )
}

function McpAuthorise(props: {
  provider: ProviderDefinition
  catalogue: CatalogueData
  workspace: AiWorkspace
  draft: LocalDraft
  busy: string | null
  setBusy: (b: string | null) => void
  setMessage: (m: { tone: 'error' | 'info'; text: string; lines?: string[] } | null) => void
  onPatch: (p: Partial<LocalDraft>) => void
  onBack: (() => void) | null
  onConnected: (connectionId: string, confirmed: string[]) => void
  ids: { alias: string; secret: string; secretHelp: string }
  secretRef: RefObject<HTMLInputElement>
  hasSecret: boolean
  setHasSecret: (b: boolean) => void
  messageNode: ReactNode
}): JSX.Element {
  const { draft } = props
  const api = window.api.aiSpace
  const [inspect, setInspect] = useState<McpInspectResult | null>(null)
  const [inspectError, setInspectError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [mode, setMode] = useState<'signin' | 'token'>('signin')
  const [failed, setFailed] = useState(false)
  const [added, setAdded] = useState<string[]>([])

  // The verified origin comes first, before anything is sent with credentials.
  useEffect(() => {
    let live = true
    setInspect(null)
    setInspectError(null)
    api
      .inspectMcpEndpoint(draft.mcpUrl)
      .then((r) => {
        if (!live) return
        setInspect(r)
        if (!draft.alias && !draft.connectionId) {
          const known = props.catalogue.mcp.find((m) => m.endpoint === draft.mcpUrl.trim())
          let host = ''
          try {
            host = new URL(draft.mcpUrl.trim()).host
          } catch {
            /* invalid: inspect already said so */
          }
          props.onPatch({ alias: known?.name ?? host })
        }
      })
      .catch((e) => live && setInspectError(errorText(e)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.mcpUrl, tick])

  async function authorize(connectionId: string, lines: string[]): Promise<void> {
    props.setBusy('authorize')
    setFailed(false)
    props.setMessage({ tone: 'info', text: 'Approve access in your browser. Plexii waits here and comes back to this step whatever you choose.' })
    try {
      const r = await api.authorizeMcp(connectionId)
      if (r.ok) {
        props.onConnected(connectionId, [...lines, r.detail])
        return
      }
      setFailed(true)
      const head = r.outcome === 'denied' ? 'Access was declined in the browser.' : r.outcome === 'timeout' ? 'The sign-in wasn’t finished in time.' : r.outcome === 'consent_required' ? 'The server needs you to approve more access.' : 'Sign-in didn’t finish.'
      props.setMessage({ tone: 'error', text: head, lines: [r.detail, 'Your setup is saved. Try again when you’re ready.'] })
      announce(head)
    } catch (e) {
      setFailed(true)
      props.setMessage({ tone: 'error', text: errorText(e), lines: ['Your setup is saved. Try again when you’re ready.'] })
    } finally {
      props.setBusy(null)
    }
  }

  async function connect(withToken: boolean): Promise<void> {
    if (props.busy || !inspect?.ok) return
    // Already added and waiting for sign-in: never add it twice.
    if (draft.connectionId) {
      await authorize(draft.connectionId, added)
      return
    }
    const token = withToken ? readAndClear(props.secretRef) : ''
    if (withToken) props.setHasSecret(false)
    if (withToken && !token) {
      props.setMessage({ tone: 'error', text: 'Paste the token first.' })
      return
    }
    props.setBusy('add')
    props.setMessage(null)
    try {
      const r = await api.addMcpServer({ workspaceId: props.workspace.id, alias: draft.alias.trim(), endpoint: draft.mcpUrl.trim(), bearerToken: withToken ? token : null })
      if (!r.ok) {
        props.setMessage({ tone: 'error', text: r.detail })
        props.setBusy(null)
        return
      }
      props.onPatch({ connectionId: r.connection.id, serverDraftId: r.next === 'authorize' ? `mcp_${r.connection.id}` : null })
      setAdded(r.confirmed)
      if (r.next === 'authorize') {
        await authorize(r.connection.id, r.confirmed)
        return
      }
      props.setBusy(null)
      props.onConnected(r.connection.id, r.confirmed)
    } catch (e) {
      props.setMessage({ tone: 'error', text: errorText(e) })
      props.setBusy(null)
    }
  }

  const needsAuth = inspect?.needsAuth === true
  return (
    <div data-testid="conn-add-step-3">
      {/* What the server is, verified, before anything else. */}
      <section aria-label="The server" className="rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-3 py-3" data-testid="conn-add-mcp-inspect">
        <p className="text-[12px] text-[var(--ink-50)] break-all fb-mono">{draft.mcpUrl}</p>
        {!inspect && !inspectError && (
          <p role="status" className="mt-1 text-[13px] text-[var(--ink-70)]">
            Checking the server…
          </p>
        )}
        {inspectError && (
          <p role="alert" className="mt-1 text-[13px] text-[color:var(--ais-bad)]">
            {inspectError}
          </p>
        )}
        {inspect && !inspect.ok && (
          <div role="alert" className="mt-1">
            <p className="text-[14px] text-[var(--ink-90)]">Plexii can’t connect to this address.</p>
            <p className="mt-0.5 text-[13px] text-[var(--ink-70)]">{inspect.reason}</p>
          </div>
        )}
        {inspect?.ok && (
          <div className="mt-1.5">
            <p className="text-[14px] text-[var(--ink-90)]">
              <span className="text-[var(--ink-50)]">Verified origin:</span> <strong className="font-medium fb-mono" data-testid="conn-add-mcp-origin">{inspect.origin}</strong>
              {inspect.onThisMac && <OnThisMac />}
            </p>
            <p className="mt-1 text-[13px] text-[var(--ink-70)]">{inspect.reason}</p>
            {inspect.authServer && (
              <p className="mt-0.5 text-[13px] text-[var(--ink-70)]" data-testid="conn-add-mcp-authserver">
                Sign-in through <span className="fb-mono">{inspect.authServer}</span>
              </p>
            )}
            {inspect.scopes.length > 0 && <p className="mt-0.5 text-[12px] text-[var(--ink-50)]">It can ask for: {inspect.scopes.join(', ')}. Plexii asks for the least it needs.</p>}
          </div>
        )}
        {(inspectError || (inspect && !inspect.ok)) && (
          <div className="mt-2 flex gap-2">
            <QuietButton onClick={() => setTick((n) => n + 1)}>Check again</QuietButton>
          </div>
        )}
      </section>

      {inspect?.ok && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void connect(mode === 'token')
          }}
          autoComplete="off"
        >
          {!draft.connectionId && (
            <Field id={props.ids.alias} label="Name">
              <input id={props.ids.alias} value={draft.alias} onChange={(e) => props.onPatch({ alias: e.target.value })} className={FIELD_CLASS} data-testid="conn-add-alias" />
            </Field>
          )}

          {needsAuth && !draft.connectionId && (
            <fieldset className="mt-4">
              <legend className="text-[12px] text-[var(--ink-60)]">How to sign in</legend>
              <div className="mt-1.5 space-y-1.5">
                <Choice name="conn-mcp-auth" value="signin" checked={mode === 'signin'} onPick={() => setMode('signin')} testId="conn-add-mcp-signin" title="Sign in with the server" small="Opens your browser. You approve access there; Plexii never sees your password." />
                <Choice name="conn-mcp-auth" value="token" checked={mode === 'token'} onPick={() => setMode('token')} testId="conn-add-mcp-token" title="Paste a token instead" small="For servers that give you a token to paste." />
              </div>
            </fieldset>
          )}

          {mode === 'token' && !draft.connectionId && needsAuth && (
            <Field id={props.ids.secret} label="Token">
              <SecretField ref={props.secretRef} id={props.ids.secret} describedBy={props.ids.secretHelp} onPresenceChange={props.setHasSecret} testId="conn-add-secret" />
              <p id={props.ids.secretHelp} className="mt-1.5 text-[12px] leading-relaxed text-[var(--ink-60)]">
                Stored encrypted on this Mac and sent only to {inspect.origin}. It’s never shown again.
              </p>
            </Field>
          )}

          {props.messageNode}

          <div className="mt-6 flex justify-end gap-2">
            {props.onBack && (
              <QuietButton onClick={props.onBack} disabled={Boolean(props.busy)} testId="conn-add-back">
                Back
              </QuietButton>
            )}
            <PrimaryButton type="submit" disabled={Boolean(props.busy) || (mode === 'token' && needsAuth && !draft.connectionId && !props.hasSecret)} testId="conn-add-submit">
              {props.busy === 'authorize' ? 'Waiting for your browser…' : props.busy ? 'Connecting…' : failed ? 'Try again' : !needsAuth ? 'Connect' : mode === 'token' && !draft.connectionId ? 'Connect with this token' : 'Sign in with the server'}
            </PrimaryButton>
          </div>
        </form>
      )}

      {!inspect?.ok && props.onBack && (
        <div className="mt-6 flex justify-end">
          <QuietButton onClick={props.onBack} testId="conn-add-back">
            Back
          </QuietButton>
        </div>
      )}
    </div>
  )
}

// ── Step 4: projects ──────────────────────────────────────────────────────────

function StepProjects(props: { connectionId: string; kind: ConnectionKind; confirmed: string[]; onDone: () => void }): JSX.Element {
  const api = window.api.aiSpace
  const [detail, setDetail] = useState<ConnectionDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    api
      .connectionDetail(props.connectionId)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [api, props.connectionId])

  const actions = detail ? defaultActions(props.kind, detail.operations) : []
  const pending = detail ? detail.operations.filter((o) => !operationUsable(o)).length : 0
  const writes = detail ? detail.operations.filter((o) => operationUsable(o) && o.classification === 'write').length : 0

  async function save(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      for (const projectId of chosen) await api.setGrant({ connectionId: props.connectionId, projectId, actions })
      announce(chosen.length ? `Access given to ${chosen.length} project${chosen.length === 1 ? '' : 's'}.` : 'No projects yet.')
      props.onDone()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <div data-testid="conn-add-step-4">
      {props.confirmed.length > 0 && <Confirmed lines={props.confirmed} />}
      {!detail && !error && (
        <p role="status" className="mt-4 text-[13px] text-[var(--ink-60)]">
          Loading projects…
        </p>
      )}
      {detail && (
        <>
          <p className="mt-4 text-[14px] leading-relaxed text-[var(--ink-70)]">
            {props.kind === 'model_api'
              ? 'The projects you tick can run models on this key. None are ticked to start.'
              : props.kind === 'app_api' || props.kind === 'mcp'
                ? 'The projects you tick get its tools that read data, and nothing else. Tools that take action are granted separately, per project, in the connection’s Access tab.'
                : 'The projects you tick can open and import from this account.'}
          </p>
          {(props.kind === 'app_api' || props.kind === 'mcp') && (writes > 0 || pending > 0) && (
            <p className="mt-1.5 text-[12px] text-[var(--ink-60)]" data-testid="conn-add-ops-note">
              {writes > 0 ? `${writes} tool${writes === 1 ? '' : 's'} that take action ${writes === 1 ? 'is' : 'are'} not included. ` : ''}
              {pending > 0 ? `${pending} tool${pending === 1 ? '' : 's'} need${pending === 1 ? 's' : ''} your review before any project can use ${pending === 1 ? 'it' : 'them'}.` : ''}
            </p>
          )}
          {detail.projects.length === 0 ? (
            <p className="mt-4 text-[14px] text-[var(--ink-70)]" data-testid="conn-add-no-projects">
              No projects in this workspace yet. You can give access later from the connection’s Access tab.
            </p>
          ) : (
            <fieldset className="mt-4">
              <legend className="sr-only">Projects</legend>
              <div className="space-y-1">
                {detail.projects.map((p) => (
                  <label key={p.id} className="flex items-center gap-2.5 min-h-[36px] px-2 rounded-[var(--radius-row)] hover:bg-[var(--surface-sunken)] text-[14px] text-[var(--ink-90)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[rgb(var(--accent))]">
                    <input type="checkbox" checked={chosen.includes(p.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))} data-testid={`conn-add-project-${p.id}`} className="h-4 w-4 accent-[rgb(var(--accent))]" />
                    {p.title || 'Untitled project'}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-[color:var(--ais-bad)]">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <QuietButton onClick={props.onDone} disabled={busy} testId="conn-add-skip">
          Skip for now
        </QuietButton>
        <PrimaryButton onClick={() => void save()} disabled={busy || chosen.length === 0} testId="conn-add-grant">
          {busy ? 'Saving…' : chosen.length > 1 ? `Give access to ${chosen.length} projects` : 'Give access'}
        </PrimaryButton>
      </div>
    </div>
  )
}

function Confirmed({ lines }: { lines: string[] }): JSX.Element {
  return (
    <div role="status" className="rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-3 py-2.5" data-testid="conn-add-confirmed">
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-[color:var(--ais-ok)]">
        <Icon name="check_circle" size={15} />
        What Plexii confirmed
      </p>
      <ul className="mt-1 pl-[21px] space-y-0.5 text-[13px] leading-relaxed text-[var(--ink-80)]">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  )
}

// ── Step 5: result ────────────────────────────────────────────────────────────

function StepResult(props: { connectionId: string; confirmed: string[]; onDone: () => void }): JSX.Element {
  const api = window.api.aiSpace
  const [detail, setDetail] = useState<ConnectionDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [projectId, setProjectId] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [defaultSet, setDefaultSet] = useState<string | null>(null)
  const ids = { project: useId(), model: useId() }

  useEffect(() => {
    let live = true
    api
      .connectionDetail(props.connectionId)
      .then((d) => {
        if (!live) return
        setDetail(d)
        const granted = d.connection.eligibleProjects[0]?.projectId ?? d.projects[0]?.id ?? ''
        setProjectId(granted)
        setModel(d.connection.defaultModel ?? d.connection.models[0]?.id ?? '')
      })
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [api, props.connectionId])

  const card: ConnectionCard | null = detail?.connection ?? null

  async function makeDefault(): Promise<void> {
    if (!card || !projectId || !model || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.setProjectDefault(projectId, card.id, model)
      const title = detail?.projects.find((p) => p.id === projectId)?.title ?? 'The project'
      setDefaultSet(`${title} now starts with ${card.alias} (${card.models.find((m) => m.id === model)?.label ?? model}).`)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="conn-add-step-5">
      {!card && !error && (
        <p role="status" className="text-[13px] text-[var(--ink-60)]">
          Loading…
        </p>
      )}
      {card && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-[var(--ink-100)]">{card.alias}</span>
            <StatusBadge status={card.status} />
          </div>
          <dl className="mt-3 grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2 text-[14px]">
            <dt className="text-[12px] leading-[20px] text-[var(--ink-50)]">What works</dt>
            <dd className="text-[var(--ink-90)]" data-testid="conn-add-result-caps">
              {passedCapabilities(card).length ? passedCapabilities(card).map((c) => CAPABILITY_LABEL[c]).join(', ') : 'Nothing confirmed yet'}
              {card.onThisMac && <OnThisMac />}
            </dd>
            <dt className="text-[12px] leading-[20px] text-[var(--ink-50)]">Account</dt>
            <dd className="text-[var(--ink-90)]">{card.providerOrg ?? card.identity ?? 'Not reported by the provider'}</dd>
            <dt className="text-[12px] leading-[20px] text-[var(--ink-50)]">Payer</dt>
            <dd className="text-[var(--ink-90)]" data-testid="conn-add-result-payer">
              {card.payer}
            </dd>
            <dt className="text-[12px] leading-[20px] text-[var(--ink-50)]">Projects</dt>
            <dd className="text-[var(--ink-90)]">{card.eligibleProjects.length ? card.eligibleProjects.map((p) => p.title).join(', ') : 'None yet'}</dd>
          </dl>
          {props.confirmed.length > 0 && (
            <div className="mt-4">
              <Confirmed lines={props.confirmed} />
            </div>
          )}
          {card.kind === 'model_api' && detail && detail.projects.length > 0 && (
            <div className="mt-5 border-t border-[var(--edge-hairline)] pt-4">
              <p className="text-[13px] font-medium text-[var(--ink-90)]">Set as project default</p>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label htmlFor={ids.project} className="block text-[12px] text-[var(--ink-60)]">
                    Project
                  </label>
                  <select id={ids.project} value={projectId} onChange={(e) => setProjectId(e.target.value)} className={FIELD_CLASS} data-testid="conn-add-default-project">
                    {detail.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={ids.model} className="block text-[12px] text-[var(--ink-60)]">
                    Model
                  </label>
                  <select id={ids.model} value={model} onChange={(e) => setModel(e.target.value)} className={FIELD_CLASS} data-testid="conn-add-default-model">
                    {card.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <QuietButton onClick={() => void makeDefault()} disabled={busy || !projectId || !model} testId="conn-add-set-default">
                  Set as project default
                </QuietButton>
                {defaultSet && (
                  <span role="status" className="text-[13px] text-[color:var(--ais-ok)]">
                    {defaultSet}
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-[color:var(--ais-bad)]">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end">
        <PrimaryButton onClick={props.onDone} testId="conn-add-done">
          Done
        </PrimaryButton>
      </div>
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function Field(props: { id: string; label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mt-4 first:mt-0">
      <label htmlFor={props.id} className="block text-[12px] text-[var(--ink-60)]">
        {props.label}
      </label>
      <div className="mt-1">{props.children}</div>
    </div>
  )
}

function Hint({ children }: { children: ReactNode }): JSX.Element {
  return <p className="mt-1 text-[12px] leading-relaxed text-[var(--ink-50)]">{children}</p>
}
