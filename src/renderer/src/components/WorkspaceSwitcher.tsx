import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import { useOrgStore } from '../stores/org'
import { useViewStore } from '../stores/view'
import { useAccountStore } from '../stores/account'

// The organisation switcher.
//
// It briefly owned the areas too (c581655d folded a four-tile SegmentSwitcher
// into it, on the reasoning that an area lives INSIDE an organisation so the
// two were not peers). That reasoning holds for the data model and did not hold
// for the hands: an area is somewhere you go a dozen times an hour and a
// workspace is something you switch rarely, so putting the frequent action
// behind a dropdown that opens the rare one cost a click every time. The areas
// are tabs again, always visible, in every area's menu — see
// segment/SegmentSwitcher.tsx. This control answers one question: which
// organisation.
export default function WorkspaceSwitcher(): JSX.Element {
  const orgs = useOrgStore((s) => s.orgs)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const load = useOrgStore((s) => s.load)
  const setActiveOrg = useOrgStore((s) => s.setActive)
  const token = useAccountStore((s) => s.sessionToken)

  const goOrg = useViewStore((s) => s.goOrg)


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
  return (
    <div className="relative px-2 pt-2 pb-1" ref={ref} data-testid="workspace-switcher">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="workspace-switcher-trigger"
        title={`${orgName} — switch workspace`}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] hover:border-[rgb(var(--accent)/0.45)] transition-colors"
      >
        <Icon name="apartment" size={15} className="text-accent shrink-0" />
        <span className="flex-1 min-w-0 text-left truncate text-[12px] font-medium text-[var(--ink-90)]">
          {orgName}
        </span>
        <Icon name={open ? 'expand_less' : 'expand_more'} size={15} className="text-[var(--ink-40)] shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Workspace"
          data-testid="workspace-switcher-menu"
          className="absolute left-2 right-2 top-full mt-1 z-40 rounded-[var(--radius-card)] border border-[var(--edge-firm)] bg-[var(--surface-raised)] p-1.5"
          style={{ boxShadow: 'var(--shadow-cast)' }}
        >
          <div className="min-w-0">
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

        </div>
      )}
    </div>
  )
}
