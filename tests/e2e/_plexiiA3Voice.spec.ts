import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, waitForReady } from './_helpers'

// A3 build 1 — the voice pipeline health probe (Caleb: "kind of busted").
// Drives the REAL engine with no microphone and no keys:
//   1. macOS `say` synthesises the gate phrase as genuine speech audio; the
//      page decodes it with AudioContext (the renderer's real decode path)
//      and ships Float32Array samples over the real IPC to the real local
//      Whisper (provider = 'local', Caleb's actual preference; model cache
//      pre-seeded from the live profile so nothing downloads).
//   2. (retired with the voiceCommand engine, A6/B0 R30: the acting voice
//      path is the composer door per R17, and the proposals engine it once
//      streamed through is deleted — its sanitiser discipline lives on in
//      browserAgentEnvelope.ts with its own locks.)
// Throwaway; delete when A3 closes.
const OUT = process.env.SHOT_DIR ?? '/tmp'
const GATE_PHRASE = 'open a tie the knot site for this wedding'

test('voice engine: real speech through local Whisper', async () => {
  test.setTimeout(240_000)

  // ── Synthesize the gate phrase as real speech, 16kHz mono WAV ──
  const audioDir = mkdtempSync(join(tmpdir(), 'plexii-voice-'))
  const aiff = join(audioDir, 'gate.aiff')
  const wav = join(audioDir, 'gate.wav')
  execFileSync('say', ['-o', aiff, GATE_PHRASE])
  execFileSync('afconvert', [aiff, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', wav])
  const wavB64 = readFileSync(wav).toString('base64')

  // ── Pre-seed the whisper model cache from the live profile (42MB, APFS
  // clone) so the local provider loads instantly instead of downloading. ──
  const userDataDir = mkdtempSync(join(tmpdir(), 'plexii-e2e-voice-'))
  const liveCache = join(
    process.env.HOME ?? '',
    'Library/Application Support/plexii/whisper-cache'
  )
  if (existsSync(liveCache)) {
    cpSync(liveCache, join(userDataDir, 'whisper-cache'), { recursive: true })
  }

  const launched = await launchApp({ userDataDir })
  const { window } = launched
  await waitForReady(window)
  window.on('pageerror', (e) => console.log('PAGEERROR', e.message))

  // Caleb's real provider preference.
  const setRes = await window.evaluate(() => window.api.voiceNote.setProvider('local'))
  console.log('[probe] setProvider(local):', JSON.stringify(setRes))

  // ── Phase 1: decode in the page (the renderer's real path) and transcribe ──
  const t0 = Date.now()
  const transcribeRes = await window.evaluate(async (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    // The FAB's decodeToMono16k contract: AudioContext at 16kHz, mono.
    const ctx = new AudioContext({ sampleRate: 16000 })
    const decoded = await ctx.decodeAudioData(bytes.buffer)
    const samples = decoded.getChannelData(0)
    await ctx.close()
    return window.api.voiceNote.transcribe({
      samples: new Float32Array(samples),
      sampleRate: 16000
    })
  }, wavB64)
  const transcribeMs = Date.now() - t0
  console.log('[probe] transcribe result:', JSON.stringify(transcribeRes), `in ${transcribeMs}ms`)

  expect(transcribeRes.ok).toBe(true)
  const transcript = (transcribeRes as { ok: true; transcript: string }).transcript
  expect(transcript.trim().length).toBeGreaterThan(0)
  // whisper-tiny on synthesized speech: the load-bearing nouns must land.
  expect(transcript).toMatch(/wedding|knot/i)

  await window.screenshot({ path: `${OUT}/voice-1-engine-pass.png` })
  await launched.dispose()
})

test('mascot voice chrome: the bar is gone, the pill holds to talk, staging fills the composer', async () => {
  test.setTimeout(180_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'plexii-e2e-voice2-'))
  const liveCache = join(
    process.env.HOME ?? '',
    'Library/Application Support/plexii/whisper-cache'
  )
  if (existsSync(liveCache)) {
    cpSync(liveCache, join(userDataDir, 'whisper-cache'), { recursive: true })
  }
  const launched = await launchApp({ userDataDir })
  const { window } = launched
  await waitForReady(window)
  window.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  await window.setViewportSize({ width: 1440, height: 900 })
  await window.evaluate(
    (t) => localStorage.setItem('fb.theme.mode', t),
    process.env.SHOT_THEME ?? 'dark'
  )
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => window.api.voiceNote.setProvider('local'))

  // R7: the bottom-center voice bar is RETIRED — no mic strip anywhere.
  await expect(window.locator('button[aria-label="Toggle voice mic"]')).toHaveCount(0)

  // The pill teaches both gestures.
  const pill = window.locator('[data-testid="assistant-pill"]')
  await expect(pill).toBeVisible()
  await expect(pill).toHaveAttribute('title', 'Plexii — click to open, hold to talk')

  // AI-18: the boot greeting is the mount blink — it settles to the static
  // mark (the animated branch's .pm-mark leaves the DOM at the cycle end)…
  const animatedMark = pill.locator('.pm-mark')
  await expect(animatedMark).toHaveCount(0, { timeout: 8_000 })
  // …and a personality moment replays exactly ONE cycle: animating right
  // after the signal, frozen again at the boundary.
  await window.evaluate(() => window.dispatchEvent(new Event('fb:plexii-moment')))
  await expect(animatedMark).toHaveCount(1)
  await expect(animatedMark).toHaveCount(0, { timeout: 6_000 })

  // Feed the capture a REAL audio stream with no microphone: an oscillator
  // into a MediaStream destination — MediaRecorder records genuine webm.
  await window.evaluate(() => {
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    const osc = ctx.createOscillator()
    osc.frequency.value = 440
    osc.connect(dest)
    osc.start()
    navigator.mediaDevices.getUserMedia = async () => dest.stream
  })

  // Hold Cmd+Shift+Space (R18): the listening chip and the pill ring appear.
  await window.keyboard.down('Meta')
  await window.keyboard.down('Shift')
  await window.keyboard.down('Space')
  const indicator = window.locator('[data-testid="voice-hold-indicator"]')
  await expect(indicator).toBeVisible()
  await expect(indicator).toContainText('Listening')
  await expect(window.locator('[data-testid="assistant-pill-ring"]')).toBeVisible()
  await window.waitForTimeout(900)
  await window.screenshot({ path: `${OUT}/voice-2-listening.png` })
  await window.keyboard.up('Space')
  await window.keyboard.up('Shift')
  await window.keyboard.up('Meta')
  // Release: a pure tone transcribes to nothing (the honest error chip) or a
  // hallucinated word (stages in the composer) — whisper-tiny decides; both
  // are valid ends of the pipeline. What must NOT remain is the live chip.
  await expect(indicator.getByText('Listening — release to review')).toHaveCount(0, {
    timeout: 60_000
  })
  const errorChip = window.locator('[data-testid="voice-hold-error"]')
  const overlay = window.locator('[data-testid="assistant-overlay"]')
  // POLLED, not counted once. The chip clearing and the staged overlay
  // mounting are two different renders, so reading counts the instant the chip
  // goes means sometimes catching the gap between them and calling it 'none'.
  // That made this spec fail roughly one run in three on identical whisper
  // output — a flake that costs more than the assertion is worth, and which
  // sent a release investigation looking for a regression that was not there.
  // Either real outcome still has to arrive; only the race is gone.
  await expect
    .poll(
      async () =>
        (await errorChip.count()) > 0
          ? 'error-chip'
          : (await overlay.count()) > 0
            ? 'staged'
            : 'none',
      { timeout: 15_000 }
    )
    .not.toBe('none')
  // Settled now, so a plain read is safe — and the rest of the spec branches
  // on which of the two ends it reached.
  const outcome = (await errorChip.count()) > 0 ? 'error-chip' : 'staged'
  console.log('[probe] tone outcome:', outcome)
  await window.screenshot({ path: `${OUT}/voice-3-after-release.png` })

  // Staging (R17), deterministic leg: the composer-stage event fills the OPEN
  // panel's composer for review — never sends.
  if (outcome === 'error-chip') {
    await errorChip.click()
  }
  if ((await overlay.count()) === 0) {
    await pill.click()
  }
  await expect(overlay).toBeVisible()
  await window.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('fb:composer-stage', { detail: 'open a tie the knot site for this wedding' })
    )
  })
  await expect(overlay).toContainText('open a tie the knot site for this wedding')
  // Mirrored into the store draft (AI-16's survival law applies to voice too).
  const draftHeld = await window.evaluate(() => {
    const chat = (
      window as unknown as {
        __fbChat: { getState: () => { draftDocByThread: Record<string, unknown> } }
      }
    ).__fbChat
    return JSON.stringify(chat.getState().draftDocByThread).includes('tie the knot')
  })
  expect(draftHeld).toBe(true)
  await window.waitForTimeout(300)
  await window.screenshot({ path: `${OUT}/voice-4-staged.png` })

  await launched.dispose()
})
