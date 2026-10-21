import { describe, it, expect } from 'vitest'
import { drawTools, toolRegistryProblems } from '../../../src/renderer/src/components/documents/draw/tools/registry'
import { commandRegistryProblems, drawCommands, drawMenus } from '../../../src/renderer/src/components/documents/draw/commands/registry'
import { KEYMAP } from '../../../src/renderer/src/components/documents/draw/commands/keymap'
import { drawPanels } from '../../../src/renderer/src/components/documents/draw/panels/registry'
import { drawDialogs } from '../../../src/renderer/src/components/documents/draw/dialogs/registry'
import { buildMenu } from '../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import type { MenuItem } from '../../../src/renderer/src/components/documents/editor/menuBarKit'
import { blank, harness, rect } from './harness'

describe('registries', () => {
  it('every one of the 25 tools is registered, in toolbox order, with no clashing ids or letters', () => {
    expect(drawTools().map((t) => `${t.id}:${t.key ?? t.shortcutLabel ?? ''}`)).toEqual([
      'select:V',
      'direct:A',
      'lasso:Q',
      'pen:P',
      'curvature:⇧~',
      'addAnchor:+',
      'deleteAnchor:-',
      'anchorConvert:⇧C',
      'scissors:C',
      'knife:',
      'pencil:N',
      'smooth:',
      'pathEraser:',
      'rect:R',
      'roundRect:D',
      'ellipse:O',
      'polygon:U',
      'star:S',
      'line:L',
      'text:T',
      'brush:B',
      'eraser:E',
      'bucket:G',
      'eyedropper:I',
      'hand:H'
    ])
    expect(toolRegistryProblems()).toEqual([])
  })

  it('a duplicate tool id or letter is reported', () => {
    const [a] = drawTools()
    expect(toolRegistryProblems([a, { ...a }])).toEqual([`shortcut "V" is taken by both select and select`, 'tool id "select" is registered 2 times'])
  })

  it('no tool letter is also a keymap binding, and every binding names a real command', () => {
    for (const t of drawTools()) if (t.key) expect(KEYMAP[t.key.toLowerCase()], t.id).toBeUndefined()
    expect(commandRegistryProblems()).toEqual([])
  })

  it('the keymap is written sorted, one binding per line', () => {
    const keys = Object.keys(KEYMAP)
    expect(keys).toEqual([...keys].sort())
  })

  it('panels and dialogs are discovered', () => {
    expect(drawPanels().map((p) => p.id)).toEqual(['inspector', 'anchors', 'layers'])
    expect(drawDialogs().map((d) => d.id).sort()).toEqual(['artboard-size', 'average', 'help', 'simplify'])
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

describe('the menu bar is built from commands, identical to the one it replaced', () => {
  it('has the same menus, items, icons, shortcuts, separators and submenus', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    expect(drawMenus().filter((m) => !m.path.includes('/')).sort((a, b) => a.order - b.order).map((m) => `${m.path}:${m.label}`)).toEqual([
      'file:File',
      'edit:Edit',
      'object:Object',
      'layer:Layer',
      'document:Document',
      'view:View',
      'help:Help'
    ])
    const all = ['file', 'edit', 'object', 'layer', 'document', 'view', 'help'].map((m) => [m, ...describeMenu(buildMenu(h.ed.ctx, m))].join('\n')).join('\n\n')
    expect(all).toBe(
      [
        'file',
        'New artwork|note_add|||',
        'Make a copy|file_copy|||',
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
        '---',
        'Export PNG…|image|||',
        'Export SVG…|polyline|||',
        'Export PDF…|picture_as_pdf|||',
        '---',
        'Rename|edit|||',
        'Version history|history|||',
        'Move to trash|delete|||',
        '',
        'edit',
        'Undo|undo|⌘Z|off|',
        'Redo|redo|⇧⌘Z|off|',
        '---',
        'Select all|select_all|⌘A||',
        'Duplicate|file_copy|⌘D|off|',
        'Delete|delete|⌫|off|',
        '',
        'object',
        'Pathfinder|join_full|>',
        '  Unite||||',
        '  Minus front||||',
        '  Intersect||||',
        '  Exclude||||',
        'Arrange|layers|>',
        '  Bring to front||||',
        '  Bring forward||||',
        '  Send backward||||',
        '  Send to back||||',
        'Align|align_horizontal_center|>',
        '  Left||||',
        '  Center||||',
        '  Right||||',
        '  Top||||',
        '  Middle||||',
        '  Bottom||||',
        'Path|timeline|>',
        '  Join|link|⌘J|off|',
        '  Average…||⌥⌘J|off|',
        '  Average & Join||⌥⇧⌘J|off|',
        '  Simplify…|||off|',
        '  Add Anchor Points|||off|',
        '  Remove Anchor Points|remove||off|',
        '  Cut Path at Selected Anchor Points|content_cut||off|',
        '',
        'layer',
        'New vector layer|shapes|||',
        'New paint layer|brush|||',
        '',
        'document',
        'Artboard size…|aspect_ratio|||',
        'Background|format_color_fill|>',
        '  Transparent||||',
        '  White||||',
        '  Black||||',
        '  Paper||||',
        '---',
        'Meeting|videocam|||',
        '',
        'view',
        'Fit to window|fit_screen|||',
        'Zoom to 100%|zoom_in|||',
        '---',
        'Grid|grid_4x4|||',
        'Snap to edges|straighten|||on',
        '',
        'help',
        'How PlexiiDraw works|help|||'
      ].join('\n')
    )
  })

  it('items enable and check from live state, and every item is off on a read-only drawing that should be', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.key('ArrowRight')
    const edit = describeMenu(buildMenu(h.ed.ctx, 'edit'))
    expect(edit).toContain('Undo|undo|⌘Z||')
    expect(edit).toContain('Duplicate|file_copy|⌘D||')
    const ro = harness({ ...blank([rect('a', 0, 0, 10, 10)]), schemaVersion: 3 })
    const text = ['file', 'edit', 'object', 'layer', 'document'].flatMap((m) => describeMenu(buildMenu(ro.ed.ctx, m))).join('\n')
    for (const off of ['Export PNG…', 'Export SVG…', 'Export PDF…', 'Undo', 'Redo', 'Duplicate', 'Delete', 'Unite', 'Bring to front', 'Left', 'New vector layer', 'New paint layer', 'Artboard size…', 'Transparent']) {
      expect(text, off).toMatch(new RegExp(`(^|\\n)\\s*${off.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|[^|]*\\|[^|]*\\|off\\|`))
    }
  })
})
