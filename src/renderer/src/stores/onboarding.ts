import { create } from 'zustand'
import { reportOnboarding } from '../lib/onboardingTelemetry'
import { ONBOARDING_MODULES, featureModules, moduleById } from '../lib/onboarding/registry'
import { isUntouchedStarterWorkspace } from '@shared/adhdStarterDesk'

// Modular onboarding. There is one always-available "core" first-run flow plus
// any number of short, replayable feature tours. Every module is:
//   - replayable at any time (from the Help/tour hub), not just first run;
//   - versioned, so bumping a module re-offers it to people who saw the old one;
//   - tracked per user (completed vs skipped) and reported to the admin.
// Design intent (the operator flagged ADHD monotony as a real risk): keep each
// module tiny, show a time estimate, make every step skippable, and prefer
// "show me on the real screen" over walls of text.

// Legacy first-run key (v1). Respected so an existing user who already finished
// the old onboarding is never shown the core flow again.
const LEGACY_CORE_KEY = 'fb.onboarding.v1.done'
const STATE_KEY = 'fb.onboarding.v2'

export const CORE_MODULE_ID = 'core'

type CoreStatus = 'unknown' | 'active' | 'done'

interface Persisted {
  // moduleId -> the version the user last completed
  completed: Record<string, number>
  // moduleId -> version last skipped (so we do not nag, but can tell them apart)
  skipped: Record<string, number>
}

interface OnboardingStore {
  // Back-compat surface for the core first-run modal (FirstRunOnboarding reads
  // these): 'active' when the core flow should show as a fresh-install first run.
  status: CoreStatus
  // The module currently being run in the overlay (core or a feature tour), or
  // null. Distinct from `status` so a replay/feature tour can run after first run.
  activeModuleId: string | null
  activeStep: number
  // A feature module offered as a login popup but not yet started/dismissed.
  pendingFeatureId: string | null
  completed: Record<string, number>
  skipped: Record<string, number>

  init: () => Promise<void>
  // Start (or replay) a module by id.
  start: (moduleId: string) => void
  next: () => void
  prev: () => void
  // Finish the active module successfully.
  complete: () => void
  // Leave the active module early (records a skip, still counts as "seen").
  skip: () => void
  // Dismiss the login-popup offer without starting it (snoozed for now, still
  // offered again next launch until completed or skipped).
  dismissPending: () => void
  // Modules that have never been completed at their current version and want to
  // be offered (feature tours only; core is handled by `status`).
  hasSeen: (moduleId: string) => boolean
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Persisted
      return { completed: p.completed ?? {}, skipped: p.skipped ?? {} }
    }
  } catch {
    /* ignore */
  }
  // Migrate the legacy core flag into the v2 shape.
  const completed: Record<string, number> = {}
  try {
    if (localStorage.getItem(LEGACY_CORE_KEY) === '1') completed[CORE_MODULE_ID] = 1
  } catch {
    /* ignore */
  }
  return { completed, skipped: {} }
}

function persist(p: Persisted): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(p))
  } catch {
    /* ignore quota */
  }
}

export const useOnboarding = create<OnboardingStore>((set, get) => ({
  status: 'unknown',
  activeModuleId: null,
  activeStep: 0,
  pendingFeatureId: null,
  completed: {},
  skipped: {},

  init: async () => {
    const p = loadPersisted()
    set({ completed: p.completed, skipped: p.skipped })

    // Core first-run decision. Completed already => done. Otherwise grandfather
    // anyone who has clearly used the app (has data or an API key) so upgrades
    // never see it, and only a genuinely fresh install runs it.
    const coreDone = (p.completed[CORE_MODULE_ID] ?? 0) >= 1
    if (coreDone) {
      set({ status: 'done' })
    } else {
      let fresh = true
      try {
        const [nodes, hint, starter] = await Promise.all([
          window.api.nodes.list(),
          window.api.settings.hintAnthropic(),
          window.api.starterDesk?.current?.().catch(() => ({ deskId: null as string | null })) ??
            Promise.resolve({ deskId: null as string | null })
        ])
        // The starter desk we just placed is not "this person already has a
        // workspace". Anything else — their own desk, a room, an API key — is.
        const onlyStarter = isUntouchedStarterWorkspace(nodes, starter?.deskId ?? null)
        if ((nodes.length > 0 && !onlyStarter) || hint.hasKey) fresh = false
      } catch {
        /* if unsure, treat as fresh — the new-user case is the one that matters */
      }
      if (!fresh) {
        const np = { ...p, completed: { ...p.completed, [CORE_MODULE_ID]: 1 } }
        persist(np)
        set({ status: 'done', completed: np.completed })
      } else {
        set({ status: 'active', activeModuleId: CORE_MODULE_ID, activeStep: 0 })
      }
    }

    // Offer the newest un-seen feature tour as a login popup, but never on top of
    // the core first-run (a brand-new user should not be piled on). Pick the
    // highest-priority feature module the user has not completed or skipped at
    // its current version.
    if ((get().status ?? 'done') === 'done') {
      const pending = featureModules().find((m) => {
        const done = (p.completed[m.id] ?? 0) >= m.version
        const skipped = (p.skipped[m.id] ?? 0) >= m.version
        return !done && !skipped
      })
      if (pending) set({ pendingFeatureId: pending.id })
    }
  },

  start: (moduleId) => {
    if (!moduleById(moduleId)) return
    set({ activeModuleId: moduleId, activeStep: 0, pendingFeatureId: null })
  },

  next: () => {
    const { activeModuleId, activeStep } = get()
    const mod = activeModuleId ? moduleById(activeModuleId) : null
    if (!mod) return
    if (activeStep >= mod.steps.length - 1) {
      get().complete()
      return
    }
    set({ activeStep: activeStep + 1 })
  },

  prev: () => set((s) => ({ activeStep: Math.max(0, s.activeStep - 1) })),

  complete: () => {
    const { activeModuleId } = get()
    const mod = activeModuleId ? moduleById(activeModuleId) : null
    if (!mod) return
    const p = loadPersisted()
    p.completed[mod.id] = mod.version
    delete p.skipped[mod.id]
    persist(p)
    void reportOnboarding({ moduleId: mod.id, version: mod.version, outcome: 'completed' })
    set({
      completed: p.completed,
      skipped: p.skipped,
      activeModuleId: null,
      activeStep: 0,
      status: mod.id === CORE_MODULE_ID ? 'done' : get().status
    })
  },

  skip: () => {
    const { activeModuleId, activeStep } = get()
    const mod = activeModuleId ? moduleById(activeModuleId) : null
    if (!mod) return
    const p = loadPersisted()
    p.skipped[mod.id] = mod.version
    persist(p)
    void reportOnboarding({ moduleId: mod.id, version: mod.version, outcome: 'skipped', atStep: activeStep })
    set({
      skipped: p.skipped,
      activeModuleId: null,
      activeStep: 0,
      status: mod.id === CORE_MODULE_ID ? 'done' : get().status
    })
  },

  dismissPending: () => set({ pendingFeatureId: null }),

  hasSeen: (moduleId) => {
    const s = get()
    const mod = moduleById(moduleId)
    if (!mod) return true
    return (s.completed[moduleId] ?? 0) >= mod.version || (s.skipped[moduleId] ?? 0) >= mod.version
  }
}))

// Re-export the registry so callers (the tour hub, command palette) can list
// modules without reaching past the store.
export { ONBOARDING_MODULES }

// Spec access, same convention as __fbView: e2e drives first-run flows that a
// seeded profile would otherwise never show (the freshness check sees nodes).
;(window as unknown as { __fbOnboarding?: typeof useOnboarding }).__fbOnboarding = useOnboarding
