// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('renderer dialog hardening', () => {
  it('supports true single-action alerts in the shared accessible prompt', () => {
    const prompt = read('src/renderer/src/components/plexi/PromptDialog.tsx')
    expect(prompt).toContain('alertOnly?: boolean')
    expect(prompt).toContain('req.confirmOnly || req.alertOnly')
    expect(prompt).toContain('!req.alertOnly &&')
  })

  it('does not reintroduce browser-native alert or confirm calls', () => {
    const migrated = [
      'src/renderer/src/components/Footer.tsx',
      'src/renderer/src/components/ShareDialog.tsx',
      'src/renderer/src/components/settings/ApiKeysSection.tsx',
      'src/renderer/src/components/views/WeekTimeGrid.tsx',
      'src/renderer/src/components/widgets/WidgetFrame.tsx',
      'src/renderer/src/components/widgets/streamdeck/StreamDeckAI.tsx'
    ]

    for (const path of migrated) {
      const source = read(path)
      expect(source, path).not.toMatch(/\bwindow\.(?:alert|confirm)\s*\(/)
    }
  })
})
