import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon'
import { DashboardHeader, StatTile, StatusPill, PLEXI_CARD } from '../plexi'
import { useSignStore } from '../../stores/sign'
import { useQuickCreate } from '../../stores/quickCreate'
import type { PlexiSignRequest, Signer, SignStatus, SignatureKind } from '@shared/sign'

// PlexiSign — send a document for signature, collect approvals in order, keep a
// tamper-evident trail. Built on the Plexii primitives. No fabricated data: an
// empty workspace shows an honest empty state.

const STATUS_TONE: Record<SignStatus, 'stone' | 'sky' | 'emerald' | 'rose'> = {
  draft: 'stone',
  out_for_signature: 'sky',
  completed: 'emerald',
  declined: 'rose',
  voided: 'stone'
}
const STATUS_LABEL: Record<SignStatus, string> = {
  draft: 'Draft',
  out_for_signature: 'Out for signature',
  completed: 'Completed',
  declined: 'Declined',
  voided: 'Voided'
}
const signedCount = (r: PlexiSignRequest): number => r.signers.filter((s) => s.status === 'signed').length
const nextSigner = (r: PlexiSignRequest): Signer | null =>
  r.status === 'out_for_signature'
    ? r.signers.filter((s) => s.status === 'pending').sort((a, b) => a.order - b.order)[0] ?? null
    : null
const fmt = (t: number): string => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/* ---------------- signature pad (typed + drawn) ---------------- */

function DrawPad({ onChange }: { onChange: (dataUrl: string | null) => void }): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const dirty = useRef(false)
  const pos = (e: React.PointerEvent): { x: number; y: number } => {
    const c = ref.current!
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height }
  }
  const down = (e: React.PointerEvent): void => {
    drawing.current = true
    const ctx = ref.current!.getContext('2d')!
    ctx.strokeStyle = '#e7ecf6'
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const p = pos(e)
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent): void => {
    if (!drawing.current) return
    const ctx = ref.current!.getContext('2d')!
    const p = pos(e)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    dirty.current = true
  }
  const up = (): void => {
    drawing.current = false
    if (dirty.current) onChange(ref.current!.toDataURL('image/png'))
  }
  const clear = (): void => {
    const c = ref.current!
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
    dirty.current = false
    onChange(null)
  }
  return (
    <div>
      <canvas
        ref={ref}
        width={520}
        height={140}
        className="w-full h-[120px] rounded-lg bg-stone-900 cursor-crosshair touch-none"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <button onClick={clear} className="mt-1 text-[11px] text-stone-400 hover:text-stone-200">Clear</button>
    </div>
  )
}

function SignBox({ signer, onSign }: { signer: Signer; onSign: (kind: SignatureKind, data: string) => void }): JSX.Element {
  const [kind, setKind] = useState<SignatureKind>('typed')
  const [typed, setTyped] = useState(signer.name)
  const [drawn, setDrawn] = useState<string | null>(null)
  const canSign = kind === 'typed' ? typed.trim().length > 0 : !!drawn
  return (
    <div className={`${PLEXI_CARD} p-3 mt-2`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[12px] font-semibold text-stone-800 dark:text-stone-100">Sign as {signer.name}</span>
        <span className="ml-auto inline-flex rounded-lg bg-stone-500/10 p-0.5 text-[11px]">
          <button onClick={() => setKind('typed')} className={`px-2 py-0.5 rounded-md ${kind === 'typed' ? 'bg-accent text-white' : 'text-stone-500'}`}>Type</button>
          <button onClick={() => setKind('drawn')} className={`px-2 py-0.5 rounded-md ${kind === 'drawn' ? 'bg-accent text-white' : 'text-stone-500'}`}>Draw</button>
        </span>
      </div>
      {kind === 'typed' ? (
        // Signature stage: forced-dark pad in every theme; its hairline is relative to the stage.
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Type your full name"
          className="w-full text-[20px] px-3 py-2 rounded-lg bg-stone-900 text-stone-50 border border-white/10 focus:border-accent"
          style={{ fontFamily: 'var(--font-hand)' }}
        />
      ) : (
        <DrawPad onChange={setDrawn} />
      )}
      <button
        onClick={() => {
          // Never submit empty signature data: the canSign guard already blocks
          // it, this makes the intent explicit so a future change cannot slip an
          // empty signature through.
          const data = kind === 'typed' ? typed.trim() : drawn
          if (!data) return
          onSign(kind, data)
        }}
        disabled={!canSign}
        className="mt-2 w-full text-[13px] font-semibold py-2 rounded-lg bg-accent text-white disabled:opacity-40"
        data-testid="sign-submit"
      >
        Sign &amp; continue
      </button>
    </div>
  )
}

/* ---------------- detail ---------------- */

function RequestDetail({ req }: { req: PlexiSignRequest }): JSX.Element {
  const { update, send, sign, voidRequest, decline, error, clearError } = useSignStore()
  const isDraft = req.status === 'draft'
  const turn = nextSigner(req)
  return (
    <div className={`${PLEXI_CARD} p-4`} data-testid="sign-detail">
      {error && (
        <div className="mb-3 flex items-center gap-2 text-[12px] text-rose-500" data-testid="sign-error">
          <Icon name="error_outline" size={14} /> {error}
          <button aria-label="Dismiss error" onClick={clearError} className="ml-auto text-[var(--ink-50)] hover:text-[var(--ink-100)]">
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
      <div className="flex items-start gap-2 mb-3">
        <div className="min-w-0 flex-1">
          {isDraft ? (
            <input
              defaultValue={req.title}
              onBlur={(e) => void update(req.id, { title: e.target.value })}
              className="w-full text-[16px] font-semibold bg-transparent text-stone-900 dark:text-stone-50 border-b border-transparent hover:border-[var(--edge-firm)] focus:border-accent"
            />
          ) : (
            <h2 className="text-[16px] font-semibold text-stone-900 dark:text-stone-50 truncate">{req.title}</h2>
          )}
          <div className="mt-1 flex items-center gap-2">
            <StatusPill tone={STATUS_TONE[req.status]} label={STATUS_LABEL[req.status]} />
            <span className="text-[11px] text-stone-400">{signedCount(req)}/{req.signers.length} signed</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isDraft && req.signers.length > 0 && (
            <button onClick={() => void send(req.id)} className="text-[12px] font-semibold px-3 py-1.5 rounded-lg bg-accent text-white" data-testid="sign-send">Send</button>
          )}
          {req.status === 'out_for_signature' && (
            <button onClick={() => void voidRequest(req.id)} className="fb-btn-surface text-[12px] px-3 py-1.5 text-[var(--ink-60)]">Void</button>
          )}
        </div>
      </div>

      {/* Agreement body */}
      {isDraft ? (
        <textarea
          defaultValue={req.body}
          onBlur={(e) => void update(req.id, { body: e.target.value })}
          placeholder="Paste or write the agreement to be signed…"
          className="fb-field w-full h-40 text-[13px] leading-relaxed px-3 py-2"
        />
      ) : (
        <div className="text-[13px] leading-relaxed whitespace-pre-wrap px-3 py-2 rounded-lg bg-[var(--surface-sunken)] max-h-48 overflow-auto">
          {req.body || <span className="text-stone-400">No agreement text.</span>}
        </div>
      )}

      {/* Signers */}
      <div className="mt-4">
        <div className="text-[10.5px] uppercase tracking-wide text-stone-400 mb-1.5">Signers (in order)</div>
        <div className="flex flex-col gap-1.5">
          {req.signers.slice().sort((a, b) => a.order - b.order).map((s) => (
            <div key={s.id} className="flex items-center gap-2.5 text-[12.5px]">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-stone-500/10 text-[11px] text-stone-500">{s.order + 1}</span>
              <span className="flex-1 min-w-0 truncate text-stone-800 dark:text-stone-100">{s.name}</span>
              {s.status === 'signed' && s.signedAt && <span className="text-[11px] text-stone-400">{fmt(s.signedAt)}</span>}
              <StatusPill
                tone={s.status === 'signed' ? 'emerald' : s.status === 'declined' ? 'rose' : turn?.id === s.id ? 'sky' : 'stone'}
                label={s.status === 'signed' ? 'Signed' : s.status === 'declined' ? 'Declined' : turn?.id === s.id ? 'Their turn' : 'Pending'}
              />
            </div>
          ))}
          {req.signers.length === 0 && <div className="text-[12px] text-stone-400">No signers yet — add some while this is a draft.</div>}
        </div>
      </div>

      {/* The active signer signs */}
      {turn && (
        <>
          <SignBox signer={turn} onSign={(kind, data) => void sign(req.id, { signerId: turn.id, kind, data })} />
          <button
            onClick={() => void decline(req.id, turn.id, '')}
            className="mt-1 text-[11px] text-rose-500/80 hover:text-rose-500"
          >
            {turn.name} declines to sign
          </button>
        </>
      )}

      {/* Certificate */}
      {req.status === 'completed' && req.certificate && (
        <div className="mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-emerald-600 dark:text-emerald-400">
            <Icon name="verified" size={15} /> Completed &amp; certified
          </div>
          <div className="mt-1 text-[11px] text-stone-500">Tamper-evident certificate (sha256 over the agreement + every signature). Signatures are self-attested, not identity-verified.</div>
          <div className="mt-1 font-mono text-[10.5px] break-all text-stone-600 dark:text-stone-300">{req.certificate}</div>
        </div>
      )}

      {/* Audit trail */}
      <div className="mt-4">
        <div className="text-[10.5px] uppercase tracking-wide text-stone-400 mb-1.5">Audit trail</div>
        <div className="flex flex-col gap-1">
          {req.audit.map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-[11.5px] text-stone-500">
              <span className="h-1.5 w-1.5 rounded-full bg-accent/50" />
              <span className="text-stone-700 dark:text-stone-300 capitalize">{a.event}</span>
              {a.detail && <span className="truncate">· {a.detail}</span>}
              <span className="ml-auto text-stone-400 shrink-0">{fmt(a.at)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ---------------- new-agreement composer ---------------- */

function Composer({ onCreate, onClose }: { onCreate: (t: string, b: string, names: string[]) => void; onClose: () => void }): JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [signers, setSigners] = useState('')
  const names = signers.split(/[\n,]/).map((n) => n.trim()).filter(Boolean)
  return (
    <div className={`${PLEXI_CARD} p-3`} data-testid="sign-composer">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Agreement title" className="fb-field w-full text-[13px] font-medium px-2.5 py-2" data-testid="sign-new-title" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What is being agreed…" className="fb-field mt-2 w-full h-20 text-[12.5px] px-2.5 py-2" />
      <textarea value={signers} onChange={(e) => setSigners(e.target.value)} placeholder="Signers, one per line or comma-separated (in signing order)" className="fb-field mt-2 w-full h-16 text-[12.5px] px-2.5 py-2" />
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => onCreate(title || 'Untitled agreement', body, names)} disabled={!title.trim()} className="text-[12px] font-semibold px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-40" data-testid="sign-new-create">Create draft</button>
        <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded-lg text-stone-500">Cancel</button>
        {names.length > 0 && <span className="text-[11px] text-stone-400">{names.length} signer{names.length === 1 ? '' : 's'}</span>}
      </div>
    </div>
  )
}

/* ---------------- view ---------------- */

export default function PlexiSignView(): JSX.Element {
  const { requests, loaded, load, create, remove } = useSignStore()
  const [selId, setSelId] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  // Palette quick-create ("New signature request" from Cmd+K anywhere) lands
  // here: consume the pending request and open the composer.
  const quickPending = useQuickCreate((s) => s.pending)
  useEffect(() => {
    if (quickPending === 'sign' && useQuickCreate.getState().consume('sign')) setComposing(true)
  }, [quickPending])

  const selected = requests.find((r) => r.id === selId) ?? null
  const total = requests.length
  const out = requests.filter((r) => r.status === 'out_for_signature').length
  const done = requests.filter((r) => r.status === 'completed').length
  const drafts = requests.filter((r) => r.status === 'draft').length

  async function doCreate(t: string, b: string, names: string[]): Promise<void> {
    const req = await create(t, b, names)
    setComposing(false)
    if (req) setSelId(req.id)
  }

  return (
    <div className="h-full overflow-auto desk-paper no-tod p-6" data-testid="plexisign">
      <div className="max-w-6xl mx-auto">
        <DashboardHeader
          title="PlexiiSign"
          subtitle="Send a document for signature, collect approvals in order, keep a tamper-evident trail."
          actions={
            <button onClick={() => setComposing(true)} className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3 py-1.5 rounded-lg bg-accent text-white" data-testid="sign-new">
              <Icon name="add" size={15} /> New agreement
            </button>
          }
        />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <StatTile icon="draft" label="Agreements" value={total} tone="accent" />
          <StatTile icon="outgoing_mail" label="Out for signature" value={out} tone="sky" />
          <StatTile icon="verified" label="Completed" value={done} tone="emerald" />
          <StatTile icon="edit_note" label="Drafts" value={drafts} tone="violet" />
        </div>

        <div className="flex gap-5 items-start">
          <div className="w-[360px] shrink-0 flex flex-col gap-2">
            {composing && <Composer onCreate={(t, b, n) => void doCreate(t, b, n)} onClose={() => setComposing(false)} />}
            {!loaded && <div className="text-[12px] text-stone-400 px-1">Loading…</div>}
            {loaded && requests.length === 0 && !composing && (
              <div className={`${PLEXI_CARD} p-6 text-center`}>
                <Icon name="draw" size={22} className="text-stone-300 dark:text-stone-600" />
                <p className="mt-2 text-[12.5px] text-stone-500 dark:text-stone-400">No agreements yet. Create one, add signers, and send it for signature.</p>
              </div>
            )}
            {requests.map((r) => (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelId(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelId(r.id)
                  }
                }}
                className={`${PLEXI_CARD} p-3 text-left fb-lift cursor-pointer ${selId === r.id ? '!border-accent' : ''}`}
                data-testid={`sign-row-${r.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-stone-900 dark:text-stone-50 truncate flex-1 min-w-0">{r.title}</span>
                  <StatusPill tone={STATUS_TONE[r.status]} label={STATUS_LABEL[r.status]} />
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-stone-400">
                  <span>{signedCount(r)}/{r.signers.length} signed</span>
                  <span>·</span>
                  <span>{fmt(r.updatedAt)}</span>
                  <button
                    type="button"
                    aria-label="Delete agreement"
                    className="ml-auto opacity-0 hover:opacity-100 focus:opacity-100 rounded"
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(r.id)
                      if (selId === r.id) setSelId(null)
                    }}
                  >
                    <Icon name="delete" size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 min-w-0">
            {selected ? (
              <RequestDetail key={selected.id} req={selected} />
            ) : (
              <div className={`${PLEXI_CARD} p-10 text-center text-stone-400 text-[13px]`}>
                Select an agreement, or create a new one to get started.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
