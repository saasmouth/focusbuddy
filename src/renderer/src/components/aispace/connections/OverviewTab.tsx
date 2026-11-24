// Side panel › Overview: who this connection is, who pays, where data goes,
// what was checked, and the verbs (SPEC-CONNECTIONS.md §2 "Put Test
// connection, Reconnect, Rotate key, Pause and Disconnect behind clear verb
// labels"; §3 rotation and disconnect rules).
//
// No field here can reveal a key. The only trace of one is its last four
// characters, which main stores as a hint.

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ConnectionCard } from '@shared/aispace/api'
import type { AiWorkspace } from '@shared/aispace/model'
import { CAPABILITY_LABEL, CONNECTION_STATUS_LABEL } from '@shared/aispace/connections'
import Icon from '../../Icon'
import { useNoticeStore } from '../../../stores/notice'
import { announce, fmtAgo, LinkButton, PrimaryButton, QuietButton, StatusBadge } from '../ui'
import type { ImpactRequest } from './AccessImpactDialog'
import { CAPABILITY_STATE, CERTIFICATION_LABEL, errorText, ownerLabel, workspaceLabel } from './model'
import { FIELD_CLASS, readAndClear, SecretField } from './SecretField'

type SecretMode = 'rotate' | 'reconnect'

export default function OverviewTab(props: {
  card: ConnectionCard
  workspaces: AiWorkspace[]
  onChanged: () => void
  onAskImpact: (req: ImpactRequest) => void
  onAddSeparate: (providerId: string, workspaceId: string) => void
}): JSX.Element {
  const { card } = props
  const api = window.api.aiSpace
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ title: string; lines: string[]; ok: boolean; separate?: { providerId: string } | null } | null>(null)
  const [secretMode, setSecretMode] = useState<SecretMode | null>(null)
  const [hasSecret, setHasSecret] = useState(false)
  const secretRef = useRef<HTMLInputElement>(null)
  const secretId = useId()
  const secretHelpId = useId()
  const notice = (text: string, icon = 'check_circle'): void => useNoticeStore.getState().show({ text, icon })

  const disconnected = card.status === 'disconnected'
  const takesKey = card.kind === 'model_api' || card.kind === 'app_api'
  const mcpOAuth = card.kind === 'mcp' && card.config.authMode === 'oauth'
  const mcpBearer = card.kind === 'mcp' && card.config.authMode === 'bearer'
  const workspace = props.workspaces.find((w) => w.id === card.workspaceId)

  async function act(label: string, fn: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      setResult({ title: `${label} didn’t finish`, lines: [errorText(e)], ok: false })
    } finally {
      setBusy(null)
    }
  }

  const test = (): Promise<void> =>
    act('Test connection', async () => {
      setResult(null)
      const r = await api.testConnection(card.id)
      const ok = r.connection.status === 'ready' || r.connection.status === 'limited'
      setResult({ title: ok ? 'Checked just now' : `Check finished: ${CONNECTION_STATUS_LABEL[r.connection.status]}`, lines: r.confirmed, ok })
      announce(`Checked ${card.alias}.`)
      props.onChanged()
    })

  const signInAgain = (): Promise<void> =>
    act('Sign in', async () => {
      setResult(null)
      const r = await api.authorizeMcp(card.id)
      setResult({ title: r.ok ? 'Signed in again' : r.outcome === 'denied' ? 'Sign-in was declined' : r.outcome === 'timeout' ? 'Sign-in timed out' : 'Sign-in didn’t finish', lines: [r.detail], ok: r.ok })
      if (r.ok) notice(`${card.alias} is signed in again.`)
      props.onChanged()
    })

  async function submitSecret(): Promise<void> {
    if (!secretMode || busy) return
    // Out of the field before anything else happens, whatever the outcome.
    const secret = readAndClear(secretRef)
    setHasSecret(false)
    if (!secret) return
    const mode = secretMode
    await act(mode === 'rotate' ? 'Rotate key' : 'Reconnect', async () => {
      setResult(null)
      const r = await api.replaceKey(card.id, secret, mode)
      if (r.ok) {
        setSecretMode(null)
        setResult({ title: mode === 'rotate' ? 'Key replaced' : 'Reconnected', lines: r.confirmed, ok: true })
        notice(mode === 'rotate' ? `${card.alias} now uses the new key.` : `${card.alias} is reconnected.`)
        props.onChanged()
      } else {
        setResult({ title: 'The key wasn’t changed', lines: [r.detail, ...(r.confirmed ?? [])], ok: false, separate: r.separate ? { providerId: r.separate.providerId } : null })
      }
    })
  }

  function askPause(): void {
    props.onAskImpact({
      title: `Pause ${card.alias}?`,
      effect: 'New calls stop at once. Work already running at a provider keeps running there. You can resume any time.',
      confirmLabel: 'Pause',
      load: () => api.accessImpact(card.id),
      run: async () => {
        await api.pauseConnection(card.id)
        notice(`${card.alias} is paused.`, 'pause_circle')
        announce(`${card.alias} paused.`)
        props.onChanged()
      }
    })
  }

  const resume = (): Promise<void> =>
    act('Resume', async () => {
      await api.resumeConnection(card.id)
      notice(`${card.alias} is back on.`)
      announce(`${card.alias} resumed.`)
      props.onChanged()
    })

  function askDisconnect(): void {
    props.onAskImpact({
      title: `Disconnect ${card.alias}?`,
      effect:
        card.kind === 'ai_account'
          ? 'Plexii stops opening and importing chats for it and removes every project’s access. History stays.'
          : 'New calls stop at once. Plexii deletes its stored copy of the credential and removes every project’s access. Run history and outputs stay.',
      confirmLabel: 'Disconnect',
      danger: true,
      load: () => api.accessImpact(card.id),
      run: async () => {
        const r = await api.disconnect(card.id)
        setResult(null)
        notice(`${card.alias} is disconnected.`, 'power_off')
        announce(`${card.alias} disconnected.${r.connection.providerAction ? ` ${r.connection.providerAction}` : ''}`)
        props.onChanged()
      }
    })
  }

  const secretText = card.kind === 'ai_account' ? 'Nothing stored. Links open in your browser, signed in as you.' : card.hasSecret ? (card.secretHint ? `Key ending ${card.secretHint}` : card.kind === 'mcp' ? 'Signed in. The token is stored encrypted on this Mac.' : 'Stored encrypted on this Mac.') : card.kind === 'mcp' && card.config.authMode === 'none' ? 'No sign-in needed.' : 'Nothing stored.'

  return (
    <div className="space-y-6" data-testid="conn-overview">
      {/* Status, and what to do about it. */}
      <div>
        <div className="flex items-center gap-2">
          <StatusBadge status={card.status} label={CONNECTION_STATUS_LABEL[card.status]} />
          <span className="text-[12px] text-[var(--ink-50)] fb-tabular">since {fmtAgo(card.statusSince)}</span>
        </div>
        {card.statusDetail && <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--ink-80)]">{card.statusDetail}</p>}
        {card.status === 'paused' && card.pausedBy && <p className="mt-1 text-[12px] text-[var(--ink-60)]">Paused by {card.pausedBy}.</p>}
      </div>

      {card.providerAction && (
        <div role="note" data-testid="conn-provider-action" className="rounded-[var(--radius-row)] border border-[color-mix(in_oklab,var(--ais-warn)_45%,transparent)] bg-[color-mix(in_oklab,var(--ais-warn)_8%,transparent)] p-3">
          <div className="flex items-start gap-2">
            <Icon name="key_off" size={18} className="mt-0.5 shrink-0 text-[color:var(--ais-warn)]" />
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-[var(--ink-100)]">One more step at the provider</p>
              <p className="mt-1 text-[14px] leading-relaxed text-[var(--ink-80)]">{card.providerAction}</p>
              {card.keySettingsUrl && (
                <div className="mt-2">
                  <LinkButton onClick={() => void api.openOriginal(card.keySettingsUrl!)} testId="conn-provider-action-link">
                    Open {card.providerName} key settings
                    <Icon name="open_in_new" size={14} />
                  </LinkButton>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Verbs. */}
      {!disconnected && (
        <div className="flex flex-wrap items-center gap-2" data-testid="conn-verbs">
          <QuietButton icon="network_check" onClick={() => void test()} disabled={Boolean(busy)} testId="conn-test">
            {busy === 'Test connection' ? 'Checking…' : 'Test connection'}
          </QuietButton>
          {card.status === 'reconnect_required' && takesKey && (
            <QuietButton icon="link" onClick={() => setSecretMode('reconnect')} disabled={Boolean(busy)} testId="conn-reconnect">
              Reconnect
            </QuietButton>
          )}
          {(card.status === 'reconnect_required' || card.status === 'draft') && mcpOAuth && (
            <QuietButton icon="login" onClick={() => void signInAgain()} disabled={Boolean(busy)} testId="conn-reconnect">
              {busy === 'Sign in' ? 'Waiting for your browser…' : card.status === 'draft' ? 'Finish signing in' : 'Reconnect'}
            </QuietButton>
          )}
          {takesKey && card.status !== 'reconnect_required' && (
            <QuietButton icon="autorenew" onClick={() => setSecretMode('rotate')} disabled={Boolean(busy)} testId="conn-rotate">
              {card.kind === 'app_api' ? 'Replace token' : 'Rotate key'}
            </QuietButton>
          )}
          {card.status === 'paused' ? (
            <QuietButton icon="play_circle" onClick={() => void resume()} disabled={Boolean(busy)} testId="conn-resume">
              Resume
            </QuietButton>
          ) : (
            <QuietButton icon="pause_circle" onClick={askPause} disabled={Boolean(busy)} testId="conn-pause">
              Pause
            </QuietButton>
          )}
          <QuietButton icon="power_off" danger onClick={askDisconnect} disabled={Boolean(busy)} testId="conn-disconnect">
            Disconnect
          </QuietButton>
          {card.kind === 'model_api' && <p className="basis-full text-[12px] text-[var(--ink-50)]">Test connection is a read-only check. It costs nothing.</p>}
        </div>
      )}
      {card.status === 'reconnect_required' && mcpBearer && (
        <p className="text-[13px] text-[var(--ink-70)]">This server uses a pasted token. To use a new one, disconnect it and add the server again with the new token.</p>
      )}

      {secretMode && (
        <form
          className="rounded-[var(--radius-row)] bg-[var(--surface-sunken)] p-3"
          data-testid="conn-secret-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submitSecret()
          }}
        >
          <label htmlFor={secretId} className="block text-[13px] font-medium text-[var(--ink-90)]">
            {secretMode === 'rotate' ? `New ${card.kind === 'app_api' ? 'token' : 'key'} for ${card.alias}` : `Paste a working ${card.kind === 'app_api' ? 'token' : 'key'} for ${card.alias}`}
          </label>
          <div className="mt-1.5">
            <SecretField ref={secretRef} id={secretId} describedBy={secretHelpId} onPresenceChange={setHasSecret} testId="conn-secret-input" autoFocus />
          </div>
          <p id={secretHelpId} className="mt-1.5 text-[12px] leading-relaxed text-[var(--ink-60)]">
            Plexii checks it with a free, read-only call first and switches only if it belongs to the same account. A key for a different account becomes a separate connection.
          </p>
          {card.keySettingsUrl && (
            <div className="mt-1">
              <LinkButton onClick={() => void api.openOriginal(card.keySettingsUrl!)}>
                Where do I get a {card.kind === 'app_api' ? 'token' : 'key'}?
                <Icon name="open_in_new" size={14} />
              </LinkButton>
            </div>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <QuietButton
              onClick={() => {
                readAndClear(secretRef)
                setHasSecret(false)
                setSecretMode(null)
              }}
            >
              Cancel
            </QuietButton>
            <PrimaryButton type="submit" disabled={!hasSecret || Boolean(busy)} testId="conn-secret-submit">
              {busy ? 'Checking…' : secretMode === 'rotate' ? 'Check and switch' : 'Check and reconnect'}
            </PrimaryButton>
          </div>
        </form>
      )}

      {result && (
        <div role="status" data-testid="conn-result" className="rounded-[var(--radius-row)] bg-[var(--surface-sunken)] p-3">
          <p className={`flex items-center gap-1.5 text-[13px] font-medium ${result.ok ? 'text-[color:var(--ais-ok)]' : 'text-[color:var(--ais-bad)]'}`}>
            <Icon name={result.ok ? 'check_circle' : 'error'} size={15} />
            {result.title}
          </p>
          <ul className="mt-1.5 space-y-1 text-[13px] leading-relaxed text-[var(--ink-80)]" data-testid="conn-result-lines">
            {result.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {result.separate && (
            <div className="mt-2">
              <QuietButton icon="add" onClick={() => props.onAddSeparate(result.separate!.providerId, card.workspaceId)} testId="conn-add-separate">
                Add it as a separate connection
              </QuietButton>
            </div>
          )}
        </div>
      )}

      {/* Facts. */}
      <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2.5 text-[14px]" data-testid="conn-facts">
        <Fact term="Provider">
          {card.providerName}
          {card.group !== card.providerName && <span className="text-[var(--ink-50)]"> · {card.group}</span>}
        </Fact>
        <Fact term="Name">
          <InlineEdit value={card.alias} label="Name" testId="conn-alias" disabled={disconnected} onSave={(v) => api.renameConnection(card.id, v, card.billedTo).then(props.onChanged)} />
        </Fact>
        <Fact term="Payer">
          <InlineEdit
            value={card.billedTo ?? ''}
            display={card.payer}
            label="Payer"
            placeholder="Who is billed, e.g. SaaSMouth Ltd"
            allowEmpty
            testId="conn-payer"
            disabled={disconnected}
            onSave={(v) => api.renameConnection(card.id, card.alias, v.trim() ? v.trim() : null).then(props.onChanged)}
          />
        </Fact>
        <Fact term="Account">{card.providerOrg ?? <span className="text-[var(--ink-60)]">Not reported by the provider</span>}</Fact>
        <Fact term={ownerLabel(card.kind)}>{card.credentialOwner}</Fact>
        <Fact term="Workspace">{workspaceLabel(workspace)}</Fact>
        <Fact term="Sends data to">{card.dataDestination ?? <span className="text-[var(--ink-60)]">Unknown</span>}</Fact>
        {card.kind === 'mcp' && card.endpoint && (
          <Fact term="Address">
            <span className="fb-mono text-[13px] break-all">{card.endpoint}</span>
          </Fact>
        )}
        {card.kind === 'mcp' && (
          <Fact term="Verified origin">
            <span className="fb-mono text-[13px] break-all">{card.verifiedOrigin ?? 'Not verified'}</span>
            {card.onThisMac && <OnThisMac />}
          </Fact>
        )}
        {card.kind === 'mcp' && card.config.grantedScope && <Fact term="Access granted">{card.config.grantedScope}</Fact>}
        <Fact term="Last checked">
          <span className="fb-tabular">{card.lastCheckedAt ? fmtAgo(card.lastCheckedAt) : 'Not checked yet'}</span>
        </Fact>
        <Fact term={card.kind === 'mcp' ? 'Sign-in' : card.kind === 'ai_account' ? 'Stored' : 'Key'}>
          <span data-testid="conn-secret-hint" className={card.secretHint ? 'fb-mono text-[13px]' : ''}>
            {secretText}
          </span>
        </Fact>
      </dl>

      {/* What it rests on. */}
      {card.certification && (
        <section aria-label="How this connection type was tested">
          <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ink-50)]">{CERTIFICATION_LABEL[card.certification.status]}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-70)]" data-testid="conn-certification">
            {card.certification.basis}
          </p>
        </section>
      )}

      {/* Capability health, one row each (§2 "Record health per capability"). */}
      <section aria-label="Capabilities">
        <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ink-50)]">What it can do</h3>
        {card.capabilities.length === 0 ? (
          <p className="mt-1 text-[13px] text-[var(--ink-60)]">Nothing checked yet. Test the connection to find out.</p>
        ) : (
          <ul className="mt-2 space-y-2" data-testid="conn-capabilities">
            {card.capabilities.map((h) => {
              const s = CAPABILITY_STATE[h.state]
              return (
                <li key={h.capability} className="text-[14px]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--ink-90)]">{CAPABILITY_LABEL[h.capability]}</span>
                    <StatusBadge status={s.status} label={s.label} />
                    {h.checkedAt && <span className="ml-auto text-[12px] text-[var(--ink-50)] fb-tabular">{fmtAgo(h.checkedAt)}</span>}
                  </div>
                  {h.detail && <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ink-60)]">{h.detail}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function Fact(props: { term: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-[12px] leading-[20px] text-[var(--ink-50)]">{props.term}</dt>
      <dd className="min-w-0 text-[var(--ink-90)]">{props.children}</dd>
    </>
  )
}

export function OnThisMac(): JSX.Element {
  return (
    <span className="ml-2 inline-flex items-center gap-1 h-[20px] px-1.5 rounded-[var(--radius-chip,8px)] bg-[var(--surface-sunken)] text-[12px] text-[var(--ink-70)] whitespace-nowrap" data-testid="conn-on-this-mac">
      <Icon name="laptop_mac" size={13} />
      On this Mac
    </span>
  )
}

// Click Edit (or press Enter on it), type, Enter saves, Escape cancels without
// closing the panel.
function InlineEdit(props: { value: string; display?: string; label: string; placeholder?: string; allowEmpty?: boolean; testId: string; disabled?: boolean; onSave: (v: string) => Promise<unknown> }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.value)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const editBtn = useRef<HTMLButtonElement>(null)
  const inputId = useId()

  async function save(): Promise<void> {
    const v = draft.trim()
    if (!v && !props.allowEmpty) {
      setError(`${props.label} can’t be empty.`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await props.onSave(v)
      setEditing(false)
      setTimeout(() => editBtn.current?.focus(), 0)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      // The panel listens for Escape too; this one only ends the edit.
      e.preventDefault()
      e.stopPropagation()
      setEditing(false)
      setTimeout(() => editBtn.current?.focus(), 0)
    }
  }

  if (!editing) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span data-testid={`${props.testId}-value`}>{props.display ?? props.value}</span>
        {!props.disabled && (
          <button
            ref={editBtn}
            type="button"
            onClick={() => {
              setDraft(props.value)
              setError(null)
              setEditing(true)
            }}
            aria-label={`Edit ${props.label.toLowerCase()}`}
            data-testid={`${props.testId}-edit`}
            className="inline-flex items-center min-h-[24px] px-1.5 rounded-md text-[12px] text-[var(--ink-60)] hover:text-[var(--ink-100)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
          >
            Edit
          </button>
        )}
      </span>
    )
  }
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {props.label}
      </label>
      <input id={inputId} autoFocus value={draft} placeholder={props.placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} className={FIELD_CLASS} data-testid={`${props.testId}-input`} />
      {props.allowEmpty && <span className="text-[12px] text-[var(--ink-50)]">Leave blank if you’re not sure. It shows as Unknown payer.</span>}
      {error && (
        <span role="alert" className="text-[12px] text-[color:var(--ais-bad)]">
          {error}
        </span>
      )}
      <span className="flex items-center gap-2">
        <PrimaryButton type="submit" disabled={saving} testId={`${props.testId}-save`}>
          Save
        </PrimaryButton>
        <QuietButton
          onClick={() => {
            setEditing(false)
            setTimeout(() => editBtn.current?.focus(), 0)
          }}
        >
          Cancel
        </QuietButton>
      </span>
    </form>
  )
}
