/**
 * voiceCommandPressHold.spec.ts
 *
 * Ground-truth probe for hold-to-talk. The FAB this was written for retired in
 * d055f252 (voice moved into the mascot): the gesture is now a press-and-hold
 * on the assistant pill (lib/voiceHold, useVoiceHold phase idle/listening/
 * transcribing + error), surfaced by voice-hold-indicator / voice-hold-error.
 *   1. Launch Electron with fake media device flags so getUserMedia succeeds.
 *   2. Seed prefs to press-hold mode.
 *   3. Press the pill, hold ~1500ms (past the 250ms click threshold), release.
 *   4. Record every state the indicator shows.
 *   5. Assert the error chip (voice-hold-error) becomes visible and STAYS
 *      visible for >=3 seconds after release (not a flash).
 *
 * Also probes the transcribe IPC directly to confirm what it returns with
 * no OpenAI key (isolated userData, no key seeded).
 */

import { test, expect, type Page } from '@playwright/test'
import { launchGuarded } from './_netGuard'
import { waitForReady } from './_helpers'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── helpers ─────────────────────────────────────────────────────────────────

async function launchWithFakeMic() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'fb-vc-ph-e2e-'))
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE

  const { app } = await launchGuarded({
    args: [
      '.',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream'
    ],
    cwd: process.cwd(),
    env: {
      ...cleanEnv,
      FB_TEST_USER_DATA: userDataDir,
      NODE_ENV: 'test'
    },
    timeout: 25_000
  })

  // Pipe main-process output so failures are visible.
  const mainLogs: string[] = []
  app.process().stdout?.on('data', (b: Buffer) => {
    const s = b.toString()
    mainLogs.push(s)
    process.stdout.write(`[main] ${s}`)
  })
  app.process().stderr?.on('data', (b: Buffer) => {
    const s = b.toString()
    mainLogs.push(s)
    process.stderr.write(`[main-err] ${s}`)
  })

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  async function dispose() {
    try { await app.close() } catch { /* already closed */ }
    try { rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  return { app, window, dispose, mainLogs }
}

async function bootReady(window: Page): Promise<void> {
  // The shell is up and the post-boot modals are out of the way (the same
  // gate every launchApp spec uses). There is no FAB to wait for any more.
  await waitForReady(window)
}

// Collect all renderer console messages into an array.
function collectConsole(window: Page): string[] {
  const logs: string[] = []
  window.on('console', (msg) => {
    logs.push(`[console:${msg.type()}] ${msg.text()}`)
  })
  window.on('pageerror', (err) => {
    logs.push(`[pageerror] ${err.message}`)
  })
  return logs
}

// What the voice indicator shows right now: 'listening', 'transcribing',
// 'error', or 'idle' when it is not mounted (useVoiceHold idle, no error).
async function voiceState(window: Page): Promise<string> {
  return window.evaluate(() => {
    const root = document.querySelector('[data-testid="voice-hold-indicator"]')
    if (!root) return 'idle'
    if (root.querySelector('[data-testid="voice-hold-error"]')) return 'error'
    const t = root.textContent ?? ''
    return /Listening/.test(t) ? 'listening' : /Transcribing/.test(t) ? 'transcribing' : 'idle'
  })
}

// Record each change of the indicator's state, with timestamps.
async function pollPhase(window: Page, durationMs: number, intervalMs = 100): Promise<string[]> {
  const transitions: string[] = []
  let last = ''
  const end = Date.now() + durationMs
  while (Date.now() < end) {
    const phase = await voiceState(window).catch(() => null)
    if (phase !== null && phase !== last) {
      transitions.push(`${Date.now()} phase→${phase}`)
      last = phase
    }
    await window.waitForTimeout(intervalMs)
  }
  return transitions
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('VoiceCommandFAB press-hold flow (fake mic)', () => {
  test('getUserMedia resolves with fake device flags', async () => {
    const { window, dispose } = await launchWithFakeMic()
    try {
      await bootReady(window)

      // Directly evaluate getUserMedia in renderer.
      const result = await window.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const tracks = stream.getAudioTracks()
          // Clean up immediately.
          tracks.forEach((t) => t.stop())
          return {
            ok: true,
            trackCount: tracks.length,
            label: tracks[0]?.label ?? '(no label)'
          }
        } catch (err) {
          return { ok: false, error: (err as Error).message }
        }
      })

      console.log('[TEST] getUserMedia result:', JSON.stringify(result))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.trackCount).toBeGreaterThanOrEqual(1)
      }
    } finally {
      await dispose()
    }
  })

  test('transcribe IPC with no OpenAI key returns ok:false reason:no_key', async () => {
    const { window, dispose } = await launchWithFakeMic()
    try {
      await bootReady(window)

      // First confirm cloud provider is active.
      const provider = await window.evaluate(() => window.api.voiceNote.getProvider())
      console.log('[TEST] provider:', provider)

      // Call transcribe with a tiny dummy buffer (3 bytes).
      const res = await window.evaluate(async () => {
        const buf = new Uint8Array([1, 2, 3]).buffer
        return window.api.voiceNote.transcribe({ buffer: buf, mimeType: 'audio/webm' })
      })

      console.log('[TEST] transcribe result:', JSON.stringify(res))

      expect(res.ok).toBe(false)
      if (!res.ok) {
        // Should be no_key since test userData has no OpenAI key set.
        expect(res.reason).toBe('no_key')
        expect(res.error).toMatch(/openai key/i)
      }
    } finally {
      await dispose()
    }
  })

  test('press-hold: Listening panel appears, error panel renders and STAYS after release', async () => {
    const { window, dispose } = await launchWithFakeMic()
    try {
      await bootReady(window)

      // Collect console logs from renderer.
      const consoleLogs = collectConsole(window)

      // Seed prefs to press-hold mode (should already be default, but be explicit).
      await window.evaluate(() =>
        window.api.voiceCommand.setPrefs({
          commandMode: 'press-hold',
          autoStopSilenceMs: 5000,
          voiceback: false
        })
      )

      // Confirm prefs.
      const prefs = await window.evaluate(() => window.api.voiceCommand.getPrefs())
      console.log('[TEST] prefs:', JSON.stringify(prefs))
      expect(prefs.commandMode).toBe('press-hold')

      // The assistant pill carries the gesture now (a hold past 250ms listens).
      const fab = window.locator('[data-testid="assistant-pill"]')
      await expect(fab).toBeVisible()
      const initialPhase = await voiceState(window)
      console.log('[TEST] initial phase:', initialPhase)
      expect(initialPhase).toBe('idle')

      // Get the pill's bounding box to press at its center.
      const box = await fab.boundingBox()
      expect(box).toBeTruthy()
      const cx = box!.x + box!.width / 2
      const cy = box!.y + box!.height / 2

      // ── Phase 1: pointerdown ────────────────────────────────────────────
      // A real pointerdown on the pill arms a 250ms timer → startHold().
      await window.mouse.move(cx, cy)
      await window.mouse.down()

      // Poll for phase transitions. We expect 'listening' to appear within 2s
      // (getUserMedia is fast with fake device).
      const phasesDuringHold = await pollPhase(window, 2000, 100)
      console.log('[TEST] phases during hold:', phasesDuringHold)

      // Verify the FAB entered listening phase.
      const phaseAfterDown = await voiceState(window)
      console.log('[TEST] phase after pointerdown + 2s:', phaseAfterDown)

      // Screenshot: listening state.
      await window.screenshot({
        path: '/tmp/fb-voice-ph-listening.png'
      })
      console.log('[TEST] screenshot saved: /tmp/fb-voice-ph-listening.png')

      // ── Phase 2: pointerup ──────────────────────────────────────────────
      await window.mouse.up()
      console.log('[TEST] pointerup dispatched')

      // Poll for phase transitions for 5s after release.
      const phasesAfterRelease = await pollPhase(window, 5000, 100)
      console.log('[TEST] phases after release:', phasesAfterRelease)

      const phaseAfterRelease = await voiceState(window)
      console.log('[TEST] phase 5s after release:', phaseAfterRelease)

      // Screenshot: final state after release.
      await window.screenshot({
        path: '/tmp/fb-voice-ph-after-release.png'
      })
      console.log('[TEST] screenshot saved: /tmp/fb-voice-ph-after-release.png')

      // ── Critical assertion: error panel must be VISIBLE ─────────────────
      // With no OpenAI key, transcribe should fail → phase='error' →
      // the voice-hold-error chip should be visible.
      const errorDismiss = window.locator('[data-testid="voice-hold-error"]')
      const isVisible = await errorDismiss.isVisible()
      console.log('[TEST] error dismiss visible:', isVisible)

      // Also check what phase the FAB shows.
      const finalPhase = await voiceState(window)
      console.log('[TEST] final fab data-phase:', finalPhase)

      // Dump renderer console for full trace.
      console.log('[TEST] renderer console collected:')
      consoleLogs.forEach((l) => console.log(l))

      // ── Assertions ───────────────────────────────────────────────────────
      // The Listening panel should have appeared during the hold.
      const sawListening = phasesDuringHold.some((p) => p.includes('listening')) ||
        phaseAfterDown === 'listening'
      console.log('[TEST] saw listening phase:', sawListening)
      // The title promises the Listening state; it was logged and never checked.
      expect(sawListening, `the hold showed Listening (saw: ${phasesDuringHold.join(', ')})`).toBe(true)

      // After release, error OR staged should appear (not back to idle).
      // The key question: does it flash to idle or stay?
      const allPhases = [...phasesDuringHold, ...phasesAfterRelease]
      console.log('[TEST] all phase transitions:', allPhases)

      // If error panel is visible, fix works.
      if (isVisible) {
        console.log('[TEST] VERDICT: ERROR PANEL IS VISIBLE — fix works.')
        await expect(errorDismiss).toBeVisible()
        // Wait 3 more seconds and verify it's still there (not a flash).
        await window.waitForTimeout(3000)
        await expect(errorDismiss).toBeVisible({ timeout: 500 })
        console.log('[TEST] VERDICT: ERROR PANEL STAYED 3s — solid fix confirmed.')
      } else {
        // Determine whether we flashed to idle or are in another state.
        const sawError = allPhases.some((p) => p.includes('error'))
        const sawStaged = allPhases.some((p) => p.includes('staged'))
        const endedIdle = finalPhase === 'idle'
        console.log('[TEST] sawError:', sawError, 'sawStaged:', sawStaged, 'endedIdle:', endedIdle)

        if (endedIdle) {
          console.log('[TEST] VERDICT: OVERLAY FLASHED — went to idle. Bug confirmed.')
        } else {
          console.log('[TEST] VERDICT: PARTIAL — phase is', finalPhase, 'but error panel not visible.')
        }

        // Fail the test with a descriptive message.
        throw new Error(
          `Error chip (voice-hold-error) NOT visible after press-hold release.\n` +
          `Final data-phase="${finalPhase}", all transitions: ${allPhases.join(', ')}\n` +
          `sawError=${sawError} sawStaged=${sawStaged} endedIdle=${endedIdle}`
        )
      }
    } finally {
      await dispose()
    }
  })

  test('press-hold: verify MediaRecorder produces chunks with fake device', async () => {
    const { window, dispose } = await launchWithFakeMic()
    try {
      await bootReady(window)

      // Run a miniature press-hold simulation in the renderer itself,
      // bypassing React, to confirm the raw MediaRecorder + fake mic work.
      const result = await window.evaluate(async () => {
        const chunks: number[] = []
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const mr = new MediaRecorder(stream)
          mr.ondataavailable = (e) => {
            chunks.push(e.data.size)
          }
          mr.start(250) // 250ms slices — same as FAB code

          // Hold for 1200ms then stop.
          await new Promise<void>((resolve) => setTimeout(resolve, 1200))

          await new Promise<void>((resolveStop) => {
            const t = setTimeout(resolveStop, 700)
            mr.onstop = () => { clearTimeout(t); resolveStop() }
            try { mr.stop() } catch { resolveStop() }
          })

          stream.getTracks().forEach((t) => t.stop())

          return {
            ok: true,
            chunkCount: chunks.length,
            chunkSizes: chunks,
            totalBytes: chunks.reduce((a, b) => a + b, 0)
          }
        } catch (err) {
          return { ok: false, error: (err as Error).message }
        }
      })

      console.log('[TEST] MediaRecorder probe result:', JSON.stringify(result))

      if (!result.ok) {
        console.log('[TEST] MediaRecorder FAILED:', result.error)
      }
      expect(result.ok).toBe(true)
      if (result.ok) {
        console.log('[TEST] chunks:', result.chunkCount, 'totalBytes:', result.totalBytes)
        // Fake device should produce at least 1 chunk in 1200ms at 250ms slices.
        expect(result.chunkCount).toBeGreaterThanOrEqual(1)
      }
    } finally {
      await dispose()
    }
  })
})
