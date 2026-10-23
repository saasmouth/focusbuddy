import { beforeEach, describe, it, expect } from 'vitest'
import { drawTools, toolRegistryProblems } from '../../../src/renderer/src/components/documents/draw/tools/registry'
import { commandRegistryProblems, drawCommands, drawMenus } from '../../../src/renderer/src/components/documents/draw/commands/registry'
import { KEYMAP } from '../../../src/renderer/src/components/documents/draw/commands/keymap'
import { setKeyPlatform, toolKeyString } from '../../../src/renderer/src/components/documents/draw/commands/keys'
import { drawPanels } from '../../../src/renderer/src/components/documents/draw/panels/registry'
import { drawBarTabs } from '../../../src/renderer/src/components/documents/draw/bar/registry'
import { drawDialogs } from '../../../src/renderer/src/components/documents/draw/dialogs/registry'
import { buildMenu } from '../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import type { MenuItem } from '../../../src/renderer/src/components/documents/editor/menuBarKit'
import { blank, harness, rect, withDocument } from './harness'

describe('registries', () => {
  it('every one of the 29 tools is registered, in toolbox order, with no clashing ids or letters', () => {
    // Hidden tools are modes a command switches to (the Place cursor), not toolbox buttons.
    expect(drawTools().filter((t) => t.hidden).map((t) => t.id)).toEqual(['place'])
    expect(drawTools().filter((t) => !t.hidden).map((t) => `${t.id}:${t.key ?? ''}`)).toEqual([
      'select:V',
      // Group Selection has no default letter, as in Illustrator.
      'groupSelect:',
      'direct:A',
      'lasso:Q',
      'pen:P',
      'curvature:Shift+`',
      'addAnchor:+',
      'deleteAnchor:-',
      'anchorConvert:Shift+C',
      'scissors:C',
      'knife:',
      'pencil:N',
      'smooth:',
      'pathEraser:',
      'join:',
      'rect:M',
      'roundRect:',
      'ellipse:L',
      'polygon:',
      'star:',
      'line:\\',
      'text:T',
      'rotate:R',
      'reflect:O',
      'scale:S',
      'shear:',
      'reshape:',
      'freeTransform:E',
      'brush:B',
      'eraser:Shift+E',
      'bucket:K',
      'eyedropper:I',
      'artboard:Shift+O',
      'hand:H'
    ])
    expect(toolRegistryProblems()).toEqual([])
  })

  it('a duplicate tool id or letter is reported', () => {
    const [a] = drawTools()
    expect(toolRegistryProblems([a, { ...a }])).toEqual([`shortcut "V" is taken by both select and select`, 'tool id "select" is registered 2 times'])
  })

  it('no tool key is also a keymap binding, and every binding names a real command', () => {
    for (const t of drawTools()) {
      const k = toolKeyString(t.key)
      if (k) expect(KEYMAP[k], t.id).toBeUndefined()
    }
    expect(commandRegistryProblems()).toEqual([])
  })

  it('the keymap is written sorted, one binding per line', () => {
    const keys = Object.keys(KEYMAP)
    expect(keys).toEqual([...keys].sort())
  })

  it('panels and dialogs are discovered', () => {
    // Overlay panels (the rail's bottom buttons); the inspector, Transform, Align and
    // Anchor points panels became top-bar tabs (bar/*.tab.tsx).
    expect(drawPanels().map((p) => p.id)).toEqual(['layers', 'artboards'])
    expect(drawBarTabs().map((t) => t.id)).toEqual(['home', 'object', 'align', 'type', 'shape', 'brush', 'anchors', 'path', 'group', 'image', 'artboard'])
    expect(drawDialogs().map((d) => d.id).sort()).toEqual([
      'artboard-options',
      'artboard-rearrange',
      'artboard-size',
      'average',
      'export-artboards',
      'help',
      'import-report',
      'keyboard-shortcuts',
      'place-pdf-page',
      'save-snippet',
      'simplify',
      'snippet-library',
      'transform-each',
      'transform-move',
      'transform-reflect',
      'transform-rotate',
      'transform-scale',
      'transform-shear'
    ])
  })

  it('every command\'s enabled() is pure: same answer twice, no state change', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    const before = h.state()
    for (const c of drawCommands()) {
      if (!c.enabled) continue
      expect(c.enabled(h.ed.ctx), c.id).toBe(c.enabled(h.ed.ctx))
    }
    expect(h.state()).toBe(before)
  })
})

/** A menu as plain text: `label|icon|shortcut|disabled|active` per item, '---' for separators, submenus indented. */
function describeMenu(items: MenuItem[], indent = ''): string[] {
  return items.flatMap((it) => {
    if (it.kind === 'sep') return [`${indent}---`]
    if (it.kind === 'submenu') return [`${indent}${it.label}|${it.icon ?? ''}|>`, ...describeMenu(it.items, `${indent}  `)]
    return [`${indent}${it.label}|${it.icon ?? ''}|${it.shortcut ?? ''}|${it.disabled ? 'off' : ''}|${it.active ? 'on' : ''}`]
  })
}

// The menus as Phase 0 built them, plus WP-KEYS: Illustrator's keys shown
// from the keymap (on a Mac here), Deselect, Keyboard shortcuts…, and the
// Transform again stand-in on ⌘D.
describe('the menu bar is built from commands', () => {
  beforeEach(() => setKeyPlatform('mac'))

  it('has the same menus, items, icons, shortcuts, separators and submenus', () => {
    // A drawing, as a document host mounts it (its document commands on).
    const h = withDocument(harness(blank([rect('a', 0, 0, 10, 10)])))
    expect(drawMenus().filter((m) => !m.path.includes('/')).sort((a, b) => a.order - b.order).map((m) => `${m.path}:${m.label}`)).toEqual([
      'file:File',
      'edit:Edit',
      'object:Object',
      'layer:Layer',
      'document:Document',
      'view:View',
      'window:Window',
      'help:Help'
    ])
    const all = ['file', 'edit', 'object', 'layer', 'document', 'view', 'window', 'help'].map((m) => [m, ...describeMenu(buildMenu(h.ed.ctx, m))].join('\n')).join('\n\n')
    expect(all).toBe(
      [
        'file',
        'New artwork|note_add|⌘N||',
        'Open SVG…|folder_open|⌘O||',
        // Off: a drawing saves as you work. On only in a host that saves on request (a snippet edit session).
        'Save|save|⌘S|off|',
        'Make a copy|file_copy|⌥⌘S||',
        '---',
        'New from preset|aspect_ratio|>',
        '  Square canvas — 2048×2048||||',
        '  Landscape — 1920×1080||||',
        '  Portrait — 1080×1350||||',
        '  Wide (4K) — 3840×2160||||',
        '  A4 at 150dpi — 1240×1754||||',
        '  US Letter at 150dpi — 1275×1650||||',
        '  Poster A3 at 150dpi — 1754×2480||||',
        '  Web banner — 1600×500||||',
        '  Social post — 1080×1080||||',
        '  Story / Reel — 1080×1920||||',
        '  App icon — 1024×1024||||',
        '  Logo mark — 512×512||||',
        'Place…|add_photo_alternate|⇧⌘P||',
        'Place as template…|layers|||',
        'Import SVG…|polyline|||',
        'Replace image…|swap_horiz||off|',
        '---',
        'Download|download|>',
        '  PNG image (.png)…|image|||',
        '  SVG vector (.svg)…|polyline|||',
        '  PDF document (.pdf)…|picture_as_pdf|||',
        '---',
        'Rename|edit|||',
        'Version history|history|||',
        '---',
        'Move to Trash|delete|||',
        '',
        'edit',
        'Undo|undo|⌘Z|off|',
        'Redo|redo|⇧⌘Z|off|',
        '---',
        'Cut|content_cut|⌘X|off|',
        'Copy|content_copy|⌘C|off|',
        'Paste|content_paste|⌘V||',
        'Paste in Front|flip_to_front|⌘F||',
        'Paste in Back|flip_to_back|⌘B||',
        'Paste in Place|place_item|⇧⌘V||',
        'Paste on All Artboards|dashboard|⌥⇧⌘V||',
        'Copy As|content_copy|>',
        '  SVG Code|code||off|',
        'Duplicate|file_copy||off|',
        'Delete|delete|⌫|off|',
        '---',
        'Select all|select_all|⌘A||',
        'Deselect|deselect|⇧⌘A|off|',
        'Select all on active artboard|select_all|⌥⌘A||',
        '---',
        'Save selection as snippet…|bookmark_add||off|',
        'Insert snippet…|bookmarks|||',
        '',
        'object',
        'Transform|transform|>',
        '  Transform Again|repeat|⌘D|off|',
        '  Move…||⇧⌘M|off|',
        '  Rotate…|||off|',
        '  Reflect…|||off|',
        '  Scale…|||off|',
        '  Shear…|||off|',
        '  Transform Each…||⌥⇧⌘D|off|',
        '  Reset Bounding Box|||off|',
        '  Flip Horizontal|flip||off|',
        '  Flip Vertical|flip||off|',
        '---',
        'Pathfinder|join_full|>',
        '  Unite||||',
        '  Minus front||||',
        '  Intersect||||',
        '  Exclude||||',
        'Arrange|layers|>',
        '  Bring to front||⇧⌘]|off|',
        '  Bring forward||⌘]|off|',
        '  Send backward||⌘[|off|',
        '  Send to back||⇧⌘[|off|',
        'Align|align_horizontal_center|>',
        '  Left|||off|',
        '  Center|||off|',
        '  Right|||off|',
        '  Top|||off|',
        '  Middle|||off|',
        '  Bottom|||off|',
        '  Vertical distribute top|||off|',
        '  Vertical distribute center|||off|',
        '  Vertical distribute bottom|||off|',
        '  Horizontal distribute left|||off|',
        '  Horizontal distribute center|||off|',
        '  Horizontal distribute right|||off|',
        '  Vertical distribute space|||off|',
        '  Horizontal distribute space|||off|',
        '  Align to selection||||on',
        '  Align to key object||||',
        '  Align to artboard||||',
        'Path|timeline|>',
        '  Join|link|⌘J|off|',
        '  Average…||⌥⌘J|off|',
        '  Average & Join||⌥⇧⌘J|off|',
        '  Simplify…|||off|',
        '  Add Anchor Points|||off|',
        '  Remove Anchor Points|remove||off|',
        '  Cut Path at Selected Anchor Points|content_cut||off|',
        '  Close path|||off|',
        '  Open path|||off|',
        '  Reverse path direction|||off|',
        '  Join into one path|||off|',
        '---',
        'Group|group_work|⌘G|off|',
        'Ungroup|workspaces|⇧⌘G|off|',
        '---',
        'Lock|lock|>',
        '  Selection||⌘2|off|',
        '  All artwork above|||off|',
        '  Other layers|||off|',
        'Unlock all|lock_open|⌥⌘2|off|',
        'Hide|visibility_off|>',
        '  Selection||⌘3|off|',
        '  All artwork above|||off|',
        '  Other layers|||off|',
        'Show all|visibility|⌥⌘3|off|',
        '---',
        'Clipping Mask|crop|>',
        '  Make||⌘7|off|',
        '  Release||⌥⌘7|off|',
        '  Edit mask|||off|',
        '  Edit contents|||off|',
        'Compound Path|join_left|>',
        '  Make||⌘8|off|',
        '  Release||⌥⇧⌘8|off|',
        '  Non-zero winding fill rule|||off|',
        '  Even-odd fill rule|||off|',
        '---',
        'Isolate selected group|center_focus_strong||off|',
        'Exit isolation mode|filter_center_focus||off|',
        '---',
        'Artboards|dashboard_customize|>',
        '  New Artboard|add_box|||',
        '  Duplicate Artboard|library_add|||',
        '  Delete Artboard|delete||off|',
        '  Rename…|edit|||',
        '  Artboard Options…|tune|||',
        '  Fit to Artwork Bounds|fit_screen|||',
        '  Fit to Selected Art|crop_free||off|',
        '  Convert to Artboards|transform||off|',
        '  Rearrange All Artboards…|grid_view||off|',
        '',
        'layer',
        'New vector layer|shapes|⌘L||',
        'New paint layer|brush|||',
        '',
        'document',
        'Artboard size…|aspect_ratio|⌥⌘P||',
        'Background|format_color_fill|>',
        '  Transparent||||',
        '  White||||',
        '  Black||||',
        '  Paper||||',
        '---',
        'Meeting|videocam|||',
        '',
        'view',
        'Fit Artboard in Window|fit_screen|⌘0||',
        'Fit All in Window|zoom_out_map|⌥⌘0||',
        'Zoom to Selection|center_focus_weak||off|',
        'Zoom to 100%|zoom_in|⌘1||',
        'Next Artboard|navigate_next||off|',
        'Previous Artboard|navigate_before||off|',
        'Hide Artboards|select_all|⇧⌘H||',
        '---',
        "Grid|grid_4x4|⌘'||",
        'Snap to edges|straighten|⌘U||on',
        '',
        'window',
        'Layers|layers|F7||',
        'Artboards|dashboard|||',
        '---',
        'Move focus: canvas, top bar, tools|keyboard_tab|⌥F6|off|',
        'Next tool in group|switch_access_shortcut||off|',
        '',
        'help',
        'Keyboard shortcuts|keyboard|⌥⇧⌘K||',
        '---',
        'How PlexiiDraw works|help|F1||'
      ].join('\n')
    )
  })

  it('items enable and check from live state, and every item is off on a read-only drawing that should be', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.key('ArrowRight')
    const edit = describeMenu(buildMenu(h.ed.ctx, 'edit'))
    expect(edit).toContain('Undo|undo|⌘Z||')
    expect(edit).toContain('Duplicate|file_copy|||')
    expect(edit).toContain('Deselect|deselect|⇧⌘A||')
    // Something selected: the transform commands come on; Transform Again needs a transform first.
    const object = describeMenu(buildMenu(h.ed.ctx, 'object'))
    expect(object).toContain('  Move…||⇧⌘M||')
    expect(object).toContain('  Transform Again|repeat|⌘D||')
    expect(object).toContain('  Left||||')
    expect(object).toContain('  Reset Bounding Box|||off|')
    const ro = harness({ ...blank([rect('a', 0, 0, 10, 10)]), schemaVersion: 3 })
    const text = ['file', 'edit', 'object', 'layer', 'document'].flatMap((m) => describeMenu(buildMenu(ro.ed.ctx, m))).join('\n')
    for (const off of ['Place…', 'Import SVG…', 'Place as template…', 'Replace image…', 'PNG image (.png)…', 'SVG vector (.svg)…', 'PDF document (.pdf)…', 'Undo', 'Redo', 'Cut', 'Paste', 'Paste in Front', 'Paste in Back', 'Paste in Place', 'Paste on All Artboards', 'Duplicate', 'Delete', 'Transform Again', 'Move…', 'Rotate…', 'Flip Horizontal', 'Unite', 'Bring to front', 'Left', 'New vector layer', 'New paint layer', 'Artboard size…', 'Transparent']) {
      expect(text, off).toMatch(new RegExp(`(^|\\n)\\s*${off.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|[^|]*\\|[^|]*\\|off\\|`))
    }
  })
})
