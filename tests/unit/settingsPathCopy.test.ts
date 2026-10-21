// User-facing text must send people to places in Settings that exist.
//
// The help-centre writer found copy telling people to open "Settings → Local
// AI", next to the "Your OpenAI key" AI source. There is no such place: the
// on-device model and its Feature by feature list live under Settings › AI ›
// Local on this device (LocalAiSection, rendered by ApiKeysSection on the AI
// tab). The same sweep found "Settings → API Keys" (there is no API Keys tab;
// the keys are under Settings › AI · API keys), "Voice settings" and
// "Settings → Workspace path" (no such control exists in the renderer).
//
// This scans every source file under src/ for those dead paths, so the next
// string that names one fails here rather than in front of a customer.
// changelog.ts is skipped: release notes describe history, and the 4.3.40
// entry already names the corrected location.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../..')
const SRC = join(root, 'src')

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// A settings path, allowing for the arrow styles the app uses and for JSX
// wrapping the words onto the next line.
const SEP = String.raw`\s*(?:→|›|>|&gt;|->|·)\s*`
const DEAD_PATHS: Array<{ name: string; re: RegExp }> = [
  { name: 'Settings → Local AI', re: new RegExp(`Settings${SEP}Local\\s+AI`) },
  { name: 'Settings → API Keys', re: new RegExp(`Settings${SEP}API\\s+Keys`) },
  { name: 'Voice settings', re: /\bVoice settings\b/ },
  { name: 'Settings → Workspace path', re: new RegExp(`Settings${SEP}Workspace\\s+path`) }
]

describe('settings paths in user-facing copy', () => {
  const sources = files(SRC).filter((f) => !f.endsWith('changelog.ts'))

  it('scans the real source tree', () => {
    expect(sources.length).toBeGreaterThan(500)
  })

  for (const { name, re } of DEAD_PATHS) {
    it(`no string sends people to "${name}"`, () => {
      const hits = sources.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))
      expect(hits).toEqual([])
    })
  }

  it('the OpenAI source note names the real location of Feature by feature', () => {
    const src = readFileSync(join(SRC, 'renderer/src/components/settings/ApiKeysSection.tsx'), 'utf8')
    const start = src.indexOf('data-testid="ai-openai-note"')
    expect(start).toBeGreaterThan(-1)
    const note = src.slice(start, src.indexOf('</div>', start)).replace(/\s+/g, ' ')
    expect(note).toContain('Settings › AI › Local on this device › Feature by feature')
  })

  it('that location exists: LocalAiSection renders both headings and ApiKeysSection renders it on the AI tab', () => {
    const local = readFileSync(join(SRC, 'renderer/src/components/settings/LocalAiSection.tsx'), 'utf8')
    expect(local).toContain('>Local on this device</div>')
    expect(local).toContain('>Feature by feature</div>')
    const keys = readFileSync(join(SRC, 'renderer/src/components/settings/ApiKeysSection.tsx'), 'utf8')
    expect(keys).toContain('<LocalAiSection />')
    const panel = readFileSync(join(SRC, 'renderer/src/components/SettingsPanel.tsx'), 'utf8')
    expect(panel).toMatch(/\{tab === 'ai' && \(\s*<>\s*<ApiKeysSection \/>/)
  })
})
