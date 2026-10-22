import { useEffect, useState } from 'react'
import { confirmDialog } from '../plexi/PromptDialog'
import type { VaultEntryStored, VaultSecret } from '@shared/types'
import { useVaultStore } from '../../stores/vault'
import { generateTotp, looksLikeTotpSecret } from '../../lib/totp'
import { chimeIn, chimeOut } from '../../lib/audioBeep'
import Icon from '../Icon'
import PlexiiIcon from '../PlexiiIcon'

// Vault — master-password-encrypted credentials with TOTP. Three states:
//   1. No vault yet → "Create your vault" form (set master password)
//   2. Vault exists but locked → "Unlock" form
//   3. Vault unlocked → list of entries + add/edit/reveal/copy actions
export default function VaultView(): JSX.Element {
  const meta = useVaultStore((s) => s.meta)
  const unlocked = useVaultStore((s) => s.unlocked)
  const initStatus = useVaultStore((s) => s.initStatus)
  const refreshMeta = useVaultStore((s) => s.refreshMeta)
  const lock = useVaultStore((s) => s.lock)

  useEffect(() => {
    void refreshMeta()
  }, [refreshMeta])

  if (initStatus !== 'ready' || meta === null) {
    return (
      <div className="h-full flex items-center justify-center desk-paper no-tod">
        <PlexiiIcon kind="app" id="vault" size={32} fallback="lock" fallbackClassName="text-[var(--ink-40)]" className="animate-pulse" />
      </div>
    )
  }

  if (!meta.exists) return <CreateVaultPanel />
  if (!unlocked) return <UnlockVaultPanel />

  return <UnlockedVaultView onLock={lock} />
}

// ── Unlocked view shell — header (lock + change password) and the entry list ──

function UnlockedVaultView({ onLock }: { onLock: () => Promise<void> }): JSX.Element {
  const [changingPassword, setChangingPassword] = useState(false)

  return (
    <div className="h-full overflow-auto desk-paper no-tod">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
        <header className="flex items-center gap-3">
          <div className="inline-flex items-center justify-center h-10 w-10 rounded-[var(--radius-row)] bg-[var(--surface-sunken)] shrink-0">
            <Icon name="lock_open" size={20} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-[var(--ink-100)]">
              PlexiiVault
            </h1>
            <p className="text-[12px] text-[var(--ink-50)]">
              Encrypted at rest with your master password. Stays on this device.
            </p>
          </div>
          <button
            onClick={() => setChangingPassword(true)}
            className="btn-ghost"
            title="Change your master password — re-encrypts every entry under the new key"
          >
            <Icon name="password" size={14} />
            <span>Change password</span>
          </button>
          <button
            onClick={() => {
              chimeOut()
              void onLock()
            }}
            className="btn-ghost"
            title="Lock vault (clears the master key from memory)"
          >
            <Icon name="lock" size={14} />
            <span>Lock</span>
          </button>
        </header>

        <UnlockVaultMethods />

        <UnlockedVault />
      </div>

      {changingPassword && (
        <ChangeMasterPasswordDialog onClose={() => setChangingPassword(false)} />
      )}
    </div>
  )
}

// ── Faster ways back in ──────────────────────────────────────────────────────
//
// Enrolment lives on the UNLOCKED screen because a method wraps the live key,
// and the only time that key exists is while the vault is open. It is also the
// honest place to say what the method does and does not protect: the user is
// agreeing to a trade, and a trade stated only in a tooltip is not stated.

function UnlockVaultMethods(): JSX.Element | null {
  const methods = useVaultStore((s) => s.unlockMethods)
  const enroll = useVaultStore((s) => s.enrollUnlockMethod)
  const forget = useVaultStore((s) => s.forgetUnlockMethod)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (methods.length === 0) return null

  async function toggle(m: (typeof methods)[number]): Promise<void> {
    setError(null)
    setBusy(m.id)
    try {
      if (m.enrolled) {
        await forget(m.id)
      } else {
        const r = await enroll(m.id)
        if (!r.ok) setError(r.error)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="fb-card p-4" data-testid="vault-unlock-methods">
      <h2 className="text-sm font-semibold text-[var(--ink-100)] mb-1">
        Faster ways to unlock
      </h2>
      <p className="text-[12px] text-[var(--ink-50)] mb-3">
        Your master password is always a way in. These are shortcuts past typing it.
      </p>
      <ul className="space-y-2">
        {methods.map((m) => (
          <li
            key={m.id}
            className="flex items-start gap-3 p-3 rounded-[var(--radius-row)] bg-[var(--surface-sunken)]"
            data-testid={`vault-method-${m.id}`}
          >
            <Icon
              name={m.id === 'biometric' ? 'fingerprint' : 'key'}
              size={18}
              className={m.enrolled ? 'text-accent mt-0.5' : 'text-[var(--ink-40)] mt-0.5'}
            />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-[var(--ink-100)]">{m.label}</div>
              {/* The trade, in full. `safeStorage` is login-keychain protected,
                  not Secure Enclave — so this is a convenience gate, and
                  saying otherwise would be selling it as security it does not
                  have. */}
              <p className="text-[11px] text-[var(--ink-50)] leading-snug mt-0.5">
                {m.available ? m.detail : m.unavailableReason}
              </p>
            </div>
            <button
              onClick={() => void toggle(m)}
              disabled={!m.available || busy === m.id}
              className={m.enrolled ? 'btn-ghost shrink-0' : 'btn-primary shrink-0'}
              data-testid={`vault-method-toggle-${m.id}`}
            >
              {m.enrolled ? 'Turn off' : 'Set up'}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <div className="mt-3 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 rounded p-2">
          {error}
        </div>
      )}
    </section>
  )
}

// ── Create vault panel ───────────────────────────────────────────────────────

function CreateVaultPanel(): JSX.Element {
  const createVault = useVaultStore((s) => s.createWithMaster)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    if (busy) return
    setError(null)
    if (password.length < 8) {
      setError('Master password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords don\'t match.')
      return
    }
    setBusy(true)
    try {
      const r = await createVault(password)
      if (!r.ok) setError(r.error)
      else chimeIn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex items-center justify-center desk-paper no-tod px-6">
      <div className="w-full max-w-md fb-card p-6">
        <div className="text-center mb-5">
          <Icon name="enhanced_encryption" size={32} className="text-accent mx-auto mb-2" />
          <h1 className="text-lg font-semibold text-[var(--ink-100)]">
            Set up your vault
          </h1>
          <p className="text-[12px] text-[var(--ink-50)] mt-1 leading-relaxed">
            Your credentials are encrypted with this master password using AES-256-GCM,
            derived via PBKDF2-SHA256 (600k iterations). The password is never stored —
            if you lose it, the vault is unrecoverable.
          </p>
        </div>

        <label className="block mb-3">
          <span className="text-[11px] uppercase tracking-wider text-[var(--ink-50)] font-medium">
            Master password
          </span>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder="At least 8 characters"
            className="fb-field mt-1 w-full bg-[var(--surface-raised)] px-3 py-2 text-sm"
          />
        </label>
        <label className="block mb-4">
          <span className="text-[11px] uppercase tracking-wider text-[var(--ink-50)] font-medium">
            Confirm
          </span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            className="fb-field mt-1 w-full bg-[var(--surface-raised)] px-3 py-2 text-sm"
          />
        </label>

        {error && (
          <div className="mb-3 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 rounded p-2">
            {error}
          </div>
        )}

        <button
          onClick={() => void submit()}
          disabled={busy || !password || !confirm}
          className="w-full btn-primary justify-center"
        >
          <Icon name="enhanced_encryption" size={14} />
          <span>{busy ? 'Creating…' : 'Create vault'}</span>
        </button>

        <p className="mt-4 text-[10px] text-[var(--ink-50)] text-center leading-relaxed">
          Tip: use a passphrase you can remember without writing down. No recovery exists.
        </p>
      </div>
    </div>
  )
}

// ── Unlock vault panel ───────────────────────────────────────────────────────

function UnlockVaultPanel(): JSX.Element {
  const unlock = useVaultStore((s) => s.unlock)
  const unlockWith = useVaultStore((s) => s.unlockWith)
  const methods = useVaultStore((s) => s.unlockMethods)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only methods that are both set up and usable right now. One that is
  // available but not enrolled belongs on the unlocked screen, where the key
  // exists to wrap — offering it here would be a button that cannot work.
  const ready = methods.filter((m) => m.available && m.enrolled)

  async function viaMethod(id: (typeof methods)[number]['id']): Promise<void> {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const r = await unlockWith(id)
      if (r.ok) chimeIn()
      else if (!r.cancelled) setError(r.error)
    } finally {
      setBusy(false)
    }
  }

  async function submit(): Promise<void> {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const r = await unlock(password)
      if (!r.ok) setError(r.error)
      else chimeIn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex items-center justify-center desk-paper no-tod px-6">
      <div className="w-full max-w-sm fb-card p-6">
        <div className="text-center mb-5">
          <PlexiiIcon kind="app" id="vault" size={36} fallback="lock" fallbackClassName="text-accent" className="mx-auto mb-2 block" />
          <h1 className="text-lg font-semibold text-[var(--ink-100)]">
            Unlock vault
          </h1>
        </div>
        {/* Set-up methods first, because they are the faster way in. The
            password field stays right below rather than behind a "use password
            instead" link — if Touch ID fails at the wrong moment, being one
            click from your own vault is not acceptable. */}
        {ready.length > 0 && (
          <div className="mb-4 space-y-2">
            {ready.map((m) => (
              <button
                key={m.id}
                onClick={() => void viaMethod(m.id)}
                disabled={busy}
                data-testid={`vault-unlock-with-${m.id}`}
                className="w-full btn-primary justify-center"
              >
                <Icon name={m.id === 'biometric' ? 'fingerprint' : 'key'} size={15} />
                <span>Unlock with {m.label}</span>
              </button>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <span className="flex-1 h-px bg-[var(--line-soft)]" />
              <span className="text-[10px] uppercase tracking-wider text-[var(--ink-40)]">
                or password
              </span>
              <span className="flex-1 h-px bg-[var(--line-soft)]" />
            </div>
          </div>
        )}
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder="Master password"
          className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-sm"
        />
        {error && (
          <div className="mt-3 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 rounded p-2">
            {error}
          </div>
        )}
        <button
          onClick={() => void submit()}
          disabled={busy || !password}
          className={`mt-4 w-full justify-center ${ready.length > 0 ? 'btn-ghost' : 'btn-primary'}`}
        >
          <Icon name="lock_open" size={14} />
          <span>{busy ? 'Unlocking…' : 'Unlock'}</span>
        </button>
      </div>
    </div>
  )
}

// ── Unlocked vault — list + add + reveal ─────────────────────────────────────

function UnlockedVault(): JSX.Element {
  const entries = useVaultStore((s) => s.entries)
  const removeEntry = useVaultStore((s) => s.removeEntry)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')

  const q = search.trim().toLowerCase()
  const filtered = q
    ? entries.filter((e) => {
        const hay = `${e.title} ${e.url ?? ''} ${e.username ?? ''}`.toLowerCase()
        return hay.includes(q)
      })
    : entries

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <Icon
            name="search"
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-40)]"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search entries…"
            className="fb-field w-full bg-white/80 dark:bg-stone-900/80 pl-7 pr-3 py-1.5 text-sm"
          />
        </div>
        <button onClick={() => setAdding(true)} className="btn-primary shrink-0">
          <Icon name="add" size={14} />
          <span>Add</span>
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--edge-firm)] p-8 text-center">
          <Icon
            name="enhanced_encryption"
            size={28}
            className="text-[var(--ink-40)] mx-auto mb-2"
          />
          <p className="text-sm text-[var(--ink-70)] mb-3">
            Your vault is empty. Add your first credential to start.
          </p>
          <button onClick={() => setAdding(true)} className="btn-primary mx-auto">
            <Icon name="add" size={14} />
            <span>Add an entry</span>
          </button>
        </div>
      ) : (
        <div className="fb-card overflow-hidden">
          <ul className="divide-y divide-[var(--edge-soft)]">
            {filtered.map((e) => (
              <EntryRow key={e.id} entry={e} onRemove={() => void removeEntry(e.id)} />
            ))}
          </ul>
        </div>
      )}

      {adding && <AddEntryDialog onClose={() => setAdding(false)} />}
    </>
  )
}

function copyAndClear(text: string, ms = 30_000): void {
  void navigator.clipboard?.writeText(text)
  // Clear clipboard after `ms` to limit accidental paste exposure
  setTimeout(() => {
    navigator.clipboard?.writeText('').catch(() => {})
  }, ms)
}

function EntryRow({
  entry,
  onRemove
}: {
  entry: VaultEntryStored
  onRemove: () => void
}): JSX.Element {
  const reveal = useVaultStore((s) => s.reveal)
  const [secret, setSecret] = useState<VaultSecret | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [totpCode, setTotpCode] = useState<{
    code: string
    remainingSec: number
  } | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)

  async function loadSecret(): Promise<VaultSecret | null> {
    if (secret) return secret
    const s = await reveal(entry.id)
    if (s) setSecret(s)
    return s
  }

  async function toggleReveal(): Promise<void> {
    if (revealed) {
      setRevealed(false)
      return
    }
    await loadSecret()
    setRevealed(true)
  }

  async function copyPassword(): Promise<void> {
    const s = await loadSecret()
    if (!s?.password) return
    copyAndClear(s.password)
    setCopyHint('Password copied · clears in 30s')
    setTimeout(() => setCopyHint(null), 2500)
  }

  async function copyUsername(): Promise<void> {
    if (!entry.username) return
    copyAndClear(entry.username, 60_000)
    setCopyHint('Username copied')
    setTimeout(() => setCopyHint(null), 2000)
  }

  async function copyTotp(): Promise<void> {
    const s = await loadSecret()
    if (!s?.totp) return
    const result = await generateTotp(s.totp)
    if (!result) {
      setCopyHint('Invalid TOTP secret')
      setTimeout(() => setCopyHint(null), 2000)
      return
    }
    copyAndClear(result.code, 30_000)
    setCopyHint(`Code ${result.code} copied · ${result.remainingSec}s left`)
    setTimeout(() => setCopyHint(null), 3000)
  }

  // Auto-refresh TOTP code while revealed
  useEffect(() => {
    if (!revealed || !secret?.totp) {
      setTotpCode(null)
      return
    }
    let cancelled = false
    async function tick(): Promise<void> {
      const r = await generateTotp(secret!.totp!)
      if (!cancelled) setTotpCode(r)
    }
    void tick()
    const id = window.setInterval(tick, 1000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [revealed, secret])

  function hostnameOf(url: string | null): string {
    if (!url) return ''
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }

  return (
    <li className="px-4 py-3 hover:bg-[var(--surface-sunken)] transition-colors">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-md bg-[var(--surface-sunken)] inline-flex items-center justify-center shrink-0">
          <Icon name="key" size={16} className="text-[var(--ink-50)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[var(--ink-100)] truncate">
            {entry.title}
          </div>
          <div className="text-[11px] text-[var(--ink-50)] truncate">
            {entry.username || hostnameOf(entry.url) || '—'}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {entry.username && (
            <button
              onClick={() => void copyUsername()}
              className="icon-btn"
              title="Copy username"
            >
              <Icon name="person" size={13} />
            </button>
          )}
          <button
            onClick={() => void copyPassword()}
            className="icon-btn"
            title="Copy password (clears clipboard in 30s)"
          >
            <Icon name="content_copy" size={13} />
          </button>
          <button
            onClick={() => void copyTotp()}
            className="icon-btn"
            title="Copy current TOTP code"
          >
            <Icon name="pin" size={13} />
          </button>
          <button
            onClick={() => void toggleReveal()}
            className={`icon-btn ${revealed ? '!text-accent' : ''}`}
            title={revealed ? 'Hide' : 'Reveal'}
          >
            <Icon name={revealed ? 'visibility_off' : 'visibility'} size={13} />
          </button>
          <button
            onClick={() => {
              // No undo here on purpose: reversing would keep the decrypted
              // secret alive inside an undo closure. Confirm, honestly worded.
              void confirmDialog({
                title: `Delete "${entry.title}"?`,
                body: 'PlexiiVault entries are gone for good once deleted. This cannot be undone.',
                confirmLabel: 'Delete forever',
                danger: true
              }).then((ok) => {
                if (ok) onRemove()
              })
            }}
            className="icon-btn hover:!text-red-700"
            title="Delete"
          >
            <Icon name="delete" size={13} />
          </button>
        </div>
      </div>
      {revealed && secret && (
        <div className="mt-2 pl-12 space-y-1 text-xs">
          {entry.username && (
            <Field label="username" value={entry.username} mono />
          )}
          {secret.password && <Field label="password" value={secret.password} mono mask />}
          {secret.totp && totpCode && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-[var(--ink-50)] w-20 shrink-0">
                totp
              </span>
              <span className="font-mono text-base tabular-nums text-accent">
                {totpCode.code.slice(0, 3)} {totpCode.code.slice(3)}
              </span>
              <div className="flex-1 h-1 rounded-full bg-[var(--surface-sunken)] overflow-hidden max-w-[100px]">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${(totpCode.remainingSec / 30) * 100}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-[var(--ink-50)]">
                {totpCode.remainingSec}s
              </span>
            </div>
          )}
          {secret.notes && (
            <Field label="notes" value={secret.notes} />
          )}
          {entry.url && <Field label="url" value={entry.url} mono />}
        </div>
      )}
      {copyHint && (
        <div className="mt-1 pl-12 text-[10px] text-emerald-700 dark:text-emerald-400">
          {copyHint}
        </div>
      )}
    </li>
  )
}

function Field({
  label,
  value,
  mono,
  mask
}: {
  label: string
  value: string
  mono?: boolean
  mask?: boolean
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wider text-[var(--ink-50)] w-20 shrink-0">
        {label}
      </span>
      <span
        className={`text-[var(--ink-90)] truncate ${mono ? 'font-mono' : ''}`}
        style={mask ? { letterSpacing: '0.04em' } : undefined}
      >
        {value}
      </span>
    </div>
  )
}

// ── Change master password dialog ────────────────────────────────────────────

function ChangeMasterPasswordDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const changeMasterPassword = useVaultStore((s) => s.changeMasterPassword)
  const entryCount = useVaultStore((s) => s.entries.length)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(): Promise<void> {
    if (busy) return
    setError(null)
    if (!current) {
      setError('Enter your current master password.')
      return
    }
    if (next.length < 8) {
      setError('New master password must be at least 8 characters.')
      return
    }
    if (next !== confirm) {
      setError('New passwords don\'t match.')
      return
    }
    if (next === current) {
      setError('The new password is the same as the current one.')
      return
    }
    setBusy(true)
    try {
      const r = await changeMasterPassword(current, next)
      if (!r.ok) {
        setError(r.error)
        return
      }
      chimeIn()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fb-scrim fixed inset-0 z-[180] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="fb-card fb-press w-full max-w-md mx-4 overflow-hidden flex flex-col"
      >
        <div className="px-5 py-4 border-b border-[var(--edge-soft)] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="password" size={18} className="text-accent" />
            <h3 className="text-base font-semibold text-[var(--ink-100)]">
              Change master password
            </h3>
          </div>
          <button onClick={onClose} className="icon-btn">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-[12px] text-[var(--ink-50)] leading-relaxed">
            This re-encrypts {entryCount === 1 ? 'your 1 entry' : `all ${entryCount} entries`} under
            a new key. There is no recovery if you forget the new password.
          </p>
          <PasswordInput label="Current password" value={current} onChange={setCurrent} autoFocus />
          <PasswordInput label="New password" value={next} onChange={setNext} placeholder="At least 8 characters" />
          <PasswordInput label="Confirm new password" value={confirm} onChange={setConfirm} onEnter={submit} />
          {error && (
            <div className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 rounded p-2">
              {error}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !current || !next || !confirm}
            className="btn-primary"
          >
            <Icon name="password" size={14} />
            <span>{busy ? 'Re-encrypting…' : 'Change password'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function PasswordInput({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  onEnter
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  onEnter?: () => void
}): JSX.Element {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider text-[var(--ink-50)] font-medium mb-1.5">
        {label}
      </label>
      <input
        type="password"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) void onEnter()
        }}
        placeholder={placeholder}
        className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-sm"
      />
    </div>
  )
}

// ── Add entry dialog ─────────────────────────────────────────────────────────

function AddEntryDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const addEntry = useVaultStore((s) => s.addEntry)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(): Promise<void> {
    if (busy) return
    setError(null)
    if (!title.trim()) {
      setError('A title is required.')
      return
    }
    if (totp.trim() && !looksLikeTotpSecret(totp.trim())) {
      setError(
        'TOTP secret should be base32 (A-Z, 2-7), 16+ characters. Paste from your authenticator setup.'
      )
      return
    }
    setBusy(true)
    try {
      await addEntry({
        title: title.trim(),
        url: url.trim() || undefined,
        username: username.trim() || undefined,
        secret: {
          password: password || undefined,
          totp: totp.replace(/\s+/g, '').toUpperCase() || undefined,
          notes: notes.trim() || undefined
        }
      })
      chimeIn()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fb-scrim fixed inset-0 z-[180] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="fb-card fb-press w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="px-5 py-4 border-b border-[var(--edge-soft)] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="key" size={18} className="text-accent" />
            <h3 className="text-base font-semibold text-[var(--ink-100)]">
              New entry
            </h3>
          </div>
          <button onClick={onClose} className="icon-btn">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <Input label="Title" value={title} onChange={setTitle} autoFocus />
          <Input label="URL (optional)" value={url} onChange={setUrl} placeholder="https://…" />
          <Input label="Username / email" value={username} onChange={setUsername} />
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-[var(--ink-50)] font-medium mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 pr-9 text-sm"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-1 top-1/2 -translate-y-1/2 icon-btn"
              >
                <Icon name={showPw ? 'visibility_off' : 'visibility'} size={13} />
              </button>
            </div>
          </div>
          <Input
            label="TOTP secret (optional)"
            value={totp}
            onChange={setTotp}
            placeholder="JBSW Y3DP EHPK 3PXP (base32)"
            mono
          />
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-[var(--ink-50)] font-medium mb-1.5">
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-sm resize-none"
            />
          </div>
          {error && (
            <div className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 rounded p-2">
              {error}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !title.trim()}
            className="btn-primary"
          >
            <Icon name="lock" size={14} />
            <span>{busy ? 'Encrypting…' : 'Save'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  mono
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  mono?: boolean
}): JSX.Element {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider text-[var(--ink-50)] font-medium mb-1.5">
        {label}
      </label>
      <input
        type="text"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-sm ${
          mono ? 'font-mono text-xs' : ''
        }`}
      />
    </div>
  )
}
