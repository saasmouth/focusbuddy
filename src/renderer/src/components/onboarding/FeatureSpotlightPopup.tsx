import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useOnboarding } from '../../stores/onboarding'
import { useCornerChromeLift } from './cornerClearance'
import { moduleById } from '../../lib/onboarding/registry'
import Icon from '../Icon'
import PlexiiIcon from '../PlexiiIcon'
import { tourModuleEntity } from '../../lib/plexiiIconMap'
import { useInterruptionClear } from '../../lib/useInterruptionClear'

// A small, non-intrusive corner popup that offers a short tour of a NEW feature
// module the user has not seen yet.
//
// NON-MODAL MEANS IT MUST NOT SIT ON ANYTHING. It docks in the bottom-right at
// z-[230], which is where the desk keeps the Plexii pill, the minimap and the
// automations button — and with no scrim to say the app is busy, a press on one
// of those did nothing at all: no panel, no feedback, nothing on screen to say
// why. It rises clear of them instead (cornerClearance), measured rather than
// offset by hand, because where that chrome lands depends on the open-item
// tray, the window and the user's UI scale. This is how future features get introduced:
// add a feature module to the registry and it is offered here on next launch.
// Deliberately a corner card, not a blocking modal, and always dismissible, so
// it never becomes a reason to bounce.

/** The card's resting offset from the window bottom — the old `bottom-5`. */
const BASE_BOTTOM_PX = 20

function estLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}-second`
  return `${Math.round(seconds / 60)}-minute`
}

export default function FeatureSpotlightPopup(): JSX.Element | null {
  const interruptionClear = useInterruptionClear('feature-spotlight', 750)
  const pendingFeatureId = useOnboarding((s) => s.pendingFeatureId)
  const activeModuleId = useOnboarding((s) => s.activeModuleId)
  const start = useOnboarding((s) => s.start)
  const dismissPending = useOnboarding((s) => s.dismissPending)

  // Never stack on top of an active tour or the core first-run flow.
  const mod = pendingFeatureId ? moduleById(pendingFeatureId) : null
  const showing = !!interruptionClear && !activeModuleId && !!mod

  // Above the early return, every render: a hook behind a condition changes the
  // hook count when the card appears and crashes the tree (React #311). It is
  // handed `showing` instead, and measures nothing while the card is away.
  const cardRef = useRef<HTMLDivElement | null>(null)
  const lift = useCornerChromeLift(cardRef, BASE_BOTTOM_PX, showing)

  if (!showing || !mod) return null

  return createPortal(
    // Onboarding stage: forced-dark card in every theme; hairlines are relative to the stage.
    <div
      ref={cardRef}
      className="fixed right-5 z-[230] w-[340px] max-w-[92vw] rounded-2xl bg-[rgba(16,24,39,0.97)] border border-white/10 shadow-2xl text-stone-100 p-4 fb-fade-in-up"
      // `bottom-5` was a class; it is the BASE now, and the lift is added to
      // it, so the card still rests in the corner whenever that corner is
      // empty and `lift` is 0.
      style={{ bottom: BASE_BOTTOM_PX + lift }}
      role="dialog"
      aria-label={`New: ${mod.title}`}
      data-testid="feature-spotlight-popup"
    >
      <div className="flex items-start gap-3">
        <span className="plexii-on-dark h-10 w-10 rounded-xl bg-accent/15 text-accent inline-flex items-center justify-center shrink-0">
          {(() => {
            const ent = tourModuleEntity(mod.id)
            return ent ? <PlexiiIcon kind={ent.kind} id={ent.id} size={22} fallback={mod.icon} /> : <Icon name={mod.icon} size={20} />
          })()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.14em] text-accent font-semibold mb-0.5">New</div>
          <div className="text-[14px] font-semibold leading-tight">{mod.title}</div>
          {mod.subtitle && <div className="text-[12px] text-stone-300 mt-0.5">{mod.subtitle}</div>}
        </div>
        <button
          onClick={() => dismissPending()}
          className="text-stone-400 hover:text-stone-200 shrink-0"
          aria-label="Dismiss"
          data-testid="feature-spotlight-dismiss"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="flex items-center justify-between mt-3">
        <button onClick={() => dismissPending()} className="text-[12px] text-stone-400 hover:text-stone-200">
          Later
        </button>
        <button onClick={() => start(mod.id)} className="btn-primary !py-1.5" data-testid="feature-spotlight-explore">
          <Icon name="explore" size={14} />
          <span>Take the {estLabel(mod.estSeconds)} tour</span>
        </button>
      </div>
    </div>,
    document.body
  )
}
