import Icon from './Icon'
import type { HealthState } from '../stores/contextHealth'

// A Context Health badge (plexi-4.0). States are distinguishable WITHOUT relying
// on colour — each carries an icon and a text label as well as a tone
// (PLX-A11Y-004). `current` renders nothing by default; a calm desk needs no
// indicator emphasis (spec §20.3).

const PRESENTATION: Record<
  Exclude<HealthState, 'current'>,
  { label: string; icon: string; text: string; bg: string; dot: string }
> = {
  changed: {
    label: 'Changed',
    icon: 'fiber_manual_record',
    text: 'text-sky-600 dark:text-sky-400',
    bg: 'bg-sky-500/10',
    dot: 'bg-sky-500'
  },
  'attention-required': {
    label: 'Needs attention',
    icon: 'priority_high',
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-500/10',
    dot: 'bg-amber-500'
  },
  'decision-risk': {
    label: 'Decision risk',
    icon: 'gpp_maybe',
    text: 'text-rose-600 dark:text-rose-400',
    bg: 'bg-rose-500/10',
    dot: 'bg-rose-500'
  }
}

interface Props {
  state: HealthState
  count?: number
  title?: string
  showCurrent?: boolean
}

export default function ContextHealthBadge({ state, count, title, showCurrent = false }: Props): JSX.Element | null {
  if (state === 'current') {
    if (!showCurrent) return null
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        title={title ?? 'Up to date'}
      >
        <Icon name="check_circle" size={13} />
        Current
      </span>
    )
  }
  const p = PRESENTATION[state]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${p.bg} ${p.text}`}
      title={title ?? p.label}
      role="status"
    >
      <Icon name={p.icon} size={13} filled />
      {p.label}
      {typeof count === 'number' && count > 0 && (
        <span className={`ml-0.5 inline-flex min-w-[15px] justify-center rounded-full px-1 text-[10px] leading-4 text-white ${p.dot}`}>
          {count}
        </span>
      )}
    </span>
  )
}
