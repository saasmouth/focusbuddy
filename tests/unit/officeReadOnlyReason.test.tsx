// GUARD: one read-only sentence across the six office apps (aggregator ruling,
// 4.3.41).
//
// Before: the shell's bar stamped "not available: this document is read-only"
// over EVERY control's tooltip in a read-only document, while PlexiiDraw's
// commands said "This artwork is read-only." in the menus; and a control whose
// command had a reason of its own (Group: "Select two or more to group") lost
// it in the bar while the menu row kept it. So in read-only the bar and the
// menu disagreed.
//
// The rule asserted here:
//   1. The suite says "This document is read-only." and nothing else, from ONE
//      source: the shell's READ_ONLY_REASON. Any tooltip or menu reason that
//      talks about read-only is exactly that sentence.
//   2. The shell gives it only to an off control with no reason of its own. A
//      control whose command supplies a reason (Draw's pending/gated reason,
//      `barProps` from the OfficeCommand registry) keeps that reason.
//   3. For a command shown in both the bar and a menu, the two say the same.
//
// How rule 2 is observed without trusting the code under test: every tab is
// rendered twice through the REAL ContextBar with the same read-only document.
// Once with the bar read-only (what the person sees), once with the bar NOT
// read-only, which shows each control exactly as its command and its app make
// it -- its own state and its own reason. Pairing the two renders control by
// control says which reasons are the control's own and which the shell added.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Tooltips render their content only on hover; this one keeps it on the DOM so
// the test can read what a hover would show.
vi.mock('../../src/renderer/src/components/Tooltip', () => ({
  default: ({ content, children }: { content: unknown; children: unknown }) => <span data-tip={typeof content === 'string' ? content : ''}>{children as never}</span>
}))
vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

const rec = vi.hoisted(() => ({
  /** Every command a bar control rendered from (`barProps`), by the label it shows. */
  bar: new Map<string, string>(),
  /** Menus as each menu bar handed them to MenuBarShell. */
  menus: {} as Record<string, unknown>
}))

// Tag what the registry adapters produce with the command they came from, so
// a bar control and a menu row can be paired by command id, not by wording.
vi.mock('../../src/renderer/src/lib/menus/officeCommand', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/renderer/src/lib/menus/officeCommand')>()
  return {
    ...real,
    barProps: (c: Parameters<typeof real.barProps>[0]) => {
      rec.bar.set(c.barLabel ?? c.label, c.id)
      return real.barProps(c)
    },
    menuItemOf: (c: Parameters<typeof real.menuItemOf>[0], extra?: Parameters<typeof real.menuItemOf>[1]) => ({ ...real.menuItemOf(c, extra), cmdId: c.id }),
    menuRow: (c: Parameters<typeof real.menuRow>[0], extra?: Parameters<typeof real.menuRow>[1]) => ({ ...real.menuRow(c, extra), cmdId: c.id })
  }
})

vi.mock('../../src/renderer/src/components/documents/editor/menuBarKit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/renderer/src/components/documents/editor/menuBarKit')>()
  return {
    ...real,
    MenuBarShell: ({ menus, testid }: { menus: unknown; testid: string }) => {
      rec.menus[testid] = menus
      return null
    }
  }
})

// Draw's command-bound bar buttons, tagged with the command they run (the real button renders inside).
vi.mock('../../src/renderer/src/components/documents/draw/bar/controls', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/renderer/src/components/documents/draw/bar/controls')>()
  return {
    ...real,
    CmdButton: (p: Parameters<typeof real.CmdButton>[0]) => (
      <span data-cmd={p.id}>
        <real.CmdButton {...p} />
      </span>
    ),
    CmdToggle: (p: Parameters<typeof real.CmdToggle>[0]) => (
      <span data-cmd={p.id}>
        <real.CmdToggle {...p} />
      </span>
    )
  }
})

import { ContextBar, READ_ONLY_REASON, ToolRail, type BarTab, type RailItem } from '../../src/renderer/src/components/office/shell'
import type { MenuDef, MenuItem } from '../../src/renderer/src/components/documents/editor/menuBarKit'
import { documentCommands, menuItemOf, type OfficeCommand } from '../../src/renderer/src/lib/menus/officeCommand'
import { WRITE_TABS, writeRailItems, type WCtx } from '../../src/renderer/src/components/documents/editor/writeRibbon'
import { CELLS_TABS, cellsRailItems, type CCtx } from '../../src/renderer/src/components/documents/sheet/cellsRibbon'
import { DECK_TABS, deckRailItems, type DeckCtx } from '../../src/renderer/src/components/documents/slides/ribbon'
import { DESIGN_TABS, type DesignCtx } from '../../src/renderer/src/components/documents/design/ribbon'
import { designRailItems, type DesignRailCmds } from '../../src/renderer/src/components/documents/design/rail'
import { DIAGRAM_TABS, diagramCtx, diagramRailItems, type DCtx } from '../../src/renderer/src/components/documents/diagram/ribbon'
import { buildDesignCommands, type DesignCommandDeps } from '../../src/renderer/src/components/documents/design/designCommands'
import { buildDeckCommands, type DeckCommandDeps } from '../../src/renderer/src/components/documents/slides/deckCommands'
import { drawBarTabs } from '../../src/renderer/src/components/documents/draw/bar/registry'
import { drawRailItems, type RailCtx } from '../../src/renderer/src/components/documents/draw/render/rail'
import { drawCommands, drawMenus } from '../../src/renderer/src/components/documents/draw/commands/registry'
import { setKeyPlatform } from '../../src/renderer/src/components/documents/draw/commands/keys'
import { buildMenu } from '../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import DocMenuBar from '../../src/renderer/src/components/documents/editor/DocMenuBar'
import SheetMenuBar from '../../src/renderer/src/components/documents/editor/SheetMenuBar'
import SlidesMenuBar from '../../src/renderer/src/components/documents/editor/SlidesMenuBar'
import DesignMenuBar from '../../src/renderer/src/components/documents/editor/DesignMenuBar'
import { normalizeDesignBody } from '../../src/shared/design'
import { resolveTheme } from '../../src/shared/slideThemes'
import type { MapEdge, MapNode, Slide, SlideElement } from '../../src/shared/types'
import { writeCommandsFor } from './_writeCommands'
import { cellsCommandsFor, sheetActionSpies } from './_cellsCommands'
import { blank, harness, rect } from './drawTools/harness'

const SENTENCE = 'This document is read-only.'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  setKeyPlatform('mac')
  ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    api: { platform: 'darwin', documents: { get: vi.fn(), create: vi.fn() } }
  }) as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

// ── Fixtures: each app on a read-only document ───────────────────────────────

const noop = (): void => {}
const anyFn = <T,>(over: Record<string, unknown> = {}): T => new Proxy(over, { get: (t, k) => (k in t ? t[k as string] : noop) }) as T
// Callable and chainable, for the menu bars that read anything off their actions.
const anything = (): unknown => {
  const fn: unknown = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : fn),
    apply: () => fn
  })
  return fn
}
const actions = (fixed: Record<string, unknown>): never => new Proxy(fixed, { get: (t, k) => (k in t ? t[k as string] : anything()) }) as never
const ops = (): never => actions({ id: 'doc-1' })

// Write and Cells: their REAL registries, built read-only (as DocEditor and SheetEditor build them for a viewer).
const fakeEditor = {
  isActive: () => false,
  getAttributes: () => ({}),
  can: () => ({ undo: () => true, redo: () => true }),
  state: { selection: { empty: false } }
} as unknown as Editor
const writeCmds = writeCommandsFor(fakeEditor, { readOnly: true })
const writeCtx = anyFn<WCtx>({ editor: fakeEditor, readOnly: true, pageView: true, styleLabel: 'Normal', sidePane: null, isPanelOpen: () => false, hasTracked: false, commands: writeCmds })
const sheetA = sheetActionSpies()
const cellsCmds = cellsCommandsFor({ a: sheetA, readOnly: true })
const cellsCtx = anyFn<CCtx>({ a: sheetA, readOnly: true, fmt: undefined, activeFont: undefined, isMerged: false, isPanelOpen: () => false, sidePane: null, commands: cellsCmds })

// Deck: a text box selected, then a shape (its contextual tab).
const textEl = { id: 't', type: 'text', x: 0, y: 0, w: 200, h: 60, z: 1, paragraphs: [{ runs: [{ text: 'Hi', fontSize: 24 }] }] } as unknown as SlideElement
const shapeEl = { id: 'sh', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 100, z: 2, fill: '#2563eb' } as unknown as SlideElement
const deckCmds = buildDeckCommands(anyFn<DeckCommandDeps>({ selected: 1, anyGrouped: false, canUndo: true, canRedo: false, canPaste: false, singleSlide: false, textMarks: {} }))
const deckCtx = (el: SlideElement): DeckCtx =>
  anyFn<DeckCtx>({
    slide: { id: 's1', notes: '', layout: 'title-content', elements: [el], transition: 'none', schemaVersion: 2 } as Slide,
    theme: resolveTheme('plexi-default'),
    selected: [el],
    el,
    anyGrouped: false,
    readOnly: true,
    tool: 'select',
    isPanelOpen: () => false,
    sidePane: null,
    ed: anyFn({}),
    cmds: deckCmds
  })

// Design: a text frame selected.
const designCmds = buildDesignCommands(anyFn<DesignCommandDeps>({ selected: 1, grouped: false, canPaste: false, textMarks: {} }))
const designCtx: DesignCtx = {
  cmds: designCmds,
  design: normalizeDesignBody({ width: 794, height: 1123, elements: [textEl] }),
  selected: [textEl],
  first: textEl,
  fonts: ['Inter'],
  palette: ['#000000'],
  cmd: anyFn({}),
  startFrom: null,
  guidesVisible: true,
  facing: false,
  bleed: 0,
  layers: []
} as unknown as DesignCtx

// Diagrams: a shape selected, then a line.
const node = (id: string): MapNode => ({ id, x: 0, y: 0, label: id, shape: 'process', color: '#2563eb' })
const edge: MapEdge = { id: 'e1', from: 'a', to: 'b' } as MapEdge
const diagCtx = (sel: 'node' | 'edge'): DCtx =>
  diagramCtx(
    anyFn({
      cmd: anyFn({ hasStyleClipboard: () => false }),
      page: { nodes: [node('a'), node('b')], edges: [edge] },
      sel: { nodes: new Set(sel === 'node' ? ['a'] : []), edges: new Set(sel === 'edge' ? ['e1'] : []) },
      settings: {},
      themeId: undefined,
      readOnly: true,
      zoom: 1,
      tool: 'select',
      isPanelOpen: () => false,
      sidePane: null
    })
  )

// Draw: a read-only drawing (the host's viewer flag), a text object selected, then a rectangle.
const drawCtx = (what: 'text' | 'rect'): RailCtx => {
  const h = harness(
    blank([{ id: 'tx', type: 'text', x: 0, y: 0, w: 100, text: 'Hi', fontSize: 20, fill: { type: 'solid', color: '#000000' } }, rect('r', 150, 10, 60, 60)]),
    { readOnly: true }
  )
  h.ed.ctx.select([what === 'text' ? 'tx' : 'r'])
  return { ctx: h.ed.ctx, s: h.state(), altHeld: () => false, sidePane: null, toggleAi: noop }
}
/** Draw's bar tabs as DrawStudio maps them onto the shell. */
const drawTabs: BarTab<RailCtx>[] = drawBarTabs().map((t) => {
  const C = t.component
  return { id: t.id, label: t.label, role: t.role, contextual: !!t.when, ...(t.when ? { when: (c: RailCtx) => t.when!(c.s) } : {}), render: (c: RailCtx) => <C ctx={c.ctx} /> }
})

// ── Reading the surfaces ─────────────────────────────────────────────────────

/** What hovering the control shows: its own title, else the Tooltip around it. */
const tipOf = (el: HTMLElement): string =>
  el.getAttribute('title') ?? el.closest('[data-tip]')?.getAttribute('data-tip') ?? el.closest('[title]')?.getAttribute('title') ?? el.getAttribute('aria-label') ?? ''

interface Control {
  tip: string
  off: boolean
  /** The Draw command a button runs, or the registry command it renders from. */
  cmd?: string
  /** That command's label as the bar shows it. */
  label?: string
}

const controlsIn = (scope: Element, registryApp: boolean): Control[] =>
  [...scope.querySelectorAll<HTMLElement>('button, select, input')]
    .filter((el) => !el.closest('[data-testid$="-tab-more"]'))
    .map((el) => {
      const tip = tipOf(el)
      const drawCmd = el.closest<HTMLElement>('[data-cmd]')?.dataset.cmd
      let cmd = drawCmd
      let label: string | undefined
      if (!cmd && registryApp) {
        // The longest label a barProps call rendered that this tooltip begins with.
        let best = ''
        for (const l of rec.bar.keys()) if ((tip === l || tip.startsWith(`${l} — `) || tip.startsWith(`${l} (`)) && l.length > best.length) best = l
        if (best) [cmd, label] = [rec.bar.get(best), best]
      }
      return { tip, off: (el as HTMLButtonElement).disabled, ...(cmd ? { cmd } : {}), ...(label ? { label } : {}) }
    })

/** The tooltip with a trailing key hint " (⌘B)" removed: barTip drops the key when it shows a reason. */
const stripKey = (tip: string): string => tip.replace(/ \([^()]*\)$/, '')
/** What follows the label: the text after the LAST " — " (a label may itself contain one). */
const reasonOf = (tip: string): string | null => (tip.includes(' — ') ? tip.slice(tip.lastIndexOf(' — ') + 3) : null)

interface Verdict {
  stamped: number
  /** Off with the sentence as the command's OWN reason (a registry that gates read-only first). */
  fromCommand: number
  kept: string[]
  checked: number
  wrong: string[]
  /** Bar controls tied to a command, with the document state they were rendered in. */
  pairs: Array<{ cmd: string; label?: string; tip: string; off: boolean; state: number }>
}

/**
 * Pair the read-only render with the bar-not-read-only render of the SAME
 * document, control by control, and check rule 1 and rule 2 on each.
 */
function judge(where: string, state: number, ro: Control[], own: Control[], out: Verdict): void {
  if (ro.length !== own.length) {
    out.wrong.push(`${where}: the two renders differ in shape (${ro.length} vs ${own.length} controls)`)
    return
  }
  ro.forEach((c, i) => {
    const o = own[i]!
    if (c.cmd) out.pairs.push({ cmd: c.cmd, ...(c.label ? { label: c.label } : {}), tip: c.tip, off: c.off, state })
    if (!c.off) return // read-only safe: live in a read-only document, nothing to say
    out.checked++
    const r = reasonOf(c.tip)
    // Rule 1: the only read-only sentence is THE sentence.
    if (/read.only/i.test(c.tip) && r !== SENTENCE) out.wrong.push(`${where}: "${c.tip}" talks about read-only, but not as "${SENTENCE}"`)
    const ownReason = o.off ? reasonOf(o.tip) : null
    if (o.off && c.tip === o.tip && ownReason) {
      // Rule 2: the control's own reason, kept.
      if (ownReason !== SENTENCE) out.kept.push(`${where}: ${c.tip}`)
      else out.fromCommand++
      return
    }
    const is = (label: string): boolean => c.tip === `${label} — ${SENTENCE}`
    if (is(o.tip) || is(stripKey(o.tip))) {
      // The whole of its own tooltip, plus the sentence: it had no reason of its own.
      out.stamped++
      return
    }
    const head = o.tip.split(' — ')[0]!
    if (is(head) || is(stripKey(head))) {
      // Its label, plus the sentence. Right for a live control (what followed
      // the label was a hint, "double-click for options"); wrong for one that
      // was off with a reason: the shell stamped over it.
      if (o.off) out.wrong.push(`${where}: "${o.tip}" is off with its own reason, but the read-only bar says "${c.tip}"`)
      else out.stamped++
      return
    }
    out.wrong.push(`${where}: read-only "${c.tip}" is neither its own reason ("${o.tip}") nor "<label> — ${SENTENCE}"`)
  })
}

interface App {
  name: string
  tabs: BarTab<never>[]
  /** The document states whose tabs are walked (contextual tabs show for their selection). */
  ctxs: unknown[]
  rail: () => RailItem<never>[]
  railCtx: unknown
  registry: boolean
  /** Rows of every menu in that document state, each tagged with the command it renders from. */
  menuRows: (ctx: never) => Array<MenuItem & { kind: 'item'; cmdId?: string }>
  /** Fewest off controls the walk must check (not vacuous). */
  min: number
  /** Fewest controls that keep a reason of their own other than the sentence; 0 only where none exists, with why. */
  minKept: number
  /** Fewest controls whose command itself says the sentence (its registry gates read-only first). */
  minFromCommand: number
}

const flat = (list: MenuItem[]): Array<MenuItem & { kind: 'item'; cmdId?: string }> =>
  list.flatMap((i) => (i.kind === 'item' ? [i] : i.kind === 'submenu' ? flat(i.items) : []))
function captured(testid: string, el: JSX.Element): Array<MenuItem & { kind: 'item'; cmdId?: string }> {
  const h = document.createElement('div')
  const r = createRoot(h)
  act(() => r.render(el))
  act(() => r.unmount())
  const menus = rec.menus[testid] as MenuDef[] | undefined
  expect(menus, `${testid} never reached MenuBarShell`).toBeTruthy()
  return menus!.flatMap((m) => flat(m.build()))
}

// Diagrams builds its menus inside DiagramChrome (React Flow, not mountable
// here; tests/e2e/officeMenus.spec.ts walks them by real clicks). Its registry
// rows are `menuItemOf(c.<name>)` over the same `cmds` the ribbon renders, so
// the rows are rebuilt from those very commands, for the names its source uses.
const DIAGRAM_MENU_NAMES = [...readFileSync(join(__dirname, '../../src/renderer/src/components/documents/diagram/DiagramChrome.tsx'), 'utf8').matchAll(/menu(?:ItemOf|Row)\(c\.(\w+)/g)].map((m) => m[1]!)

const drawMenuRows = (ctx: RailCtx): Array<MenuItem & { kind: 'item'; cmdId?: string }> => {
  // Draw's rows carry no id; the label is unique per command, so tag by it.
  const byLabel = new Map(drawCommands().map((c) => [c.menuLabel?.(ctx.ctx) ?? c.label, c.id]))
  return drawMenus()
    .filter((m) => !m.path.includes('/'))
    .flatMap((m) => flat(buildMenu(ctx.ctx, m.path)))
    .map((row) => ({ ...row, cmdId: byLabel.get(row.label) }))
}

const drawText = drawCtx('text')
const APPS: App[] = [
  {
    name: 'Write',
    tabs: WRITE_TABS as never,
    ctxs: [writeCtx],
    rail: writeRailItems as never,
    railCtx: writeCtx,
    registry: true,
    menuRows: () => captured('doc-menubar', <DocMenuBar commands={writeCmds} doc={documentCommands(ops(), 'doc')} />),
    min: 30,
    minKept: 2, // Accept/Reject all changes: "no tracked changes"
    minFromCommand: 10
  },
  {
    name: 'Cells',
    tabs: CELLS_TABS as never,
    ctxs: [cellsCtx],
    rail: cellsRailItems as never,
    railCtx: cellsCtx,
    registry: true,
    menuRows: () => captured('sheet-menubar', <SheetMenuBar commands={cellsCmds} doc={documentCommands(ops(), 'sheet')} />),
    min: 30,
    // None exists: every Cells command checks read-only FIRST (cellsCommands.ts),
    // so its own reason in a read-only sheet is the sentence itself -- asserted
    // below as command-supplied, not stamped.
    minKept: 0,
    minFromCommand: 20
  },
  {
    name: 'Deck',
    tabs: DECK_TABS as never,
    ctxs: [deckCtx(textEl), deckCtx(shapeEl)],
    rail: deckRailItems as never,
    railCtx: deckCtx(textEl),
    registry: true,
    menuRows: () =>
      captured(
        'slides-menubar',
        <SlidesMenuBar actions={actions({ title: 'Deck', hasSelection: true, canPaste: false, canUndo: true, canRedo: false, slideOps: true, activePage: 0, documentOps: ops(), cmds: deckCmds })} />
      ),
    min: 60,
    minKept: 5, // Group, Ungroup, Distribute: their selection reasons
    minFromCommand: 0
  },
  {
    name: 'Design',
    tabs: DESIGN_TABS as never,
    ctxs: [designCtx],
    rail: designRailItems as never,
    railCtx: anyFn<DesignRailCmds>(),
    registry: true,
    menuRows: () =>
      captured(
        'design-menubar',
        <DesignMenuBar actions={actions({ title: 'Design', hasSelection: true, canPaste: false, canUndo: true, canRedo: false, activePage: 0, cmds: designCmds })} documentOps={ops()} />
      ),
    min: 50,
    minKept: 5, // Align, Distribute, Group, Ungroup: their selection reasons
    minFromCommand: 0
  },
  {
    name: 'Diagrams',
    tabs: DIAGRAM_TABS as never,
    ctxs: [diagCtx('node'), diagCtx('edge')],
    rail: diagramRailItems as never,
    railCtx: diagCtx('node'),
    registry: true,
    menuRows: (ctx: DCtx) => {
      const c = ctx.cmds as unknown as Record<string, OfficeCommand>
      return DIAGRAM_MENU_NAMES.filter((n) => c[n]).map((n) => menuItemOf(c[n]!) as MenuItem & { kind: 'item'; cmdId?: string })
    },
    min: 100,
    minKept: 10, // Group, Align, Distribute, Paste style: their reasons
    minFromCommand: 0
  },
  {
    name: 'Draw',
    tabs: drawTabs as never,
    ctxs: [drawText, drawCtx('rect')],
    rail: drawRailItems as never,
    railCtx: drawText,
    registry: false,
    menuRows: (ctx: RailCtx) => drawMenuRows(ctx),
    min: 100,
    // Draw's commands gate read-only first too; its kept reasons are the
    // stroke controls' "choose a stroke paint first" (Home, nothing to stroke).
    minKept: 4,
    minFromCommand: 50
  }
]

function walk(app: App): Verdict {
  const out: Verdict = { stamped: 0, fromCommand: 0, kept: [], checked: 0, wrong: [], pairs: [] }
  for (const [ci, ctx] of app.ctxs.entries()) {
    for (const tab of app.tabs) {
      if (tab.when && !tab.when(ctx as never)) continue
      const renders = [true, false].map((readOnly) => {
        rec.bar.clear()
        act(() => root.render(<ContextBar testid="bar" tabs={app.tabs} ctx={ctx as never} activeTab={tab.id} onTabChange={noop} readOnly={readOnly} menuBar={null} />))
        const panel = host.querySelector('[data-testid="bar-panel"] [role="toolbar"]')!
        const list = controlsIn(panel, app.registry)
        act(() => root.render(<></>))
        return list
      })
      judge(`${app.name} › ${tab.label}${app.ctxs.length > 1 ? ` (state ${ci + 1})` : ''}`, ci, renders[0]!, renders[1]!, out)
    }
  }
  // The rail, by the same rule.
  const rails = [true, false].map((readOnly) => {
    act(() => root.render(<ToolRail testid="rail" items={app.rail()} ctx={app.railCtx as never} readOnly={readOnly} />))
    const list = controlsIn(host, false)
    act(() => root.render(<></>))
    return list
  })
  judge(`${app.name} › rail`, 0, rails[0]!, rails[1]!, out)
  return out
}

const verdicts = new Map<string, Verdict>()
const verdict = (app: App): Verdict => {
  if (!verdicts.has(app.name)) verdicts.set(app.name, walk(app))
  return verdicts.get(app.name)!
}

describe('the read-only sentence is one string, from one place', () => {
  it('is exactly "This document is read-only."', () => {
    expect(READ_ONLY_REASON).toBe(SENTENCE)
  })

  it('PlexiiDraw\'s gate has no string of its own: it re-exports the shell\'s', async () => {
    const gate = await import('../../src/renderer/src/components/documents/draw/commands/gate')
    expect(gate.READ_ONLY_REASON).toBe(READ_ONLY_REASON)
    const src = readFileSync(join(__dirname, '../../src/renderer/src/components/documents/draw/commands/gate.ts'), 'utf8')
    expect(src).not.toMatch(/READ_ONLY_REASON\s*=/)
  })

  it('no office source writes a read-only sentence of its own', () => {
    // Every tooltip, menu reason and decline says it through READ_ONLY_REASON.
    // Status lines may say it inside a longer sentence ("..., so files can't be
    // placed in it."); a bare restatement is what drifts.
    const roots = ['components/office', 'components/documents', 'lib/menus'].map((d) => join(__dirname, '../../src/renderer/src', d))
    const hits = execFileSync('grep', ['-rnE', "['\"`](This [a-z]+ is read-only\\.|not available: this document is read-only)['\"`]", ...roots], { encoding: 'utf8' }).split('\n').filter(Boolean)
    const where = hits.map((h) => h.replace(/^.*\/src\/renderer\/src\//, '').replace(/:\d+:/, ': '))
    expect(where).toEqual([`components/office/shell/primitives.tsx: export const READ_ONLY_REASON = '${SENTENCE}'`])
  })
})

describe.each(APPS.map((a) => [a.name, a] as const))('%s on a read-only document', (_name, app) => {
  it('every off control with no reason of its own says exactly the sentence; one with its own keeps it', () => {
    const v = verdict(app)
    expect(v.wrong).toEqual([])
    // Not vacuous: plenty of controls were off and were checked.
    expect(v.checked, `${app.name}: off controls checked`).toBeGreaterThanOrEqual(app.min)
    expect(v.stamped, `${app.name}: controls given the sentence`).toBeGreaterThan(0)
  })

  it('a control whose command gives a reason keeps it (the shell does not stamp over it)', () => {
    const v = verdict(app)
    expect(v.kept.length, `${app.name} kept: ${v.kept.join(' | ')}`).toBeGreaterThanOrEqual(app.minKept)
    // Write, Cells and Draw gate read-only first in their commands, so most of
    // their off controls carry the sentence as the command's own reason.
    expect(v.fromCommand, `${app.name}: the sentence supplied by the command itself`).toBeGreaterThanOrEqual(app.minFromCommand)
  })

  it('the menu and the bar give the same reason for the same command', () => {
    const v = verdict(app)
    const byState = app.ctxs.map((c) => app.menuRows(c as never))
    // Rule 1 on the menus too.
    for (const r of byState.flat()) if (typeof r.hint === 'string' && /read.only/i.test(r.hint)) expect(r.hint, `${app.name} menu › ${r.label}`).toBe(SENTENCE)
    const both: string[] = []
    const disagree: string[] = []
    const liveInMenuOnly: string[] = []
    for (const p of v.pairs) {
      const rows = byState[p.state]!
      // By command id; else a hand-written menu row for the same action, by its label.
      const row = rows.find((r) => r.cmdId === p.cmd) ?? (p.label ? rows.find((r) => !r.cmdId && r.label === p.label) : undefined)
      if (!row) continue
      both.push(p.cmd)
      const barReason = p.off ? reasonOf(p.tip) : null
      if (!p.off && row.disabled) disagree.push(`${p.cmd}: bar live, menu off ("${row.hint}")`)
      else if (p.off && row.disabled && barReason !== (row.hint ?? null)) disagree.push(`${p.cmd}: bar "${barReason}", menu "${row.hint}"`)
      else if (p.off && !row.disabled) liveInMenuOnly.push(p.cmd)
    }
    expect(disagree, app.name).toEqual([])
    expect(new Set(both).size, `${app.name}: commands found in both the bar and a menu`).toBeGreaterThanOrEqual(3)
    // A menu row LIVE in a read-only document while the bar is off: pinned in
    // LIVE_IN_MENU_ONLY (below, with why), so it can only shrink, never grow unseen.
    expect([...new Set(liveInMenuOnly)].sort(), `${app.name}: live in the menu, off in the bar`).toEqual(LIVE_IN_MENU_ONLY[app.name] ?? [])
  })
})

// Commands whose menu row is LIVE in a read-only document while the bar has
// the control off with the sentence. Found by this test (4.3.41) and left for
// the apps' owners, because the fix is command wiring, not wording:
//  - Deck, Design and Diagrams build their registries without `readOnly`
//    (deckCommands, designCommands, diagramCommands); their editors refuse the
//    edit when it runs, but the menu offers it. Write and Cells gate it in the
//    registry, so their menus and bars agree on every row.
//  - Some of these only READ the document, and Write and Cells keep them live
//    for a viewer: Check accessibility (sl-a11y), Save selection as snippet…
//    (sl-save-snippet, ds-save-snippet), Copy style (dg-copy-style). Their bar
//    controls lack `readOnlySafe`, so there the BAR is the one that is wrong.
// The list can only shrink: a fix that makes a pair agree must delete its id.
const LIVE_IN_MENU_ONLY: Record<string, string[]> = {
  Deck: ['sl-a11y', 'sl-chart', 'sl-del', 'sl-dup', 'sl-image', 'sl-save-snippet', 'sl-snippet', 'sl-table', 'sl-text', 'sl-widget'],
  Design: ['ds-add-page', 'ds-delete', 'ds-duplicate', 'ds-insert-snippet', 'ds-save-snippet'],
  Diagrams: ['dg-back', 'dg-backward', 'dg-copy-style', 'dg-forward', 'dg-front', 'dg-hide', 'dg-lock']
}
