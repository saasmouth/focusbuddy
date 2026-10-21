// Switching the AI source must tell the renderer that local-AI status changed.
// LocalAiPrompts re-reads status only on 'localAi:changed', so without this
// broadcast its "Local AI needs a one-time download" notice stayed on screen,
// over every editor's toolbar, after the user had chosen a cloud source.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('ai:setMode refreshes local-AI status', () => {
  it('broadcasts localAi:changed after changing the mode', () => {
    const src = readFileSync(join(__dirname, '../../src/main/ipc/index.ts'), 'utf-8')
    const start = src.indexOf("ipcMain.handle('ai:setMode'")
    expect(start).toBeGreaterThan(-1)
    const handler = src.slice(start, src.indexOf('\n  })', start))
    expect(handler.indexOf('setAiMode(mode)')).toBeGreaterThan(-1)
    expect(handler.indexOf("'localAi:changed'")).toBeGreaterThan(handler.indexOf('setAiMode(mode)'))
  })

  it('the notice really does re-check on that event', () => {
    const prompts = readFileSync(join(__dirname, '../../src/renderer/src/components/LocalAiPrompts.tsx'), 'utf-8')
    expect(prompts).toContain('api.onChanged(() => check())')
  })
})
