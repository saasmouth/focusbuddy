import { useEffect, useState } from 'react'
import { useViewStore } from '../stores/view'
import Tooltip from './Tooltip'
import Icon from './Icon'

// The top-bar Attention count (S6, SPEC-015). Counts ONLY — state, not
// substance: the number of non-terminal work items needing the person,
// derived from work_item_state exclusively and excluding system-origin items
// (DEC-016). Renders nothing while the capability is off or the count is
// zero — restraint by design. Refreshes on a quiet interval plus whenever a
// work-item mutation announces itself.

export default function AttentionBadge(): JSX.Element | null {
  const goAttention = useViewStore((s) => s.goAttention)
  const [enabled, setEnabled] = useState(false)
  const [headline, setHeadline] = useState(0)

  useEffect(() => {
    let alive = true
    async function load(): Promise<void> {
      try {
        const on = await window.api.workItems.enabled()
        if (!alive) return
        setEnabled(on)
        if (on) {
          const counts = await window.api.workItems.badgeCounts()
          if (alive) setHeadline(counts.headline)
        }
      } catch {
        /* early boot — next tick catches up */
      }
    }
    void load()
    const t = setInterval(() => void load(), 60_000)
    const onChanged = (): void => void load()
    window.addEventListener('fb:workitems-changed', onChanged)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('fb:workitems-changed', onChanged)
    }
  }, [])

  if (!enabled || headline === 0) return null
  return (
    <Tooltip content="Attention — what needs you" placement="bottom">
      <button
        onClick={() => goAttention()}
        className="icon-btn relative"
        aria-label={`Attention: ${headline} item${headline === 1 ? '' : 's'} need you`}
      >
        <Icon name="notifications" size={16} />
        <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-[var(--accent)] text-white text-[9px] leading-[15px] text-center fb-tabular">
          {headline > 99 ? '99+' : headline}
        </span>
      </button>
    </Tooltip>
  )
}
