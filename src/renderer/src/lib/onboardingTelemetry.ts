// Records onboarding progress to the main process so it rides the existing
// telemetry snapshot up to the signal server and shows in the admin as a per-
// user "onboarded" record. Best-effort and privacy-preserving: it sends only
// aggregate flags (core done, how many modules completed, the last module id and
// outcome), never document content. Respects the same opt-in (default off) as the
// usage snapshot because it flows through the same /telemetry pipeline.

const STATE_KEY = 'fb.onboarding.v2'

interface Persisted {
  completed?: Record<string, number>
}

export async function reportOnboarding(ev: {
  moduleId: string
  version: number
  outcome: 'completed' | 'skipped'
  atStep?: number
}): Promise<void> {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    const p: Persisted = raw ? (JSON.parse(raw) as Persisted) : {}
    const completed = p.completed ?? {}
    const summary = {
      coreCompleted: (completed.core ?? 0) >= 1,
      modulesCompleted: Object.keys(completed).length,
      lastModuleId: ev.moduleId,
      lastOutcome: ev.outcome
    }
    const api = (window as unknown as { api?: { onboarding?: { record?: (s: unknown) => Promise<void> } } }).api
    await api?.onboarding?.record?.(summary)
  } catch {
    /* best-effort — never block the UI on telemetry */
  }
}
