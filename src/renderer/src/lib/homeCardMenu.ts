import type { CtxMenuItem } from '../components/CanvasContextMenu'
import { MENU } from '@shared/menus/lexicon'
import { objectMenu } from './objectMenu'

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

// TODO(§9 lexicon): move to removeFromLabel('home' | 'dashboard') in src/shared/menus/lexicon.ts.
export function removeFromDashboardLabel(surface: string): string {
  return surface === 'home' ? 'Remove from Home' : 'Remove from this dashboard'
}

export function homeCardMenuItems(m: HomeCardMenuInput): CtxMenuItem[] {
  const id = (k: string): string => `home-card-menu-${k}`
  const object: CtxMenuItem[] = []
  if (m.open) object.push({ label: MENU.open.label, icon: 'open_in_new', testid: id('open'), onClick: m.open })
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
    destructive: [{ label: m.removeLabel, icon: 'close', testid: id('remove'), onClick: m.remove }]
  })
}
