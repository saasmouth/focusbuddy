// The rules that decide whether an image is shrunk on the way into the Drive.
//
// This replaces what the user gave us and there is no undo, so the interesting
// assertions are the ones about when it must NOT act: an animation it would
// flatten, a vector it would rasterise, a file already small enough, or a
// re-encode that came out bigger than the original.
//
// Both runtimes carry their own encoder -- Electron's nativeImage on the
// desktop, OffscreenCanvas in the browser -- so the policy is duplicated and
// therefore worth pinning in both. This tests the browser copy, which is the
// one with an encoder available under vitest, plus the shared predicate.
import { describe, it, expect } from 'vitest'
import {
  isDownsampleable,
  MAX_EDGE,
  MIN_BYTES_TO_BOTHER
} from '../../src/web/worker/main/imageDownsample'
import * as desktop from '../../src/main/db/imageDownsample'

describe('which files are candidates at all', () => {
  it('accepts the raster formats a desk actually accumulates', () => {
    for (const [mime, ext] of [
      ['image/png', '.png'],
      ['image/jpeg', '.jpg'],
      ['image/jpeg', '.jpeg'],
      ['image/webp', '.webp'],
      ['image/heic', '.heic'],
      ['', '.png']
    ] as const) {
      expect(isDownsampleable(mime, ext), `${mime} ${ext}`).toBe(true)
    }
  })

  it('refuses a GIF, which would lose its animation', () => {
    expect(isDownsampleable('image/gif', '.gif')).toBe(false)
    expect(isDownsampleable('', '.gif')).toBe(false)
  })

  it('refuses an SVG, which is vector and already small', () => {
    expect(isDownsampleable('image/svg+xml', '.svg')).toBe(false)
    expect(isDownsampleable('', '.svg')).toBe(false)
  })

  it('refuses things that are not images', () => {
    for (const [mime, ext] of [
      ['application/pdf', '.pdf'],
      ['video/mp4', '.mp4'],
      ['text/plain', '.txt'],
      ['application/zip', '.zip']
    ] as const) {
      expect(isDownsampleable(mime, ext), mime).toBe(false)
    }
  })

  it('is the same predicate in both runtimes', () => {
    // The two implementations are separate files because their encoders differ, but
    // a file shrunk on one device and not the other would be a difference the
    // user could see.
    for (const [mime, ext] of [
      ['image/png', '.png'],
      ['image/gif', '.gif'],
      ['image/svg+xml', '.svg'],
      ['video/mp4', '.mp4'],
      ['image/jpeg', '.jpg']
    ] as const) {
      expect(desktop.isDownsampleable(mime, ext), mime).toBe(isDownsampleable(mime, ext))
    }
  })

  it('agrees on the thresholds, so a file is treated alike everywhere', () => {
    expect(desktop.MAX_EDGE).toBe(MAX_EDGE)
    expect(desktop.MIN_BYTES_TO_BOTHER).toBe(MIN_BYTES_TO_BOTHER)
    expect(desktop.JPEG_QUALITY).toBe(82)
  })
})

describe('the thresholds themselves', () => {
  it('keeps enough resolution for a retina desk', () => {
    // Small enough to save real space on a phone photo, large enough that a
    // widget blown up full-screen on a Retina display still looks sharp.
    expect(MAX_EDGE).toBeGreaterThanOrEqual(2048)
    expect(MAX_EDGE).toBeLessThanOrEqual(4096)
  })

  it('does not bother with files too small to be worth the loss', () => {
    expect(MIN_BYTES_TO_BOTHER).toBeGreaterThanOrEqual(64 * 1024)
  })
})
