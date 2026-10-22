// Delivered icons that are the app's own glyph, redrawn.
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

/** Declared: delivered asset -> the app glyph it duplicates (build of 23 Oct 2026). */
const DECLARED: Record<string, string> = {
  'areas/office-area': 'office',
  'areas/people-area': 'people',
  'areas/recent': 'clock',
  'areas/starred': 'star',
  'areas/templates': 'templates',
  'onboarding/body-doubling': 'people',
  'onboarding/connected-office-files': 'docs',
  'onboarding/rooms-desks-and-plans': 'rooms',
  'onboarding/welcome-to-plexiidesk': 'ai',
  'people/directory': 'directory',
  'people/people-home': 'people',
  'plexiibrain/agents': 'agents',
  'plexiibrain/apis': 'api',
  'plexiibrain/ask-plexiibrain': 'chat',
  'plexiibrain/assemble-a-desk': 'assemble',
  'plexiibrain/connect': 'connect',
  'plexiibrain/decisions': 'decisions',
  'plexiibrain/ops': 'flow',
  'plexiibrain/plexiibrain-home': 'brain',
  'plexiibrain/plexiibrain-map': 'graph',
  'section-headers/apps': 'all-desks',
  'section-headers/connected-apps': 'connect',
  'section-headers/people': 'people',
  'side-menu/all-desks': 'all-desks',
  'side-menu/desks': 'desks',
  'side-menu/home': 'home',
  'side-menu/manage-organisation': 'org',
  'side-menu/new-desk': 'new',
  'side-menu/rooms': 'rooms',
  'side-menu/trash': 'trash',
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

  it('names the owner report of 23 Oct 2026: these menu places show the picture they showed before 4.3.41', () => {
    const list = sameArt()
    for (const key of [
      'side-menu/home',
      'side-menu/rooms',
      'side-menu/desks',
      'side-menu/trash',
      'tools/shared-with-me',
      'section-headers/people',
      'areas/people-area',
      'plexiibrain/plexiibrain-home'
    ]) {
      expect(list[key], key).toBeTruthy()
    }
    // Focus was the one new drawing among them (a target where the bell was).
    expect(list['side-menu/focus']).toBeUndefined()
  })
})
