import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import { useOrgStore } from '../stores/org'
import { useViewStore } from '../stores/view'
import { useAccountStore } from '../stores/account'
import { useCapabilityStore } from '../stores/capabilities'
import { computeEntitlement } from '../lib/entitlementReason'

// One control where there were two.
//
// The top of every area menu carried an OrgSwitcher and, under it, a
// SegmentSwitcher: a row of four area tiles. Two separate controls, stacked,
// both of them "where am I?" — and they are not siblings. An area lives INSIDE
// an organisation: switching org re-scopes which areas you are even entitled
// to, and switching area does nothing to the org. Presenting them as two peers
// hid that, and cost two rows of menu to do it.
//
// So: one trigger reading "<workspace> › <area>", opening one menu with the
// workspace on the left and the areas on the right. Picking a workspace
// re-scopes the right-hand column; picking an area navigates.
//
// WHY THE AREAS ALWAYS BELONG TO THE ACTIVE ORG. Entitlements are resolved from
// the capability store, which holds the ACTIVE organisation's grants. There is
// no way to know what another org entitles without switching to it. Rather than
// grey the right column on a guess — or worse, show everything as available and
// drop someone into a locked wall — choosing a workspace switches first, the
// capability store resolves, and the areas then show the truth. That is also
// why this is one menu rather than a hover-cascade: a hover cannot commit the
// switch that makes the second column honest.

const AREAS = [
  { kind: 'plexidesk', label: 'Desk', icon: 'plexii:desks', cap: 'product_desk' },
  { kind: 'office', label: 'Office', icon: 'plexii:office', cap: 'product_office' },
  { kind: 'plexipeople', label: 'People', icon: 'diversity_3', cap: 'product_people' },
  { kind: 'plexibrain', label: 'Brain', icon: 'neurology', cap: 'product_brain' }
] as const

export default function WorkspaceSwitcher(): JSX.Element {
  const orgs = useOrgStore((s) => s.orgs)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const load = useOrgStore((s) => s.load)
  const setActiveOrg = useOrgStore((s) => s.setActive)
  const token = useAccountStore((s) => s.sessionToken)

  const currentKind = useViewStore((s) => s.view.kind)
  const goHome = useViewStore((s) => s.goHome)
  const goOffice = useViewStore((s) => s.goOffice)
  const goPlexiPeople = useViewStore((s) => s.goPlexiPeople)
  const goPlexiBrain = useViewStore((s) => s.goPlexiBrain)
  const goOrg = useViewStore((s) => s.goOrg)

  const capabilities = useCapabilityStore((s) => s.capabilities)
  const sources = useCapabilityStore((s) => s.sources)
  const orgRole = useCapabilityStore((s) => s.orgRole)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void load()
  }, [load, token])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? orgs[0]
  const orgName = activeOrg?.name ?? 'Personal'
  const entInputs = { capabilities, sources, orgRole, activeOrgId, orgName }

  const activeArea =
    AREAS.find((a) =>
      a.kind === 'plexidesk'
        ? !['office', 'plexipeople', 'plexibrain'].includes(currentKind)
        : currentKind === a.kind
    ) ?? AREAS[0]

  function go(kind: string): void {
    if (kind === 'plexidesk') goHome()
    else if (kind === 'office') goOffice()
    else if (kind === 'plexipeople') goPlexiPeople()
    else if (kind === 'plexibrain') goPlexiBrain()
    setOpen(false)
  }

  return (
    <div className="relative px-2 pt-2 pb-1" ref={ref} data-testid="workspace-switcher">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="workspace-switcher-trigger"
        title={`${orgName} › ${activeArea.label} — switch workspace or area`}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] hover:border-[rgb(var(--accent)/0.45)] transition-colors"
      >
        <Icon name={activeArea.icon} size={15} className="text-accent shrink-0" />
        <span className="flex-1 min-w-0 text-left truncate text-[12px] text-[var(--ink-90)]">
          <span className="text-[var(--ink-60)]">{orgName}</span>
          <span className="text-[var(--ink-30)]"> › </span>
          <span className="font-medium">{activeArea.label}</span>
        </span>
        <Icon name={open ? 'expand_less' : 'expand_more'} size={15} className="text-[var(--ink-40)] shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Workspace and area"
          data-testid="workspace-switcher-menu"
          className="absolute left-2 right-2 top-full mt-1 z-40 rounded-[var(--radius-card)] border border-[var(--edge-firm)] bg-[var(--surface-raised)] p-1.5 flex gap-1.5"
          style={{ boxShadow: 'var(--shadow-cast)' }}
        >
          {/* Left: the workspace. The container. */}
          <div className="flex-1 min-w-0">
            <div className="px-1.5 pb-1 fb-t-caption uppercase tracking-[0.06em] text-[var(--ink-40)] select-none">
              Workspace
            </div>
            {orgs.map((o) => (
              <button
                key={o.id}
                role="menuitem"
                type="button"
                onClick={() => void setActiveOrg(o.id)}
                aria-current={o.id === activeOrgId ? 'true' : undefined}
                data-testid={`workspace-org-${o.id}`}
                className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded-[var(--radius-chip)] text-[11.5px] ${
                  o.id === activeOrgId
                    ? 'bg-[rgb(var(--accent)/0.12)] text-[var(--ink-100)]'
                    : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <Icon name="apartment" size={13} className="text-[var(--ink-50)] shrink-0" />
                <span className="flex-1 min-w-0 truncate text-left">{o.name}</span>
                {o.id === activeOrgId && <Icon name="check" size={12} className="text-accent shrink-0" />}
              </button>
            ))}
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                goOrg()
                setOpen(false)
              }}
              data-testid="workspace-manage-org"
              className="w-full flex items-center gap-1.5 px-1.5 py-1 mt-0.5 rounded-[var(--radius-chip)] text-[11px] text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]"
            >
              <Icon name="settings" size={12} className="shrink-0" />
              <span className="flex-1 text-left">Manage organisation</span>
            </button>
          </div>

          <div aria-hidden className="w-px bg-[var(--edge-soft)] shrink-0" />

          {/* Right: the areas within it. */}
          <div className="flex-1 min-w-0">
            <div className="px-1.5 pb-1 fb-t-caption uppercase tracking-[0.06em] text-[var(--ink-40)] select-none">
              Area in {orgName}
            </div>
            {AREAS.map((a) => {
              const ent = computeEntitlement(entInputs, a.cap, a.label)
              // Desk is the floor: always available even with its entitlement unset.
              const enabled = a.kind === 'plexidesk' || ent.enabled
              const isActive = a.kind === activeArea.kind
              if (!enabled) {
                return (
                  <button
                    key={a.kind}
                    role="menuitem"
                    type="button"
                    onClick={ent.onLockedClick}
                    data-testid={`switch-${a.kind}`}
                    data-locked="true"
                    aria-disabled="true"
                    title={ent.reason}
                    className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-[var(--radius-chip)] text-[11.5px] text-[var(--ink-40)] opacity-60"
                  >
                    <Icon name={a.icon} size={13} className="shrink-0" />
                    <span className="flex-1 min-w-0 truncate text-left">{a.label}</span>
                    <Icon name="lock" size={11} className="shrink-0" />
                  </button>
                )
              }
              return (
                <button
                  key={a.kind}
                  role="menuitem"
                  type="button"
                  onClick={() => go(a.kind)}
                  data-testid={`switch-${a.kind}`}
                  aria-current={isActive ? 'true' : undefined}
                  className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded-[var(--radius-chip)] text-[11.5px] ${
                    isActive
                      ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))] font-medium'
                      : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
                  }`}
                >
                  <Icon name={a.icon} size={13} className="shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-left">{a.label}</span>
                  {isActive && <Icon name="check" size={12} className="text-accent shrink-0" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
