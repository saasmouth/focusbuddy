import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import Tooltip from './Tooltip'
import { usePresenceStore, type PresenceStatus } from '../stores/presence'
import { useAccountStore } from '../stores/account'
import { useCapabilityEnabled } from '../stores/capabilities'
import { personDisplayName, personInitials } from '../lib/personName'

// Header entry point for account-level presence (the "People Map"): who across
// your org/team is online right now and what they're doing. Reads only real
// server presence — when nobody else is online it shows an honest empty team,
// never sample people.

const STATUS_META: Record<PresenceStatus, { label: string; dot: string; text: string }> = {
  online: { label: 'Online', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  away: { label: 'Away', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  focus: { label: 'In focus', dot: 'bg-violet-500', text: 'text-violet-600 dark:text-violet-400' },
  busy: { label: 'Busy', dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' },
  offline: { label: 'Offline', dot: 'bg-stone-400', text: 'text-[var(--ink-50)]' }
}

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444']
function colorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

// `handle` seeds the colour (stable per person); `name` is the shown identity we
// take initials from, falling back to the handle when there is no real name.
function Avatar({ handle, name }: { handle: string; name?: string }): JSX.Element {
  return (
    <span
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white ring-1 ring-black/10"
      style={{ backgroundColor: colorFor(handle) }}
    >
      {personInitials({ name: name ?? handle })}
    </span>
  )
}

export default function TeamPresenceButton(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const peers = usePresenceStore((s) => s.peers)
  const myStatus = usePresenceStore((s) => s.myStatus)
  const setStatus = usePresenceStore((s) => s.setStatus)
  const myInvisible = usePresenceStore((s) => s.myInvisible)
  const setInvisible = usePresenceStore((s) => s.setInvisible)
  const account = useAccountStore((s) => s.account)
  // Live presence is a Team-tier capability. Free/Pro never see the who-is-online
  // header entry (and the server refuses their presence join), so this renders
  // nothing for them rather than an empty team.
  const presenceEnabled = useCapabilityEnabled('presence')

  const list = Object.values(peers).sort((a, b) => {
    // Online-ish first by status weight, then by handle.
    const w = (s: PresenceStatus) => (s === 'offline' ? 3 : s === 'away' ? 1 : s === 'busy' ? 2 : 0)
    return w(a.status) - w(b.status) || personDisplayName(a, a.handle).localeCompare(personDisplayName(b, b.handle))
  })
  const onlineCount = list.length

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    // Arm the outside-click a tick late so the same click that opened the panel
    // does not immediately close it (the panel is portaled, so it is no longer a
    // DOM descendant of the button). Matches the HabitGarden popover pattern.
    const armId = window.setTimeout(() => window.addEventListener('mousedown', onDown), 50)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(armId)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const myHandle = personDisplayName(account, account?.email || 'You')

  if (!presenceEnabled) return null

  return (
    <div className="relative">
      <Tooltip content="Team — who's online right now" placement="bottom">
        <button
          ref={btnRef}
          onClick={() => setOpen((v) => !v)}
          className={`icon-btn relative ${open ? '!text-accent' : ''}`}
          aria-label="Team presence"
        >
          <Icon name="group" size={16} filled={open} />
          {onlineCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 inline-flex items-center justify-center rounded-full bg-emerald-500 text-white text-[9px] font-semibold leading-none">
              {onlineCount}
            </span>
          )}
        </button>
      </Tooltip>

      {open &&
        createPortal(
          <div
            ref={popRef}
            // Portaled to the body so it escapes the header's backdrop-filter
            // stacking context (which otherwise paints it behind the page).
            // Positioned under the trigger via its on-screen rect.
            style={(() => {
              const r = btnRef.current?.getBoundingClientRect()
              return r
                ? { top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) }
                : { top: 48, right: 8 }
            })()}
            className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in fixed z-[200] w-72 overflow-hidden"
          >
          <div className="px-3 py-2.5 border-b border-[var(--edge-soft)]">
            <div className="flex items-center justify-between">
              <h3 className="text-[12px] font-semibold uppercase tracking-tight text-[var(--ink-70)]">
                Team
              </h3>
              <span className="text-[11px] text-[var(--ink-50)]">
                {onlineCount === 0 ? 'No one else online' : `${onlineCount} online`}
              </span>
            </div>
          </div>

          {/* Your own status, with quick toggles for do-not-disturb and appear-offline. */}
          <div className="px-3 py-2.5 flex items-center gap-2.5 border-b border-[var(--edge-soft)] dark:border-white/[0.06]">
            <span className="relative">
              <Avatar handle={myHandle} />
              {myInvisible && (
                <span
                  className="absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full bg-stone-400 dark:bg-stone-500 ring-2 ring-white dark:ring-stone-900 inline-flex items-center justify-center"
                  title="Appearing offline"
                >
                  <Icon name="visibility_off" size={8} className="text-white" />
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-[var(--ink-100)] truncate">{myHandle}</div>
              {myInvisible ? (
                <div className="text-[11px] flex items-center gap-1.5 text-[var(--ink-50)]" data-testid="presence-self-invisible">
                  <Icon name="visibility_off" size={11} />
                  Appearing offline to others
                </div>
              ) : (
                <div className={`text-[11px] flex items-center gap-1.5 ${STATUS_META[myStatus].text}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${STATUS_META[myStatus].dot}`} />
                  You · {STATUS_META[myStatus].label}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setStatus(myStatus === 'busy' ? 'online' : 'busy')}
                disabled={myInvisible}
                className="fb-btn-surface text-[10.5px] px-2 py-1 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] dark:hover:bg-white/[0.06] disabled:opacity-40"
                title="Toggle do-not-disturb"
              >
                {myStatus === 'busy' ? 'Available' : 'Busy'}
              </button>
              <button
                onClick={() => setInvisible(!myInvisible)}
                data-testid="presence-appear-offline"
                className={`text-[10.5px] px-2 py-1 rounded-md border inline-flex items-center gap-1 ${
                  myInvisible
                    ? 'border-accent/40 text-accent hover:bg-accent/[0.06]'
                    : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] dark:hover:bg-white/[0.06]'
                }`}
                title={myInvisible ? 'Go back online to your team' : 'Hide yourself from the People Map and team presence'}
              >
                <Icon name={myInvisible ? 'visibility' : 'visibility_off'} size={12} />
                {myInvisible ? 'Go visible' : 'Appear offline'}
              </button>
            </div>
          </div>
          {/* Honest, plain framing so presence feels controlled, not done to you. */}
          <div className="px-3 py-1.5 text-[10.5px] text-[var(--ink-40)] border-b border-[var(--edge-soft)] dark:border-white/[0.06] leading-snug">
            {myInvisible
              ? 'Your team sees you as offline and you can still see everyone. No admin can override this, and appearing offline is never recorded. Actively using features still counts toward anonymous team totals, but never as a personal last-seen time.'
              : 'Your team can see you are online. Appear offline any time, it is your call and no admin can override it.'}
          </div>

          <div className="max-h-72 overflow-auto py-1">
            {list.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <Icon name="person_off" size={20} className="text-[var(--ink-30)]" />
                <p className="mt-1.5 text-[11.5px] text-[var(--ink-50)] leading-relaxed">
                  No teammates online right now. They'll appear here the moment they open PlexiiDesk.
                </p>
              </div>
            ) : (
              list.map((p) => {
                const meta = STATUS_META[p.status]
                return (
                  <div
                    key={p.accountId}
                    className="px-3 py-2 flex items-center gap-2.5 hover:bg-[var(--surface-sunken)] dark:hover:bg-white/[0.04]"
                  >
                    <span className="relative">
                      <Avatar handle={p.handle} name={personDisplayName(p, p.handle)} />
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-stone-900 ${meta.dot}`}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-medium text-[var(--ink-100)] truncate">
                        {personDisplayName(p, p.handle)}
                      </div>
                      <div className="text-[11px] text-[var(--ink-50)] truncate">
                        {p.workingOn ? p.workingOn : meta.label}
                      </div>
                    </div>
                    <span className={`text-[10.5px] ${meta.text}`}>{meta.label}</span>
                  </div>
                )
              })
            )}
          </div>
          </div>,
          document.body
        )}
    </div>
  )
}
