/**
 * voiceTranscribePipeline.spec.ts
 *
 * Pipeline-probe for the audio → IPC → main → Whisper path.
 * This does NOT hit the real OpenAI API (uses a dummy key).
 * It answers exactly:
 *
 *   A) Does the buffer survive renderer→main intact?
 *   B) Does transcribeCloud reach OpenAI, or throw a Node error first?
 *   C) Does the Node runtime have working global Blob/FormData/fetch?
 *   D) Does MediaRecorder produce a valid webm with the fake device?
 *   E) If buffer is 0 bytes at main, why?
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// EBML magic bytes for a valid WebM/Matroska container.
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]

// ----- helpers ---------------------------------------------------------------

function hexStr(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

// ---- C: Node globals in main process ----------------------------------------

test('C — main process has working Blob, FormData, fetch and Node ≥ 18', async () => {
  const { app, dispose } = await launchApp()
  try {
    const result = await app.evaluate(async () => {
      // This callback runs in the main Node/Electron process.
      return {
        typeofBlob: typeof Blob,
        typeofFormData: typeof FormData,
        typeofFetch: typeof fetch,
        nodeVersion: process.versions.node,
        // Smoke-test: construct a Blob + FormData, check no throws.
        blobConstructs: (() => {
          try {
            const b = new Blob(['hello'], { type: 'text/plain' })
            return b.size === 5
          } catch (e) {
            return String(e)
          }
        })(),
        formDataConstructs: (() => {
          try {
            const fd = new FormData()
            fd.append('key', 'val')
            return true
          } catch (e) {
            return String(e)
          }
        })(),
        fetchExists: (() => {
          try {
            return typeof globalThis.fetch === 'function'
          } catch {
            return false
          }
        })()
      }
    })

    console.log('[pipeline-probe] Node globals:', JSON.stringify(result, null, 2))

    expect(result.typeofBlob, 'Blob must be defined in main process').toBe('function')
    expect(result.typeofFormData, 'FormData must be defined in main process').toBe('function')
    expect(result.typeofFetch, 'fetch must be defined in main process').toBe('function')
    expect(result.blobConstructs, 'new Blob([...]) must succeed').toBe(true)
    expect(result.formDataConstructs, 'new FormData() + append must succeed').toBe(true)
    expect(result.fetchExists, 'globalThis.fetch must be a function').toBe(true)

    const [major] = result.nodeVersion.split('.').map(Number)
    expect(major, 'Node major version must be ≥ 18 for native Blob+FormData').toBeGreaterThanOrEqual(18)
  } finally {
    await dispose()
  }
})

// ---- D: MediaRecorder produces a valid webm with fake device ----------------

test('D — MediaRecorder(fake device) produces non-empty webm with EBML header', async () => {
  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Record ~1.2s of fake audio, return {byteLength, firstFourBytes}.
    const recording = await window.evaluate(async (): Promise<{
      byteLength: number
      firstFourHex: string
      mimeType: string
      error?: string
    }> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const recorder = new MediaRecorder(stream)
        const chunks: Blob[] = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        await new Promise<void>((resolve) => {
          recorder.onstop = () => resolve()
          recorder.start()
          setTimeout(() => recorder.stop(), 1200)
        })
        stream.getTracks().forEach((t) => t.stop())

        const blob = new Blob(chunks, { type: 'audio/webm' })
        const buf = await blob.arrayBuffer()
        const view = new Uint8Array(buf)
        const firstFour = Array.from(view.slice(0, 4))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')
        return {
          byteLength: buf.byteLength,
          firstFourHex: firstFour,
          mimeType: blob.type
        }
      } catch (e) {
        return {
          byteLength: 0,
          firstFourHex: '',
          mimeType: '',
          error: String(e)
        }
      }
    })

    console.log('[pipeline-probe] MediaRecorder result:', JSON.stringify(recording))

    expect(recording.error, `MediaRecorder threw: ${recording.error}`).toBeUndefined()
    expect(recording.byteLength, 'Recorded blob must be > 0 bytes').toBeGreaterThan(0)

    // EBML magic: 1a 45 df a3
    const expectedHex = hexStr(WEBM_MAGIC)
    expect(
      recording.firstFourHex,
      `First 4 bytes should be EBML magic ${expectedHex}, got ${recording.firstFourHex}`
    ).toBe(expectedHex)
  } finally {
    await dispose()
  }
})

// ---- A + B: Buffer survives IPC; pipeline reaches OpenAI -------------------

test('A+B — buffer arrives in main intact; pipeline reaches OpenAI (expects 401, not Node exception)', async () => {
  const { app, window, dispose } = await launchApp()

  // Collect main-process log lines so we can verify the byte count logged
  // by transcribeCloud: "[voiceNote] cloud transcribe: N bytes, mime=..."
  const mainLogs: string[] = []
  app.process().stdout?.on('data', (buf: Buffer) => {
    const line = buf.toString('utf8')
    mainLogs.push(line)
    process.stdout.write(`[main-stdout] ${line}`)
  })
  app.process().stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString('utf8')
    mainLogs.push(line)
    process.stderr.write(`[main-stderr] ${line}`)
  })

  try {
    await waitForReady(window)
    // The cloud transcription path: since 4.3.39 a fresh profile's AI source is
    // Local (which keeps voice notes on the device), so choose a cloud source.
    await window.evaluate(() => (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('auto'))

    // Step 1: seed a dummy OpenAI key + switch to cloud provider.
    await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.settings.saveOpenAIKey('sk-proj-DUMMYKEYFORPIPELINETEST000000000000')
      await api.voiceNote.setProvider('cloud')
    })

    // Step 2: record ~1.2s with fake device and call transcribe.
    const ipcResult = await window.evaluate(async (): Promise<{
      rendererByteLength: number
      ipcResult: unknown
      error?: string
    }> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const recorder = new MediaRecorder(stream)
        const chunks: Blob[] = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        await new Promise<void>((resolve) => {
          recorder.onstop = () => resolve()
          recorder.start()
          setTimeout(() => recorder.stop(), 1200)
        })
        stream.getTracks().forEach((t) => t.stop())

        const blob = new Blob(chunks, { type: 'audio/webm' })
        const buffer = await blob.arrayBuffer()
        const rendererByteLength = buffer.byteLength

        const api = (window as unknown as { api: typeof window.api }).api
        const result = await api.voiceNote.transcribe({
          buffer,
          mimeType: 'audio/webm'
        })
        return { rendererByteLength, ipcResult: result }
      } catch (e) {
        return { rendererByteLength: 0, ipcResult: null, error: String(e) }
      }
    })

    console.log('[pipeline-probe] Renderer byteLength:', ipcResult.rendererByteLength)
    console.log('[pipeline-probe] IPC result:', JSON.stringify(ipcResult.ipcResult, null, 2))
    console.log('[pipeline-probe] Main logs (voice-related):',
      mainLogs.filter((l) => l.includes('[voiceNote]')).join('\n'))

    // (E) No renderer-side error.
    expect(ipcResult.error, `Renderer threw before IPC: ${ipcResult.error}`).toBeUndefined()

    // (A) Buffer was non-empty at the renderer side.
    expect(ipcResult.rendererByteLength, 'Renderer buffer must be > 0 bytes').toBeGreaterThan(0)

    // (A) Check what main logged — "[voiceNote] cloud transcribe: N bytes"
    // Give the async log streams a beat to flush.
    await new Promise((r) => setTimeout(r, 300))
    const voiceLogs = mainLogs.filter((l) => l.includes('[voiceNote]'))
    console.log('[pipeline-probe] All [voiceNote] lines:', voiceLogs)

    const cloudLog = voiceLogs.find((l) => l.includes('cloud transcribe:'))
    expect(cloudLog, 'Main must log "[voiceNote] cloud transcribe: N bytes"').toBeTruthy()

    // Extract the byte count from "[voiceNote] cloud transcribe: N bytes, ..."
    const match = cloudLog!.match(/cloud transcribe:\s*(\d+)\s*bytes/)
    expect(match, 'Must be able to parse byte count from main log').toBeTruthy()
    const mainBytes = parseInt(match![1], 10)
    console.log('[pipeline-probe] Renderer sent:', ipcResult.rendererByteLength, 'Main received:', mainBytes)

    // (A) Buffer integrity over IPC.
    expect(mainBytes, 'Byte count at main must be > 0').toBeGreaterThan(0)
    // Allow ±5% drift (structured-clone shouldn't change byte count, but
    // let's be defensive against any alignment padding).
    const ratio = mainBytes / ipcResult.rendererByteLength
    expect(ratio, `Byte count ratio (main/renderer = ${ratio.toFixed(3)}) must be close to 1.0`).toBeGreaterThan(0.95)
    expect(ratio).toBeLessThan(1.05)

    // (B) IPC result shape. With a dummy key we expect a "Whisper 401" error,
    // NOT a Node TypeError/ReferenceError from within transcribeCloud.
    const result = ipcResult.ipcResult as {
      ok: boolean
      error?: string
      reason?: string
    } | null

    expect(result, 'IPC must return a result object (not null/undefined)').not.toBeNull()
    expect(result!.ok, 'ok must be false (dummy key → auth failure, not pipeline crash)').toBe(false)

    // The critical distinction: reason='api' + error contains '401' means
    // the pipeline is working and OpenAI rejected our dummy key.
    // Any other exception (reason='network' with a TypeError message like
    // "FormData is not defined" etc.) means there is a code bug.
    const errorText = result!.error ?? ''
    const reason = result!.reason ?? ''

    console.log('[pipeline-probe] Error reason:', reason, '| Error text:', errorText)

    // If reason is 'network' and the error is a TypeError/ReferenceError
    // it means we have a Node runtime bug (FormData/Blob/fetch not defined).
    const isNodeException = reason === 'network' &&
      (errorText.includes('is not defined') ||
       errorText.includes('is not a function') ||
       errorText.includes('TypeError') ||
       errorText.includes('ReferenceError') ||
       errorText.includes('undici') ||
       errorText.includes('fetch is not'))

    expect(
      isNodeException,
      `Pipeline threw a Node exception instead of reaching OpenAI. Error: "${errorText}"`
    ).toBe(false)

    // If reason is 'api' it means we reached OpenAI (dummy key → 401).
    // If reason is 'network' but NOT a Node exception, it means network/TLS
    // failure in the test environment — that's also acceptable (pipeline reached fetch()).
    const reachedOpenAI = reason === 'api' || (reason === 'network' && !isNodeException)
    expect(
      reachedOpenAI,
      `Expected reason='api' (401 from OpenAI) or reason='network' (net failure), got reason='${reason}', error='${errorText}'`
    ).toBe(true)

    if (reason === 'api') {
      expect(errorText, 'API error must mention 401').toContain('401')
    }

  } finally {
    await dispose()
  }
})
