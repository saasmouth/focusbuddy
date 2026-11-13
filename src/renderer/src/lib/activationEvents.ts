// Record an activation event by name. The main process keeps the ledger and
// folds it into the next opted-in telemetry snapshot. This never sends on
// its own, and it never accepts anything but the event name.

import type { ActivationEventName } from '@shared/activationEvents'

export function noteActivationEvent(name: ActivationEventName): void {
  try {
    void window.api.activation?.record?.(name)
  } catch {
    /* telemetry must never break the click it is counting */
  }
}
