// Local activation ledger. Counts and short installer/UTM codes only, stored
// in device-local sync_meta (never synced, never exported). The telemetry
// snapshot reads the event list; it does not read the starter desk id.

import { getDb } from './database'
import {
  activationForTelemetry,
  attributionFromUrl,
  hasActivation,
  isActivationEventName,
  isLaterLocalDay,
  mergeAttribution,
  recordActivation,
  type ActivationEventName,
  type ActivationEventRecord,
  type ActivationTelemetry,
  type InstallAttribution
} from '@shared/activationEvents'
import type { StarterDecision } from '@shared/adhdStarterDesk'

const KEY = 'activation.v1'

export interface ActivationState {
  cohort: 'new' | 'existing' | null
  events: ActivationEventRecord[]
  attribution: InstallAttribution | null
  starterDeskId: string | null
  starterDecision: StarterDecision | null
}

const EMPTY: ActivationState = {
  cohort: null,
  events: [],
  attribution: null,
  starterDeskId: null,
  starterDecision: null
}

export interface ActivationDb {
  prepare: (sql: string) => {
    get: (key: string) => unknown
    run: (key: string, value: string) => unknown
  }
}

function storeOf(db?: ActivationDb): ActivationDb {
  return db ?? (getDb() as unknown as ActivationDb)
}

function clone(state: ActivationState): ActivationState {
  return {
    cohort: state.cohort,
    events: state.events.map((e) => ({ ...e })),
    attribution: state.attribution ? { ...state.attribution } : null,
    starterDeskId: state.starterDeskId,
    starterDecision: state.starterDecision
  }
}

export function parseActivationState(raw: unknown): ActivationState {
  if (!raw || typeof raw !== 'object') return clone(EMPTY)
  const bag = raw as Partial<ActivationState>
  const events: ActivationEventRecord[] = []
  if (Array.isArray(bag.events)) {
    for (const item of bag.events) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Partial<ActivationEventRecord>
      if (!isActivationEventName(rec.name)) continue
      const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? Math.trunc(rec.at) : 0
      const count = typeof rec.count === 'number' && rec.count > 0 ? Math.trunc(rec.count) : 1
      events.push({ name: rec.name, at, count })
    }
  }
  const cohort = bag.cohort === 'new' || bag.cohort === 'existing' ? bag.cohort : null
  const starterDecision = bag.starterDecision === 'provisioned' || bag.starterDecision === 'skipped' ? bag.starterDecision : null
  return {
    cohort,
    events,
    attribution: bag.attribution && typeof bag.attribution === 'object' ? { ...bag.attribution } : null,
    starterDeskId: typeof bag.starterDeskId === 'string' && bag.starterDeskId ? bag.starterDeskId : null,
    starterDecision
  }
}

export function readActivationState(db?: ActivationDb): ActivationState {
  const store = storeOf(db)
  try {
    const row = store.prepare('SELECT value FROM sync_meta WHERE key = ?').get(KEY) as { value?: string } | undefined
    if (!row?.value) return clone(EMPTY)
    return parseActivationState(JSON.parse(row.value) as unknown)
  } catch {
    return clone(EMPTY)
  }
}

export function writeActivationState(state: ActivationState, db?: ActivationDb): void {
  const payload = JSON.stringify(state)
  storeOf(db)
    .prepare(
      'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(KEY, payload)
}

function update(mutate: (state: ActivationState) => void, db?: ActivationDb): ActivationState {
  const state = readActivationState(db)
  mutate(state)
  writeActivationState(state, db)
  return state
}

export function activationTelemetry(db?: ActivationDb): ActivationTelemetry {
  const state = readActivationState(db)
  return activationForTelemetry(state.events, state.attribution)
}

// A deep link can arrive before the database is open. Hold the codes until
// the next successful write rather than dropping them.
let pendingAttribution: InstallAttribution | null = null

/** Remember installer / UTM codes. First touch wins; missing codes can fill in later. */
export function rememberAttribution(incoming: InstallAttribution | null, db?: ActivationDb): void {
  if (!incoming && !pendingAttribution) return
  pendingAttribution = mergeAttribution(pendingAttribution, incoming)
  if (!pendingAttribution) return
  try {
    const held = pendingAttribution
    update((state) => {
      state.attribution = mergeAttribution(state.attribution, held)
    }, db)
    pendingAttribution = null
  } catch {
    /* kept in pendingAttribution for the next successful write */
  }
}

export function captureAttributionFromUrl(url: string, db?: ActivationDb): void {
  rememberAttribution(attributionFromUrl(url), db)
}

/**
 * Stamp this install the first time it runs, and notice a return on a later
 * local day. Upgrades are cohort "existing" and do not emit app_first_launch
 * or day2_return — those measure a new install, not a person who already had
 * the app.
 */
export function noteAppOpen(firstInstall: boolean, now = Date.now(), db?: ActivationDb): void {
  if (pendingAttribution) rememberAttribution(null, db)
  try {
    update((state) => {
      if (!state.cohort) state.cohort = firstInstall ? 'new' : 'existing'
      if (state.cohort !== 'new') return
      if (!hasActivation(state.events, 'app_first_launch')) {
        state.events = recordActivation(state.events, 'app_first_launch', now)
        return
      }
      const first = state.events.find((e) => e.name === 'app_first_launch')
      if (first && !hasActivation(state.events, 'day2_return') && isLaterLocalDay(first.at, now)) {
        state.events = recordActivation(state.events, 'day2_return', now)
      }
    }, db)
  } catch {
    /* local bookkeeping only */
  }
}

export function noteActivation(name: ActivationEventName, now = Date.now(), db?: ActivationDb): void {
  try {
    update((state) => {
      // Once-events stay once. Upgrade clicks count every time.
      if (name !== 'pro_upgrade_clicked' && hasActivation(state.events, name)) return
      state.events = recordActivation(state.events, name, now)
    }, db)
  } catch {
    /* telemetry must never break a feature */
  }
}

/**
 * The first desk a person makes themselves on a new install. The starter desk
 * and any install we already decided had existing work do not count.
 */
export function noteFirstUserDesk(nodeId: string, now = Date.now(), db?: ActivationDb): void {
  try {
    update((state) => {
      if (state.cohort !== 'new') return
      if (state.starterDecision === 'skipped') return
      if (state.starterDeskId && state.starterDeskId === nodeId) return
      if (hasActivation(state.events, 'first_user_desk_created')) return
      state.events = recordActivation(state.events, 'first_user_desk_created', now)
    }, db)
  } catch {
    /* never fail a create because the ledger could not be written */
  }
}

export function markStarterDesk(id: string, now = Date.now(), db?: ActivationDb): void {
  update((state) => {
    state.starterDeskId = id
    state.starterDecision = 'provisioned'
    if (!hasActivation(state.events, 'starter_desk_loaded')) {
      state.events = recordActivation(state.events, 'starter_desk_loaded', now)
    }
  }, db)
}

export function markStarterSkipped(db?: ActivationDb): void {
  try {
    update((state) => {
      if (!state.starterDecision) state.starterDecision = 'skipped'
    }, db)
  } catch {
    /* best effort */
  }
}

