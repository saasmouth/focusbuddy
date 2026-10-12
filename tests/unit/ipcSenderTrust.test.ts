/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { isTrustedIpcSenderUrl } from '../../src/main/ipc/errorBoundary'

describe('IPC sender provenance', () => {
  it('allows only the configured dev origin or packaged renderer entry', () => {
    expect(isTrustedIpcSenderUrl('http://localhost:5173/settings', 'http://localhost:5173')).toBe(true)
    expect(
      isTrustedIpcSenderUrl(
        'file:///Applications/PlexiDesk.app/Contents/Resources/app.asar/out/renderer/index.html',
        undefined
      )
    ).toBe(true)
    expect(isTrustedIpcSenderUrl('https://attacker.example', 'http://localhost:5173')).toBe(false)
    expect(isTrustedIpcSenderUrl('file:///tmp/index.html', undefined)).toBe(false)
    expect(isTrustedIpcSenderUrl('not a url', undefined)).toBe(false)
  })
})
