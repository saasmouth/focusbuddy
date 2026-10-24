import type { CtxMenuItem } from '../components/CanvasContextMenu'
import { MENU, removeFromLabel } from '@shared/menus/lexicon'
import { objectMenu } from './objectMenu'
import { leadRows, lifecycleRows } from './deskLifecycleMenu'

// Right-click on a Home (or Office / People / PlexiiBrain) dashboard card
// (SPEC §9.3). Silent until now (AUDIT §1.3). Built only from what a card can
// already do: open what it shows (the same route its own Open button or the
// side menu takes), choose another target (its own "Choose another" / config
// picker), change size (customize mode's size control), ask PlexiiAssist about
// the desk or room it shows, and take it off the dashboard (customize mode's
// remove). A right-click inside an embedded work widget keeps that widget's
// own menu; the dashboard only answers where nothing else did.

export interface HomeCardMenuInput {
  open?: () => void
  chooseAnother?: () => void
  sizes?: { options: Array<{ size: string; label: string }>; current: string; set: (size: string) => void }
  askAssist?: () => void
  remove: () => void
  /** "Remove from Home", or "Remove from this dashboard" on the other dashboards. */
  removeLabel: string
}

export function removeFromDashboardLabel(surface: string): string {
  return removeFromLabel(surface === 'home' ? 'home' : 'dashboard')
}

export function homeCardMenuItems(m: HomeCardMenuInput): CtxMenuItem[] {
  const id = (k: string): string => `home-card-menu-${k}`
  // Open leads (E-1). A card is a placement, not an object of its own, so it
  // has no Add to Focus…; the desk it shows has that on its own menu.
  const object: CtxMenuItem[] = leadRows(
    m.open ? { label: MENU.open.label, icon: 'open_in_new', testid: id('open'), onClick: m.open } : null,
    null
  )
  if (m.chooseAnother) object.push({ label: 'Choose another…', icon: 'swap_horiz', testid: id('choose'), onClick: m.chooseAnother })
  if (m.sizes && m.sizes.options.length > 1) {
    const sizes = m.sizes
    object.push({
      label: 'Size',
      icon: 'aspect_ratio',
      testid: id('size'),
      children: sizes.options.map((o) => ({
        label: o.label,
        checked: o.size === sizes.current,
        testid: id(`size-${o.size}`),
        onClick: () => sizes.set(o.size)
      }))
    })
  }
  return objectMenu({
    object,
    plexii: m.askAssist ? [{ label: MENU.askAssist.label, icon: 'auto_awesome', testid: id('ask'), onClick: m.askAssist }] : [],
    destructive: lifecycleRows({ remove: { label: m.removeLabel, icon: 'close', testid: id('remove'), onClick: m.remove } })
  })
}
