// Delivered icons that are the app's own glyph, redrawn.
//
// UPDATE 23 Oct 2026: the owner's gradient revision replaced the 22 Oct line
// icons with distinct symbols on tiles, so the history below no longer applies
// to those 63 items; the list keeps guarding every future delivery.
//
// 4.3.41 wired the owner's 22 Oct 2026 delivery into the side menu, and the
// owner then reported Home, Focus, Desks, Rooms, Shared, Trash, People and
// PlexiiBrain as "still missing". The guard was green and every row did wear
// the delivered asset. The cause was the delivery itself: those line icons
// carry exactly the marks of the glyphs the app already drew there
// (components/icons/plexiiIcons.ts, which <Icon> swaps in for the Material
// names). 4.3.40 and 4.3.41 show the same shapes; only the colour and size moved.
//
// scripts/build-plexii-icons.mjs now compares every delivered glyph with the
// app's set and lists the duplicates in PLEXII_ICON_SAME_AS_APP_GLYPH. This
// holds that list to the one below, so a re-delivery that is again the old
// picture, or a new item that duplicates one, fails here, in review, rather
// than in front of the owner. When the owner supplies new art for an item it
// drops off the generated list; remove it here in the same change.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INDEX = join(process.cwd(), 'src/renderer/src/lib/plexiiIconAssets.generated.ts')

function sameArt(): Record<string, string> {
  const src = readFileSync(INDEX, 'utf8')
  const block = src.slice(src.indexOf('export const PLEXII_ICON_SAME_AS_APP_GLYPH'))
  const body = block.slice(block.indexOf('{') + 1, block.indexOf('\n}'))
  return Object.fromEntries([...body.matchAll(/'([^']+)': '([^']+)'/g)].map((m) => [m[1], m[2]]))
}

/**
 * Declared: delivered asset -> the app glyph it duplicates (build of 23 Oct 2026,
 * after the owner's gradient revision). None of the revision's 63 items is here:
 * every one is a distinct symbol on a tile. What remains are older line icons in
 * Tools and Work-Widgets, outside that revision; they are listed for the owner.
 */
const DECLARED: Record<string, string> = {
  'tools/all-tasks': 'tasks',
  'tools/collaborations': 'people',
  'tools/flows': 'flow',
  'tools/organisation': 'org',
  'tools/people-map': 'people',
  'tools/projects': 'plans',
  'tools/search': 'search',
  'tools/shared-with-me': 'shared',
  'widgets/agent': 'agents',
  'widgets/image-generation': 'ai',
  'widgets/note': 'docs',
  'widgets/stream-deck': 'all-desks'
}

describe('delivered glyphs that duplicate an app glyph', () => {
  it('the build lists exactly the declared duplicates', () => {
    expect(sameArt()).toEqual(DECLARED)
  })

  it('the 23 Oct gradient revision duplicates no app glyph (zero matches)', () => {
    const list = sameArt()
    const src = readFileSync(INDEX, 'utf8')
    const revisionCats = ['side-menu', 'focus-filters', 'section-headers', 'people', 'plexiibrain', 'bring-in', 'areas', 'onboarding', 'suite', 'home-actions']
    const revision = [
      ...[...src.matchAll(/^ {2}'([a-z-]+)\/([a-z0-9-]+)': \{/gm)].filter((m) => revisionCats.includes(m[1])).map((m) => `${m[1]}/${m[2]}`),
      'apps/plexiichat', 'widgets/app-launcher', 'widgets/attention', 'widgets/browser', 'widgets/custom-block',
      'widgets/custom-work-widget', 'widgets/markdown', 'widgets/minimap', 'widgets/task-link'
    ]
    expect(revision).toHaveLength(63)
    expect(revision.filter((k) => k in list)).toEqual([])
  })
})
