// The local-AI intro card (both variants: "Local AI is available as a download"
// and "Local AI is now built in") is a notice, so it sits under every dialog.
//
// It was above them: z-225, then z-198 "under modals" (RM-1), which only cleared
// plexi/Modal's z-200. Full-screen dialogs live far lower: MessagesView's at
// z-40, BookTimeDialog and NewNodeDialog at z-50, snippets at z-60, the dashboard
// wizard and MailTagEditor at z-85, and so on up. On a first launch the card
// covered their bottom-centre buttons: the wizard's Skip (dashboardWizard L145
// with the bundled model), the book-time Create (TB-3 with no model). This reads
// every full-screen dialog in the renderer, so the next one added low cannot
// reopen it.
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../../src/renderer/src')

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p))
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}

const zOf = (cls: string): number | null => {
  const m = /(?:^|[\s"'`])z-(?:\[(\d+)\]|(\d+))(?=[\s"'`]|$)/.exec(cls)
  return m ? Number(m[1] ?? m[2]) : null
}

/**
 * A full-screen layer that blocks what is under it AND reads as a dialog: it
 * has a visible backdrop (fb-scrim or a bg-black tint) on itself or on the
 * element just inside it, or the dialog role. Transparent `fixed inset-0`
 * catchers that only close a menu are not dialogs and do not count.
 */
function dialogFloors(): Array<{ where: string; z: number }> {
  const found: Array<{ where: string; z: number }> = []
  for (const f of tsxFiles(ROOT)) {
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/fixed inset-0/.test(line) || /pointer-events-none/.test(line)) return
      const z = zOf(line)
      if (z === null) return
      const near = lines.slice(i, i + 5).join('\n')
      if (/fb-scrim|bg-black\/|role="dialog"|aria-modal/.test(near)) found.push({ where: `${f.slice(ROOT.length + 1)}:${i + 1}`, z })
    })
  }
  return found
}

function introCardZs(): number[] {
  const src = readFileSync(join(ROOT, 'components/LocalAiPrompts.tsx'), 'utf8')
  const lines = src.split('\n')
  const zs: number[] = []
  lines.forEach((line, i) => {
    if (!line.includes('data-testid="local-ai-intro"')) return
    // The card's className is on one of the next few lines.
    const cls = lines.slice(i, i + 4).find((l) => l.includes('className='))
    const z = cls ? zOf(cls) : null
    if (z !== null) zs.push(z)
  })
  return zs
}

describe('local-AI intro card under every dialog', () => {
  it('finds both card variants and a sane set of dialogs', () => {
    expect(introCardZs()).toHaveLength(2)
    // Spot-checks that the scan sees the dialogs the card used to cover.
    const where = dialogFloors().map((d) => d.where).join('\n')
    expect(where).toMatch(/BookTimeDialog\.tsx/)
    expect(where).toMatch(/DashboardWizardOverlay\.tsx/)
    expect(where).toMatch(/ReleaseModal\.tsx/)
  })

  it('both variants sit below the lowest full-screen dialog', () => {
    const floors = dialogFloors()
    const lowest = floors.reduce((a, b) => (b.z < a.z ? b : a))
    for (const z of introCardZs()) {
      expect(z, `intro card z-${z} must be below ${lowest.where} (z-${lowest.z})`).toBeLessThan(lowest.z)
      expect(z).toBeGreaterThan(0)
    }
  })
})
