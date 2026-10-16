import { useEffect, useRef } from 'react'
import { useAccountStore } from '../stores/account'
import { useCapabilityStore } from '../stores/capabilities'
import { installCreditEventWatcher, useAiCreditsStore } from '../stores/aiCredits'
import { useAiBuilderLaunch } from '../stores/aiBuilderLaunch'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import { takePendingBuild } from '../lib/accountClient'
import { reportFirstLaunch } from '../lib/firstLaunch'
import { signalConfig } from '../lib/signalConfig'
import { telemetryEnabled } from '../lib/telemetryPrefs'

// The app-side wiring for the growth changes that have no screen of their own:
//
//   - credit refusals from main → the credit prompt (stores/aiCredits)
//   - the demo → app handoff (section 7): on sign-in, fetch the pending build
//     prompt once (the server clears it on read), make a desk for it and open
//     Build with AI with the prompt written in. Nothing is generated until the
//     person presses Generate.
//   - the first_launch funnel event (section 8), once per account per device
//   - re-reading the credit balance when the plan or verification changes
//
// Mounted once in App. Renders nothing.
export default function GrowthEffects(): null {
  const account = useAccountStore((s) => s.account)
  const token = useAccountStore((s) => s.sessionToken)
  const plan = useCapabilityStore((s) => s.plan)
  const emailVerified = useCapabilityStore((s) => s.emailVerified)
  const pendingCheckedFor = useRef<string | null>(null)

  useEffect(() => installCreditEventWatcher(), [])

  useEffect(() => {
    if (account && token) void useAiCreditsStore.getState().refresh()
  }, [account, token, plan, emailVerified])

  // Pending build: once per account per app session.
  useEffect(() => {
    if (!account || !token || pendingCheckedFor.current === account.id) return
    pendingCheckedFor.current = account.id
    let cancelled = false
    void (async () => {
      const prompt = await takePendingBuild(token)
      if (cancelled || !prompt) return
      const title = prompt.length > 60 ? `${prompt.slice(0, 57).trimEnd()}…` : prompt
      try {
        const desk = await useNodeStore.getState().create({ parentId: null, kind: 'task', title })
        useNodeStore.getState().setActive(desk.id)
        useViewStore.getState().goTask(desk.id)
      } catch {
        // No new desk (e.g. a desk limit). Open the builder on whatever desk is
        // in front of the person rather than dropping the prompt they came with.
      }
      useAiBuilderLaunch.getState().request(prompt)
    })()
    return () => {
      cancelled = true
    }
  }, [account, token])

  // first_launch.
  useEffect(() => {
    if (!account || !token) return
    void reportFirstLaunch({
      httpUrl: signalConfig.httpUrl,
      token,
      accountId: account.id,
      enabled: telemetryEnabled,
      storage: window.localStorage,
      fetchImpl: (input, init) => fetch(input, init),
      // The same aggregate snapshot TelemetryReporter sends (counts only).
      props: async () => (await window.api.ai.collectTelemetry()) as unknown as Record<string, unknown>
    })
  }, [account, token])

  return null
}
