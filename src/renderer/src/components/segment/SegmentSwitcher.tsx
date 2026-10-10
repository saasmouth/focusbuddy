import { useViewStore } from '../../stores/view'
import { useCapabilityStore } from '../../stores/capabilities'
import { useOrgStore } from '../../stores/org'
import { computeEntitlement } from '../../lib/entitlementReason'
import Icon from '../Icon'

// A small always-visible switch between the four areas, shown at the top of every
// area's menu. Each area still shows only its own apps (the simple, contextual
// menu), but you can always jump to another area in one click.
//
// Each area is an entitlement (product_desk/office/brain/people). When the
// active org (or the user) is not entitled to an app, the area is not hidden but
// shown GREYED with a tooltip that explains why and, when it is a licensing gap
// rather than an admin restriction, offers an upgrade. Desk is the floor and is
// always available.
const AREAS = [
  { kind: 'plexidesk', label: 'Desk', icon: 'plexii:desks', cap: 'product_desk' },
  { kind: 'office', label: 'Office', icon: 'plexii:office', cap: 'product_office' },
  { kind: 'plexipeople', label: 'People', icon: 'diversity_3', cap: 'product_people' },
  { kind: 'plexibrain', label: 'Brain', icon: 'neurology', cap: 'product_brain' }
] as const

export default function SegmentSwitcher(): JSX.Element {
  const currentKind = useViewStore((s) => s.view.kind)
  const goHome = useViewStore((s) => s.goHome)
  const goOffice = useViewStore((s) => s.goOffice)
  const goPlexiPeople = useViewStore((s) => s.goPlexiPeople)
  const goPlexiBrain = useViewStore((s) => s.goPlexiBrain)
  // Subscribe to the capability + source MAPS (not s.get, a stable function
  // reference that never re-renders) so the switcher reacts when entitlements
  // resolve or change while the app is running, e.g. after an org switch.
  const capabilities = useCapabilityStore((s) => s.capabilities)
  const sources = useCapabilityStore((s) => s.sources)
  const orgRole = useCapabilityStore((s) => s.orgRole)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const orgName = useOrgStore((s) => s.orgs.find((o) => o.id === s.activeOrgId)?.name ?? null)

  // Shared inputs for the reason-aware entitlement helper. Read the maps once
  // here (subscribed above) and resolve each area with the pure core so we never
  // call a hook inside the render loop.
  const entInputs = { capabilities, sources, orgRole, activeOrgId, orgName }

  function go(kind: string): void {
    if (kind === 'plexidesk') goHome()
    else if (kind === 'office') goOffice()
    else if (kind === 'plexipeople') goPlexiPeople()
    else if (kind === 'plexibrain') goPlexiBrain()
  }

  return (
    <div className="grid grid-cols-4 gap-1 px-2 pt-2 pb-1" data-testid="segment-switcher">
      {AREAS.map((a) => {
        const ent = computeEntitlement(entInputs, a.cap, a.label)
        // Desk is the floor: always available even if its entitlement is unset.
        const enabled = a.kind === 'plexidesk' || ent.enabled
        const active =
          a.kind === 'plexidesk'
            ? !['office', 'plexipeople', 'plexibrain'].includes(currentKind)
            : currentKind === a.kind
        if (!enabled) {
          return (
            <button
              key={a.kind}
              onClick={ent.onLockedClick}
              data-testid={`switch-${a.kind}`}
              data-locked="true"
              aria-disabled="true"
              title={ent.reason}
              className="relative flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-[10px] text-[var(--ink-40)] opacity-50 cursor-not-allowed"
            >
              <Icon name={a.icon} size={18} />
              <span>{a.label}</span>
              <Icon name="lock" size={9} className="absolute top-1 right-1.5 text-[var(--ink-40)]" />
            </button>
          )
        }
        return (
          <button
            key={a.kind}
            onClick={() => go(a.kind)}
            data-testid={`switch-${a.kind}`}
            title={a.label}
            className={`flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-[10px] ${
              active
                ? 'bg-[rgb(var(--accent)/0.14)] text-[rgb(var(--accent))] font-medium'
                : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            <Icon name={a.icon} size={18} />
            <span>{a.label}</span>
          </button>
        )
      })}
    </div>
  )
}
