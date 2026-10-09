// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 2026-10-09 — the chrome pass ───────────────────────────────────────────
//
// Four asks, all of them about the same thing: the chrome had grown a second
// copy of the brand, a standing fact in the bar you act from, two stacked
// controls answering one question, and a primary action that looked like
// furniture.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')
const app = read('src/renderer/src/App.tsx')
const footer = read('src/renderer/src/components/Footer.tsx')
const switcher = read('src/renderer/src/components/WorkspaceSwitcher.tsx')
const sidebar = read('src/renderer/src/components/Sidebar.tsx')
const office = read('src/renderer/src/components/office/PlexiOfficeShell.tsx')
const segment = read('src/renderer/src/components/segment/SegmentShell.tsx')
const overlay = read('src/renderer/src/components/assistant/AssistantOverlay.tsx')
const tray = read('src/renderer/src/components/OpenTray.tsx')
const css = read('src/renderer/src/styles/globals.css')

describe('the titlebar lost its second wordmark and its version badge', () => {
  it('no "2.0" badge and no header lockup', () => {
    expect(app).not.toContain('<PlexiiLogo height={16} />')
    expect(app).not.toMatch(/>\s*2\.0\s*</)
  })

  it('the wordmark still exists where it belongs — the desk menu', () => {
    expect(sidebar).toContain('<PlexiiLogo height={22} />')
  })
})

describe('"Local · encrypted" moved to the footer, beside the version', () => {
  it('it is gone from the titlebar', () => {
    // Assert on the MARKUP, not the phrase — the note left behind in App.tsx
    // names the chip it is explaining, and matching on prose would make this
    // test pass or fail on a comment.
    expect(app).not.toContain('<span>Local · encrypted</span>')
    expect(app).not.toContain("vaultUnlocked ? 'lock_open' : 'lock'")
  })

  it('and present in the footer, still gated on a vault existing', () => {
    expect(footer).toContain('Local · encrypted')
    expect(footer).toContain('vaultMeta?.exists &&')
    expect(footer).toContain('data-testid="footer-trust-chip"')
  })

  it('App still refreshes the vault meta on boot — only the READER moved', () => {
    expect(app).toContain('refreshVaultMeta')
    expect(app).not.toContain('const vaultUnlocked = useVaultStore')
  })
})

describe('workspace and area are one control', () => {
  it('every menu mounts the combined switcher', () => {
    for (const [name, src] of [
      ['sidebar', sidebar],
      ['office shell', office],
      ['segment shell', segment]
    ] as const) {
      expect(src, `${name} mounts WorkspaceSwitcher`).toContain('<WorkspaceSwitcher />')
      expect(src, `${name} no longer mounts OrgSwitcher`).not.toContain('<OrgSwitcher />')
      expect(src, `${name} no longer mounts SegmentSwitcher`).not.toContain('<SegmentSwitcher />')
    }
  })

  it('the trigger states the hierarchy, not two peers', () => {
    expect(switcher).toContain('data-testid="workspace-switcher-trigger"')
    // "<workspace> › <area>"
    expect(switcher).toContain('›')
  })

  it('areas are resolved for the ACTIVE org, so the lock state is never a guess', () => {
    expect(switcher).toContain('computeEntitlement(entInputs')
    expect(switcher).toContain('activeOrgId')
    // Desk is the floor and stays reachable even with its entitlement unset.
    expect(switcher).toContain("a.kind === 'plexidesk' || ent.enabled")
  })

  it('the four areas and their test ids survive the move', () => {
    // The ids are built from a.kind, so assert the template plus every kind
    // that feeds it — that is what keeps `switch-office` addressable.
    expect(switcher).toContain('data-testid={`switch-${a.kind}`}')
    for (const k of ['plexidesk', 'office', 'plexipeople', 'plexibrain']) {
      expect(switcher).toContain(`kind: '${k}'`)
    }
  })
})

describe('the signed-in name is a footer fact, not a titlebar action', () => {
  it('gone from the titlebar', () => {
    expect(app).not.toContain('personDisplayName')
    expect(app).not.toContain('const signOut = useAccountStore')
  })

  it('in the footer, with the sign-out it implies', () => {
    expect(footer).toContain('data-testid="footer-account"')
    expect(footer).toContain('personDisplayName(account')
    expect(footer).toContain('void signOut()')
  })
})

describe('the two floating desk bars became ONE vertical menu', () => {
  const canvas = read('src/renderer/src/components/Canvas.tsx')
  const slot = read('src/renderer/src/components/chrome/HeaderSlot.tsx')
  const menu = read('src/renderer/src/components/desk/DeskContextMenu.tsx')

  it('one header slot, not two', () => {
    // The first attempt put the two bars side by side in the header. That was
    // relocation, not combination, and was corrected.
    expect(app).toContain('id="fb-header-trail"')
    expect(app).not.toContain('id="fb-header-presence"')
  })

  it('the canvas renders the combined menu and no floating bars', () => {
    expect(canvas).toContain('<DeskContextMenu')
    expect(canvas).not.toContain('<CanvasBreadcrumb')
    expect(canvas).not.toContain('<DeskPresenceBar')
  })

  it('the hover-expanding pill is gone from the codebase, not just unmounted', () => {
    // 554 lines whose whole job was revealing the trail on hover. Keeping it
    // around unused would leave two answers to "how do I read the trail".
    expect(() => read('src/renderer/src/components/CanvasBreadcrumb.tsx')).toThrow()
  })

  it('the menu is vertical lists under headings', () => {
    for (const h of ['Where you are', "Who&apos;s here", 'This desk']) {
      expect(menu).toContain(h)
    }
    expect(menu).toContain('data-testid="desk-context-trail"')
    expect(menu).toContain('role="menuitem"')
  })

  it('the trail is still derived from the node tree, work items excluded', () => {
    // Same walk the pill used. A work item is never a place you navigate to.
    expect(menu).toContain("if (cur.kind !== 'work_item') out.unshift(cur)")
  })

  it('every capability the pill carried is still reachable', () => {
    for (const t of [
      'desk-context-home',
      'desk-context-current',
      'desk-context-rename',
      'desk-context-share',
      'desk-context-move',
      'desk-context-new-room'
    ]) {
      expect(menu).toContain(t)
    }
  })

  it('presence keeps its glance — live dots on the trigger', () => {
    // Folding the presence bar into a menu would otherwise trade an
    // at-a-glance fact for a click.
    expect(menu).toContain('data-testid="desk-context-presence-dots"')
    // Same source and same entitlement gate as the bar, so they cannot disagree.
    expect(menu).toContain("useCapabilityEnabled('presence')")
    expect(menu).toContain("pp.location?.kind === 'desk'")
  })

  it('the view switcher stays OUTSIDE the menu', () => {
    // It changes how the desk is drawn, not what the desk is, and it is its own
    // popover — nesting it would recreate the pill's dropdown-in-a-dropdown.
    expect(canvas).toContain('<ViewSelector taskId={activeTaskId} />')
    expect(menu).not.toContain('ViewSelector')
  })

  it('a surface with no header still gets a working control', () => {
    expect(canvas).toContain('fallback={')
    expect(slot).toContain('if (!host) return fallback')
    expect(slot).toContain('MutationObserver')
  })

  it('the trail is defined once and used for both placements', () => {
    expect(canvas).toContain('const deskTrail = !activeTask ? null : (')
    expect((canvas.match(/\{deskTrail\}/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('the Plexii pill is the obvious thing in its corner', () => {
  it('the mark is white — via `color`, which is what the ICON variant reads', () => {
    // letterColor only drives the wordmark's letterforms and is ignored by the
    // icon, which is why the mark stayed accent-coloured on the purple disc.
    expect(overlay).toContain('color="#FFFFFF"')
    const mark = read('src/renderer/src/components/brand/PlexiiMark.tsx')
    expect(mark).toContain('<PlexiMark animated={animating} color={color}')
  })

  it('bigger than the chrome circle it was, and filled with the accent', () => {
    expect(overlay).toContain('h-[52px] w-[52px]')
    expect(overlay).toContain('fb-assistant-pill')
    expect(css).toContain('.fb-assistant-pill')
    expect(css).toMatch(/\.fb-assistant-pill\s*\{[^}]*linear-gradient\(135deg, rgb\(var\(--accent\)\)/)
  })

  it('the halo pulses, and only when motion is welcome', () => {
    expect(css).toContain('@keyframes fb-pill-pulse')
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)')
    // Colour and size are NOT behind the media query — the button must stay
    // findable for someone who has asked for less motion.
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'))
    expect(reduced).not.toContain('linear-gradient')
  })

  it('it sits clear of the open tray, from a FINISHED offset', () => {
    // The tray publishes the offset rather than its height. Adding an authored
    // px to a measured px is what broke the first attempt.
    expect(tray).toContain("'--fb-pill-bottom'")
    expect(tray).toContain('window.innerHeight - top + 14')
    expect(overlay).toContain("bottom: 'var(--fb-pill-bottom, 42px)'")
    expect(overlay).not.toContain('--fb-tray-h')
  })

  it('the tray clears the offset when it is empty, so nothing floats on a gap', () => {
    expect(tray).toContain("root.style.removeProperty(\"--fb-pill-bottom\")")
    expect(tray).toContain('if (!shown) return null')
  })

  it('the secondary action in that corner moved above it, not under it', () => {
    // Rewritten 2026-10-10. This pinned a literal `bottom-[76px]` on the
    // automations button. 76px did clear the pill, but as a fixed offset it
    // landed on the OPEN minimap panel and covered its close button (the WCAG
    // target-size failure), and with the pill hidden it hovered over nothing.
    // The pill now publishes the stack height while it shows — still 76px, the
    // same place — and the button reads it, falling back to clear the open
    // minimap when the pill is gone. The geometry is held by
    // tests/unit/cornerChrome.test.tsx; this keeps the original promise.
    expect(read('src/renderer/src/components/AutomationsFAB.tsx')).toContain(
      "bottom: 'var(--fb-corner-stack-bottom, 120px)'"
    )
    const geometry = read('src/renderer/src/components/assistant/pillGeometry.ts')
    expect(geometry).toContain('PILL_STACK_BOTTOM_PX = PILL_CANVAS_INSET_PX + PILL_SIZE_PX + CORNER_GAP_PX // 76')
    expect(overlay).toContain('pillCornerVars()')
  })
})
