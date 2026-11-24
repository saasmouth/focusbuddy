import { isShareRecipient } from './shareMode'

// AI Space lives on the desktop app only: its records and connections stay on
// the owner's Mac (docs/ai-space/DESIGN.md). Never in the browser runtime and
// never in a share window, where every aispace channel is refused anyway.
export function aiSpaceAvailable(): boolean {
  if ((globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__) return false
  if (isShareRecipient()) return false
  return typeof window !== 'undefined' && Boolean(window.api?.aiSpace)
}
