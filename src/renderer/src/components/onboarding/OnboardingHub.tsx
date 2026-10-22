import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOnboarding, ONBOARDING_MODULES } from '../../stores/onboarding'
import Icon from '../Icon'
import PlexiiIcon from '../PlexiiIcon'
import { tourModuleEntity } from '../../lib/plexiiIconMap'

// The tour hub: a small modal listing every onboarding module so a user can
// replay any of them at ANY time as a refresher, not just on first run. Opened
// by dispatching window event 'fb:onboarding-hub' (the command palette and the
// Settings help section do this). Shows which have been completed, and how long
// each takes, so picking one is a low-commitment decision.

export const OPEN_ONBOARDING_HUB_EVENT = 'fb:onboarding-hub'

function estLabel(seconds: number): string {
  if (seconds < 60) return `~${seconds} sec`
  return `~${Math.round(seconds / 60)} min`
}

export default function OnboardingHub(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const start = useOnboarding((s) => s.start)
  const completed = useOnboarding((s) => s.completed)

  useEffect(() => {
    const openHub = (): void => setOpen(true)
    window.addEventListener(OPEN_ONBOARDING_HUB_EVENT, openHub)
    return () => window.removeEventListener(OPEN_ONBOARDING_HUB_EVENT, openHub)
  }, [])

  if (!open) return null

  return createPortal(
    <div
      className="fb-scrim fixed inset-0 z-[245] flex items-center justify-center"
      onMouseDown={() => setOpen(false)}
      role="dialog"
      aria-label="Tours and onboarding"
    >
      {/* Onboarding stage: forced-dark card in every theme; hairlines are relative to the stage. */}
      <div
        className="w-[520px] max-w-[92vw] rounded-2xl bg-[rgba(16,24,39,0.97)] border border-white/10 shadow-2xl text-stone-100 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="onboarding-hub"
      >
        <div className="flex items-center gap-2 px-5 h-14 border-b border-white/10">
          <Icon name="explore" size={18} className="text-accent" />
          <span className="text-[15px] font-semibold">Tours &amp; onboarding</span>
          <span className="text-[12px] text-stone-400 ml-1">replay any time</span>
          <button onClick={() => setOpen(false)} className="ml-auto text-stone-400 hover:text-stone-200" aria-label="Close">
            <Icon name="close" size={17} />
          </button>
        </div>
        <div className="p-3 max-h-[60vh] overflow-auto">
          {ONBOARDING_MODULES.map((m) => {
            const done = (completed[m.id] ?? 0) >= m.version
            return (
              <button
                key={m.id}
                onClick={() => {
                  setOpen(false)
                  start(m.id)
                }}
                data-testid={`onboarding-hub-start-${m.id}`}
                className="w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-white/5 transition-colors"
              >
                {/* The module's own line icon from the owner's set, in the
                    dark-stage violet (the card is dark in every theme). */}
                <span className="plexii-on-dark h-10 w-10 rounded-xl bg-accent/15 text-accent inline-flex items-center justify-center shrink-0">
                  {(() => {
                    const ent = tourModuleEntity(m.id)
                    return ent ? <PlexiiIcon kind={ent.kind} id={ent.id} size={22} fallback={m.icon} /> : <Icon name={m.icon} size={20} />
                  })()}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium truncate">{m.title}</span>
                    {done && (
                      <span className="inline-flex items-center gap-0.5 text-[10.5px] text-emerald-400 shrink-0">
                        <Icon name="check_circle" size={12} filled /> Done
                      </span>
                    )}
                  </div>
                  {m.subtitle && <div className="text-[12px] text-stone-400 truncate">{m.subtitle}</div>}
                </div>
                <span className="text-[11px] text-stone-400 fb-tabular shrink-0">{estLabel(m.estSeconds)}</span>
                <Icon name="play_arrow" size={18} className="text-stone-400 shrink-0" />
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
