import { useEffect, useMemo, useState } from 'react'
import type { MapArrowHead, MapConditionalRule, MapEdge, MapNode, MapNodeStyle, MapRouting, MapStrokeDash } from '@shared/types'
import type { FbTable } from '@shared/fields'
import { SHAPES, SHAPE_CATEGORIES, getShape } from '@shared/diagram/shapes'
import { nodeSize } from '@shared/diagram/geom'
import { THEMES, getTheme, resolveEdgeStyle, resolveNodeStyle } from '@shared/diagram/style'
import { ARROW_HEADS, arrowHeadPath } from '@shared/diagram/arrowheads'
import type { Graph, Sel } from '@shared/diagram/ops'
import { useTablesStore } from '../../../stores/tables'
import { cellText, primaryColumn } from '@shared/diagram/data'
import Icon from '../../Icon'
import type { Commands } from './commands'
import { ColorField, IconBtn, NumberField, Row, Section, Select, Toggle } from './ui'
import { ICON_NAMES } from './iconNames'

// The right-hand inspector. It adapts to the selection: page settings when
// nothing is selected, shape style/text/arrange/data for shapes, and line
// settings for connectors (both when the selection is mixed). Every control
// writes through a command, so it is undoable like any other edit.

const FONTS = [
  { value: 'Inter, -apple-system, "Segoe UI", system-ui, sans-serif', label: 'Inter (system)' },
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: '"Helvetica Neue", Helvetica, sans-serif', label: 'Helvetica' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { value: '"Trebuchet MS", sans-serif', label: 'Trebuchet' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: '"Times New Roman", Times, serif', label: 'Times' },
  { value: '"SF Mono", Menlo, Consolas, monospace', label: 'Monospace' },
  { value: '"Comic Sans MS", "Comic Neue", cursive', label: 'Handwritten' }
]

const DASHES: { value: MapStrokeDash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'dashdot', label: 'Dash-dot' },
  { value: 'none', label: 'None' }
]

const ARROW_LABEL: Record<MapArrowHead, string> = {
  none: 'None',
  arrow: 'Arrow',
  open: 'Open arrow',
  triangle: 'Hollow triangle',
  diamond: 'Filled diamond',
  diamondOpen: 'Hollow diamond',
  circle: 'Filled circle',
  circleOpen: 'Hollow circle',
  bar: 'Bar',
  crowOne: 'One (ERD)',
  crowMany: 'Many (ERD)',
  crowOneOrMany: 'One or many (ERD)',
  crowZeroOrOne: 'Zero or one (ERD)',
  crowZeroOrMany: 'Zero or many (ERD)'
}

// Value shared by every item, or undefined when mixed.
function common<T, V>(items: T[], f: (t: T) => V): V | undefined {
  if (!items.length) return undefined
  const v = f(items[0]!)
  return items.every((i) => JSON.stringify(f(i)) === JSON.stringify(v)) ? v : undefined
}

export function Inspector({ cmd, page, sel, settings, readOnly }: { cmd: Commands; page: Graph; sel: Sel; settings: import('@shared/types').MapSettings; readOnly: boolean }): JSX.Element {
  const nodes = useMemo(() => page.nodes.filter((n) => sel.nodes.has(n.id)), [page.nodes, sel.nodes])
  const edges = useMemo(() => page.edges.filter((e) => sel.edges.has(e.id)), [page.edges, sel.edges])
  const [tab, setTab] = useState<'style' | 'text' | 'arrange' | 'data'>('style')
  const theme = getTheme(settings.theme)

  const heading = nodes.length || edges.length
    ? [nodes.length ? `${nodes.length} shape${nodes.length === 1 ? '' : 's'}` : '', edges.length ? `${edges.length} line${edges.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
    : 'Page'

  return (
    <div className="h-full w-[284px] flex flex-col border-l border-[var(--edge-soft)] bg-[var(--surface-raised)]" data-testid="diagram-inspector">
      <div className="shrink-0 px-3 py-2 border-b border-[var(--edge-soft)] flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: nodes.length || edges.length ? '#2563eb' : 'var(--ink-30)' }} />
        <span className="text-[12px] font-semibold text-[var(--ink-90)]" data-testid="diagram-inspector-heading">
          {heading}
        </span>
        {nodes.length === 1 && <span className="text-[11px] text-[var(--ink-50)] truncate">{getShape(nodes[0]!.shape).label}</span>}
      </div>
      {nodes.length > 0 && (
        <div className="shrink-0 flex px-2 pt-1.5 gap-0.5 border-b border-[var(--edge-soft)]">
          {(['style', 'text', 'arrange', 'data'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              data-testid={`diagram-inspector-tab-${t}`}
              className={`flex-1 h-7 text-[11px] capitalize rounded-t ${tab === t ? 'text-[var(--ink-90)] font-semibold border-b-2 border-[#2563eb]' : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'}`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <div className={`flex-1 min-h-0 overflow-y-auto ${readOnly ? 'pointer-events-none opacity-60' : ''}`}>
        {nodes.length > 0 && tab === 'style' && <ShapeStyle cmd={cmd} nodes={nodes} themeId={settings.theme} palette={theme.palette} />}
        {nodes.length > 0 && tab === 'text' && <TextStyle cmd={cmd} nodes={nodes} themeId={settings.theme} palette={theme.palette} />}
        {nodes.length > 0 && tab === 'arrange' && <Arrange cmd={cmd} nodes={nodes} />}
        {nodes.length > 0 && tab === 'data' && <DataTab cmd={cmd} nodes={nodes} />}
        {edges.length > 0 && <LineStyle cmd={cmd} edges={edges} themeId={settings.theme} palette={theme.palette} defaultEnd={settings.defaultEndArrow ?? 'arrow'} defaultRouting={settings.defaultRouting ?? 'orthogonal'} />}
        {!nodes.length && !edges.length && <PageSettings cmd={cmd} page={page} settings={settings} />}
      </div>
    </div>
  )
}

// ── shapes ──────────────────────────────────────────────────────────────────

function ShapeStyle({ cmd, nodes, themeId, palette }: { cmd: Commands; nodes: MapNode[]; themeId?: string; palette: string[] }): JSX.Element {
  const res = nodes.map((n) => resolveNodeStyle(n, themeId))
  const st = <K extends keyof MapNodeStyle>(k: K): MapNodeStyle[K] | undefined => common(nodes, (n) => n.style?.[k])
  const one = nodes.length === 1 ? nodes[0]! : null
  const def = one ? getShape(one.shape) : null
  return (
    <>
      <Section title="Fill & line">
        <Row label="Colour">
          <ColorField value={common(nodes, (n) => n.color)} onChange={(v) => v && cmd.setNodes({ color: v })} palette={palette} testid="diagram-color" title="Shape colour (line + tint)" />
          <span className="text-[10px] text-[var(--ink-40)]">tints fill & line</span>
        </Row>
        <Row label="Fill">
          <ColorField value={st('fill')} onChange={(v) => cmd.setStyle({ fill: v })} palette={palette} allowNone testid="diagram-fill" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={common(res, (r) => r.fillOpacity) ?? 1}
            onChange={(e) => cmd.setStyle({ fillOpacity: Number(e.target.value) }, 'fillOpacity')}
            title="Fill opacity"
            className="flex-1 accent-[#2563eb]"
          />
        </Row>
        <Row label="Line">
          <ColorField value={st('stroke')} onChange={(v) => cmd.setStyle({ stroke: v })} palette={palette} allowNone testid="diagram-stroke" />
          <NumberField value={common(res, (r) => r.strokeWidth)} onChange={(v) => cmd.setStyle({ strokeWidth: v })} min={0} max={20} step={0.5} width={48} suffix="px" testid="diagram-stroke-width" />
        </Row>
        <Row label="Line style">
          <Select value={common(res, (r) => r.strokeDash)} options={DASHES} onChange={(v) => cmd.setStyle({ strokeDash: v })} testid="diagram-stroke-dash" />
        </Row>
        <Row label="Corners">
          <NumberField value={st('radius')} placeholder="auto" onChange={(v) => cmd.setStyle({ radius: v })} min={0} max={200} width={56} suffix="px" />
        </Row>
        <Row label="Opacity">
          <input type="range" min={0.1} max={1} step={0.05} value={common(res, (r) => r.opacity) ?? 1} onChange={(e) => cmd.setStyle({ opacity: Number(e.target.value) }, 'opacity')} className="flex-1 accent-[#2563eb]" />
        </Row>
        <Toggle checked={!!common(res, (r) => r.shadow)} onChange={(v) => cmd.setStyle({ shadow: v || undefined })} label="Drop shadow" testid="diagram-shadow" />
        <div className="flex gap-1 pt-1">
          <button type="button" className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]" onClick={() => cmd.copyStyle()} title="⌥⌘C">
            Copy style
          </button>
          <button type="button" className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]" onClick={() => cmd.pasteStyle()} title="⌥⌘V">
            Paste style
          </button>
          <button type="button" className="text-[11px] px-2 py-1 rounded hover:bg-[var(--surface-sunken)] text-[var(--ink-60)]" onClick={() => cmd.setNodes({ style: undefined })}>
            Reset
          </button>
        </div>
      </Section>
      <Section title="Shape">
        <Row label="Type">
          <select
            value={common(nodes, (n) => n.shape) ?? ''}
            onChange={(e) => cmd.setNodes({ shape: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            className="fb-field h-6 px-1 text-[11px] flex-1 min-w-0"
            data-testid="diagram-change-shape"
          >
            {common(nodes, (n) => n.shape) === undefined && <option value="">Mixed</option>}
            {SHAPE_CATEGORIES.map((c) => (
              <optgroup key={c} label={c}>
                {SHAPES.filter((s) => s.category === c).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Row>
        <Row label="Icon">
          <IconInput value={common(nodes, (n) => n.icon)} onChange={(v) => cmd.setNodes({ icon: v || undefined })} />
        </Row>
        {def?.special === 'image' && one && <ImageInput cmd={cmd} node={one} />}
        {def?.special === 'table' && one && <TableSize cmd={cmd} node={one} />}
      </Section>
    </>
  )
}

function IconInput({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }): JSX.Element {
  const [q, setQ] = useState(value ?? '')
  useEffect(() => setQ(value ?? ''), [value])
  const suggestions = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/\s+/g, '_')
    return s && s !== value ? ICON_NAMES.filter((n) => n.includes(s)).slice(0, 12) : []
  }, [q, value])
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1">
        {value && (
          <span className="material-symbols-outlined text-[var(--ink-70)]" style={{ fontSize: 18 }}>
            {value}
          </span>
        )}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onChange(q.trim().replace(/\s+/g, '_'))
          }}
          placeholder="search icons"
          className="fb-field h-6 px-1.5 text-[11px] flex-1 min-w-0"
          data-testid="diagram-icon-input"
        />
        {value && (
          <button type="button" onClick={() => onChange('')} className="text-[var(--ink-50)] hover:text-[var(--ink-90)]" title="Remove icon">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="grid grid-cols-6 gap-0.5 mt-1">
          {suggestions.map((n) => (
            <button key={n} type="button" title={n} onClick={() => onChange(n)} className="h-7 rounded hover:bg-[var(--surface-sunken)] flex items-center justify-center">
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                {n}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ImageInput({ cmd, node }: { cmd: Commands; node: MapNode }): JSX.Element {
  return (
    <Row label="Image">
      <input
        type="file"
        accept="image/*"
        className="text-[10px] flex-1 min-w-0"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          if (f.size > 2_500_000) return window.alert('Images up to 2.5 MB can be stored in a diagram.')
          const url = await new Promise<string>((res) => {
            const r = new FileReader()
            r.onload = () => res(String(r.result))
            r.readAsDataURL(f)
          })
          cmd.setNode(node.id, { image: url })
        }}
      />
    </Row>
  )
}

function TableSize({ cmd, node }: { cmd: Commands; node: MapNode }): JSX.Element {
  const m = /(\d+)x(\d+)/.exec(node.shape)
  const rows = node.cells?.length ?? (m ? Number(m[2]) : 3)
  const cols = node.cells ? Math.max(...node.cells.map((r) => r.length)) : m ? Number(m[1]) : 3
  const resize = (r: number, c: number): void => {
    const cells = Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => node.cells?.[i]?.[j] ?? ''))
    cmd.setNode(node.id, { cells })
  }
  return (
    <>
      <Row label="Rows">
        <NumberField value={rows} onChange={(v) => resize(Math.round(v), cols)} min={1} max={60} width={48} />
      </Row>
      <Row label="Columns">
        <NumberField value={cols} onChange={(v) => resize(rows, Math.round(v))} min={1} max={20} width={48} />
      </Row>
      <p className="text-[10px] text-[var(--ink-50)]">Double-click a cell to type; Tab moves to the next cell.</p>
    </>
  )
}

function TextStyle({ cmd, nodes, themeId, palette }: { cmd: Commands; nodes: MapNode[]; themeId?: string; palette: string[] }): JSX.Element {
  const res = nodes.map((n) => resolveNodeStyle(n, themeId))
  const r = <K extends keyof ReturnType<typeof resolveNodeStyle>>(k: K) => common(res, (x) => x[k])
  return (
    <Section title="Text">
      <Row label="Font">
        <Select value={r('fontFamily')} options={FONTS} onChange={(v) => cmd.setStyle({ fontFamily: v })} testid="diagram-font" />
      </Row>
      <Row label="Size">
        <NumberField value={r('fontSize')} onChange={(v) => cmd.setStyle({ fontSize: v })} min={6} max={200} width={52} suffix="pt" testid="diagram-font-size" />
        <ColorField value={common(nodes, (n) => n.style?.textColor)} onChange={(v) => cmd.setStyle({ textColor: v })} palette={palette} testid="diagram-text-color" title="Text colour" />
      </Row>
      <div className="flex items-center gap-0.5">
        <IconBtn icon="format_bold" title="Bold (⌘B)" active={!!r('bold')} onClick={() => cmd.setStyle({ bold: r('bold') ? undefined : true })} testid="diagram-bold" />
        <IconBtn icon="format_italic" title="Italic (⌘I)" active={!!r('italic')} onClick={() => cmd.setStyle({ italic: r('italic') ? undefined : true })} />
        <IconBtn icon="format_underlined" title="Underline (⌘U)" active={!!r('underline')} onClick={() => cmd.setStyle({ underline: r('underline') ? undefined : true })} />
        <IconBtn icon="strikethrough_s" title="Strikethrough" active={!!r('strike')} onClick={() => cmd.setStyle({ strike: r('strike') ? undefined : true })} />
        <span className="w-2" />
        <IconBtn icon="format_align_left" title="Align left" active={r('textAlign') === 'left'} onClick={() => cmd.setStyle({ textAlign: 'left' })} />
        <IconBtn icon="format_align_center" title="Align centre" active={r('textAlign') === 'center'} onClick={() => cmd.setStyle({ textAlign: 'center' })} />
        <IconBtn icon="format_align_right" title="Align right" active={r('textAlign') === 'right'} onClick={() => cmd.setStyle({ textAlign: 'right' })} />
      </div>
      <div className="flex items-center gap-0.5">
        <IconBtn icon="vertical_align_top" title="Top" active={r('vAlign') === 'top'} onClick={() => cmd.setStyle({ vAlign: 'top' })} />
        <IconBtn icon="vertical_align_center" title="Middle" active={r('vAlign') === 'middle'} onClick={() => cmd.setStyle({ vAlign: 'middle' })} />
        <IconBtn icon="vertical_align_bottom" title="Bottom" active={r('vAlign') === 'bottom'} onClick={() => cmd.setStyle({ vAlign: 'bottom' })} />
      </div>
      {nodes.length === 1 && (
        <Row label="Label">
          <textarea
            value={nodes[0]!.label}
            onChange={(e) => cmd.setNode(nodes[0]!.id, { label: e.target.value }, `label:${nodes[0]!.id}`)}
            onKeyDown={(e) => e.stopPropagation()}
            rows={3}
            className="fb-field w-full px-1.5 py-1 text-[11px] resize-y"
            data-testid="diagram-label-field"
          />
        </Row>
      )}
    </Section>
  )
}

function Arrange({ cmd, nodes }: { cmd: Commands; nodes: MapNode[] }): JSX.Element {
  const one = nodes.length === 1 ? nodes[0]! : null
  const size = one ? nodeSize(one) : null
  const locked = common(nodes, (n) => !!n.locked)
  return (
    <>
      {one && size && (
        <Section title="Position & size">
          <div className="grid grid-cols-2 gap-1.5">
            <Row label="X">
              <NumberField value={one.x} onChange={(v) => cmd.setGeometry(one.id, { x: Math.round(v) })} width={60} testid="diagram-x" />
            </Row>
            <Row label="Y">
              <NumberField value={one.y} onChange={(v) => cmd.setGeometry(one.id, { y: Math.round(v) })} width={60} testid="diagram-y" />
            </Row>
            <Row label="W">
              <NumberField value={size.w} onChange={(v) => cmd.setGeometry(one.id, { width: Math.max(8, Math.round(v)) })} min={8} width={60} testid="diagram-w" />
            </Row>
            <Row label="H">
              <NumberField value={size.h} onChange={(v) => cmd.setGeometry(one.id, { height: Math.max(8, Math.round(v)) })} min={8} width={60} testid="diagram-h" />
            </Row>
          </div>
          <Row label="Rotation">
            <NumberField value={one.rotation ?? 0} onChange={(v) => cmd.setGeometry(one.id, { rotation: ((Math.round(v) % 360) + 360) % 360 || undefined })} width={56} suffix="°" testid="diagram-rotation" />
            <IconBtn icon="rotate_left" title="Rotate 90° left" onClick={() => cmd.rotate(-90)} />
            <IconBtn icon="rotate_right" title="Rotate 90° right" onClick={() => cmd.rotate(90)} />
          </Row>
        </Section>
      )}
      <Section title="Arrange">
        <div className="flex flex-wrap gap-0.5">
          <IconBtn icon="flip_to_front" title="Bring to front (⇧⌘])" onClick={() => cmd.order('front')} testid="diagram-front" />
          <IconBtn icon="arrow_upward" title="Bring forward (⌘])" onClick={() => cmd.order('forward')} />
          <IconBtn icon="arrow_downward" title="Send backward (⌘[)" onClick={() => cmd.order('backward')} />
          <IconBtn icon="flip_to_back" title="Send to back (⇧⌘[)" onClick={() => cmd.order('back')} testid="diagram-back" />
          <IconBtn icon="flip" title="Flip horizontally" onClick={() => cmd.flip('x')} />
          <span className="rotate-90 inline-block">
            <IconBtn icon="flip" title="Flip vertically" onClick={() => cmd.flip('y')} />
          </span>
          <IconBtn icon={locked ? 'lock' : 'lock_open'} title={locked ? 'Unlock (⇧⌘L)' : 'Lock (⇧⌘L)'} active={!!locked} onClick={() => cmd.toggleLock()} testid="diagram-lock" />
        </div>
        {nodes.length > 1 && (
          <div className="flex flex-wrap gap-0.5">
            <IconBtn icon="link" label="Group" title="Group (⌘G)" onClick={() => cmd.group()} testid="diagram-group" />
            <IconBtn icon="link_off" label="Ungroup" title="Ungroup (⇧⌘G)" onClick={() => cmd.ungroup()} />
          </div>
        )}
        {nodes.length === 1 && nodes[0]!.groupId && <IconBtn icon="link_off" label="Ungroup" title="Ungroup (⇧⌘G)" onClick={() => cmd.ungroup()} />}
      </Section>
      {nodes.length > 1 && (
        <Section title="Align & distribute">
          <div className="flex flex-wrap gap-0.5" data-testid="map-align-tools">
            {(
              [
                ['left', 'align_horizontal_left'],
                ['hcenter', 'align_horizontal_center'],
                ['right', 'align_horizontal_right'],
                ['top', 'align_vertical_top'],
                ['vcenter', 'align_vertical_center'],
                ['bottom', 'align_vertical_bottom']
              ] as const
            ).map(([edge, icon]) => (
              <IconBtn key={edge} icon={icon} title={`Align ${edge}`} onClick={() => cmd.align(edge)} testid={`map-align-${edge}`} />
            ))}
            <IconBtn icon="horizontal_distribute" title="Distribute horizontally" disabled={nodes.length < 3} onClick={() => cmd.distribute('h')} testid="map-distribute-h" />
            <IconBtn icon="vertical_distribute" title="Distribute vertically" disabled={nodes.length < 3} onClick={() => cmd.distribute('v')} testid="map-distribute-v" />
          </div>
          <div className="flex flex-wrap gap-1">
            <button type="button" className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]" onClick={() => cmd.matchSize('width')}>
              Same width
            </button>
            <button type="button" className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]" onClick={() => cmd.matchSize('height')}>
              Same height
            </button>
            <button type="button" className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]" onClick={() => cmd.matchSize('both')}>
              Same size
            </button>
          </div>
          <p className="text-[10px] text-[var(--ink-40)]">Sizes match the first shape you selected.</p>
        </Section>
      )}
    </>
  )
}

// ── data ────────────────────────────────────────────────────────────────────

function DataTab({ cmd, nodes }: { cmd: Commands; nodes: MapNode[] }): JSX.Element {
  const one = nodes.length === 1 ? nodes[0]! : null
  if (!one) return <div className="p-3 text-[11px] text-[var(--ink-50)]">Select a single shape to edit its data, link and notes.</div>
  return (
    <>
      <Section title="Link & notes">
        <Row label="Link">
          <input
            value={one.link ?? ''}
            onChange={(e) => cmd.setNode(one.id, { link: e.target.value || undefined }, `link:${one.id}`)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="https://… or plexii://…"
            className="fb-field h-6 px-1.5 text-[11px] flex-1 min-w-0"
            data-testid="diagram-link"
          />
          {one.link && /^https?:\/\//i.test(one.link) && (
            <button type="button" title="Open link" onClick={() => window.open(one.link, '_blank', 'noopener,noreferrer')} className="text-[var(--ink-50)] hover:text-[var(--ink-90)]">
              <Icon name="open_in_new" size={13} />
            </button>
          )}
        </Row>
        <textarea
          value={one.description ?? ''}
          onChange={(e) => cmd.setNode(one.id, { description: e.target.value || undefined }, `desc:${one.id}`)}
          onKeyDown={(e) => e.stopPropagation()}
          rows={3}
          placeholder="Notes about this shape (shown on hover in view mode, searchable)"
          className="fb-field w-full px-1.5 py-1 text-[11px] resize-y"
        />
      </Section>
      <Section title="Custom data">
        <CustomData cmd={cmd} node={one} />
      </Section>
      <Section title="Data source">
        <Binding cmd={cmd} node={one} />
      </Section>
    </>
  )
}

function CustomData({ cmd, node }: { cmd: Commands; node: MapNode }): JSX.Element {
  const entries = Object.entries(node.data ?? {})
  const [k, setK] = useState('')
  const [v, setV] = useState('')
  const set = (data: Record<string, string>): void => cmd.setNode(node.id, { data: Object.keys(data).length ? data : undefined }, `data:${node.id}`)
  return (
    <div className="space-y-1">
      {entries.map(([key, val]) => (
        <div key={key} className="flex items-center gap-1">
          <span className="w-[80px] truncate text-[11px] text-[var(--ink-60)]" title={key}>
            {key}
          </span>
          <input
            value={val}
            onChange={(e) => set({ ...node.data, [key]: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            className="fb-field h-6 px-1.5 text-[11px] flex-1 min-w-0"
          />
          <button
            type="button"
            title="Remove"
            onClick={() => {
              const d = { ...node.data }
              delete d[key]
              set(d)
            }}
            className="text-[var(--ink-40)] hover:text-red-600"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <input value={k} onChange={(e) => setK(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Field" className="fb-field h-6 px-1.5 text-[11px] w-[80px]" data-testid="diagram-data-key" />
        <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Value" className="fb-field h-6 px-1.5 text-[11px] flex-1 min-w-0" data-testid="diagram-data-value" />
        <button
          type="button"
          disabled={!k.trim()}
          onClick={() => {
            set({ ...(node.data ?? {}), [k.trim()]: v })
            setK('')
            setV('')
          }}
          className="text-[11px] px-2 h-6 rounded bg-[var(--surface-sunken)] disabled:opacity-40"
          data-testid="diagram-data-add"
        >
          Add
        </button>
      </div>
    </div>
  )
}

// Link a shape to a Plexii table row (live label, fields and colour rules).
function Binding({ cmd, node }: { cmd: Commands; node: MapNode }): JSX.Element {
  const [tableList, setTableList] = useState<FbTable[] | null>(null)
  const tables = useTablesStore((s) => s.tables)
  const rows = useTablesStore((s) => s.rows)
  const b = node.binding
  const tableId = b?.source.kind === 'table' ? b.source.tableId : undefined
  const table = tableId ? tables[tableId] : undefined
  const tableRows = tableId ? rows[tableId] : undefined
  useEffect(() => {
    let alive = true
    window.api.tables
      .list()
      .then((l) => alive && setTableList(l))
      .catch(() => alive && setTableList([]))
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (!tableId) return
    void useTablesStore.getState().ensureTableLoaded(tableId)
    void useTablesStore.getState().ensureRowsLoaded(tableId)
  }, [tableId])

  if (b && b.source.kind !== 'table') {
    return (
      <div className="text-[11px] text-[var(--ink-60)] space-y-1">
        <div>
          Linked to {b.source.kind === 'widget' ? 'a work widget' : b.source.kind === 'app' ? `the ${b.source.appId.split(':')[1]} app` : `the ${b.source.toolId} tool`}.
        </div>
        <button type="button" className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]" onClick={() => cmd.setNode(node.id, { binding: undefined })}>
          Unlink
        </button>
      </div>
    )
  }

  const setB = (patch: Partial<NonNullable<MapNode['binding']>>): void => {
    if (!b) return
    cmd.setNode(node.id, { binding: { ...b, ...patch } })
  }
  const primary = table ? primaryColumn(table) : undefined

  return (
    <div className="space-y-2">
      <Row label="Table">
        <select
          value={tableId ?? ''}
          onChange={(e) => {
            const id = e.target.value
            cmd.setNode(node.id, { binding: id ? { source: { kind: 'table', tableId: id } } : undefined })
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="fb-field h-6 px-1 text-[11px] flex-1 min-w-0"
          data-testid="diagram-bind-table"
        >
          <option value="">{tableList === null ? 'Loading tables…' : tableList.length ? 'Not linked' : 'No Plexii tables yet'}</option>
          {(tableList ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.title || 'Untitled table'}
            </option>
          ))}
        </select>
      </Row>
      {b && table && (
        <>
          <Row label="Row">
            <select
              value={b.source.kind === 'table' ? b.source.rowId ?? '' : ''}
              onChange={(e) => setB({ source: { kind: 'table', tableId: table.id, ...(e.target.value ? { rowId: e.target.value } : {}) } })}
              onKeyDown={(e) => e.stopPropagation()}
              className="fb-field h-6 px-1 text-[11px] flex-1 min-w-0"
              data-testid="diagram-bind-row"
            >
              <option value="">Pick a row…</option>
              {(tableRows ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {primary ? cellText(r.cells[primary.id], primary) || '(blank)' : r.id}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Label">
            <input
              defaultValue={b.labelTemplate ?? ''}
              placeholder={primary ? `{${primary.label}}` : '{Column}'}
              onBlur={(e) => setB({ labelTemplate: e.target.value || undefined })}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="fb-field h-6 px-1.5 text-[11px] flex-1 min-w-0"
              data-testid="diagram-bind-template"
            />
          </Row>
          <p className="text-[10px] text-[var(--ink-40)] -mt-1">Use column names in braces, e.g. {'{Name} · {Status}'}.</p>
          <div>
            <div className="text-[10px] text-[var(--ink-50)] mb-0.5">Show fields</div>
            <div className="flex flex-wrap gap-1">
              {table.schema.columns.map((c) => {
                const on = b.fields?.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setB({ fields: on ? (b.fields ?? []).filter((x) => x !== c.id) : [...(b.fields ?? []), c.id] })}
                    className={`text-[10px] px-1.5 py-0.5 rounded-full border ${on ? 'border-[#2563eb] text-[#1d4ed8] bg-[#2563eb]/10' : 'border-[var(--edge-firm)] text-[var(--ink-60)]'}`}
                  >
                    {c.label}
                  </button>
                )
              })}
            </div>
          </div>
          <Rules table={table} rules={b.rules ?? []} onChange={(rules) => setB({ rules: rules.length ? rules : undefined })} />
          <button type="button" className="text-[11px] px-2 py-1 rounded hover:bg-[var(--surface-sunken)] text-[var(--ink-60)]" onClick={() => cmd.setNode(node.id, { binding: undefined })}>
            Unlink from table
          </button>
        </>
      )}
      {b && !table && tableId && <div className="text-[11px] text-amber-600">The linked table is loading or no longer exists.</div>}
    </div>
  )
}

function Rules({ table, rules, onChange }: { table: FbTable; rules: MapConditionalRule[]; onChange: (r: MapConditionalRule[]) => void }): JSX.Element {
  const ops: { value: MapConditionalRule['op']; label: string }[] = [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'gt', label: '>' },
    { value: 'lt', label: '<' },
    { value: 'gte', label: '≥' },
    { value: 'lte', label: '≤' },
    { value: 'empty', label: 'is empty' },
    { value: 'notEmpty', label: 'has a value' }
  ]
  const set = (i: number, patch: Partial<MapConditionalRule>): void => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div>
      <div className="text-[10px] text-[var(--ink-50)] mb-0.5">Conditional formatting (first match wins)</div>
      {rules.map((r, i) => (
        <div key={r.id} className="flex items-center gap-1 mb-1">
          <select value={r.columnId} onChange={(e) => set(i, { columnId: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-6 px-0.5 text-[10px] w-[70px]">
            {table.schema.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <select value={r.op} onChange={(e) => set(i, { op: e.target.value as MapConditionalRule['op'] })} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-6 px-0.5 text-[10px] w-[58px]">
            {ops.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {r.op !== 'empty' && r.op !== 'notEmpty' && (
            <input defaultValue={r.value ?? ''} onBlur={(e) => set(i, { value: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-6 px-1 text-[10px] w-[52px]" />
          )}
          <input type="color" value={r.fill ?? '#dc2626'} onChange={(e) => set(i, { fill: e.target.value })} className="h-6 w-6 p-0 border-0 bg-transparent" title="Fill when matched" />
          <button type="button" onClick={() => onChange(rules.filter((_, j) => j !== i))} className="text-[var(--ink-40)] hover:text-red-600" title="Remove rule">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rules, { id: `r${Date.now().toString(36)}`, columnId: table.schema.columns[0]?.id ?? '', op: 'eq', value: '', fill: '#dc2626' }])}
        className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]"
        data-testid="diagram-add-rule"
      >
        Add rule
      </button>
    </div>
  )
}

// ── lines ───────────────────────────────────────────────────────────────────

function ArrowPreview({ kind }: { kind: MapArrowHead }): JSX.Element {
  const parts = kind === 'none' ? [] : arrowHeadPath(kind, { x: 34, y: 8 }, 0, 8)
  return (
    <svg width={40} height={16} aria-hidden>
      <line x1={2} y1={8} x2={34} y2={8} stroke="currentColor" strokeWidth={1.5} />
      {parts.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill === 'stroke' ? 'currentColor' : p.fill === 'background' ? 'var(--surface-raised)' : 'none'} stroke="currentColor" strokeWidth={1.2} />
      ))}
    </svg>
  )
}

function ArrowPicker({ value, onChange, testid }: { value: MapArrowHead | undefined; onChange: (v: MapArrowHead) => void; testid?: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative flex-1">
      <button type="button" onClick={() => setOpen((v) => !v)} data-testid={testid} className="fb-field h-6 w-full px-1 flex items-center justify-between text-[11px] text-[var(--ink-80)]">
        {value ? <ArrowPreview kind={value} /> : <span>Mixed</span>}
        <span className="truncate text-[10px] text-[var(--ink-50)]">{value ? ARROW_LABEL[value] : ''}</span>
        <Icon name="expand_more" size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fb-glass-panel fb-pop-in absolute z-50 mt-1 w-full py-1 rounded-[var(--radius-row)] max-h-[280px] overflow-auto">
            {ARROW_HEADS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  onChange(k)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-2 px-2 py-1 text-[11px] hover:bg-[var(--surface-sunken)] ${k === value ? 'font-semibold' : ''}`}
              >
                <ArrowPreview kind={k} />
                {ARROW_LABEL[k]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function LineStyle({ cmd, edges, themeId, palette, defaultEnd, defaultRouting }: { cmd: Commands; edges: MapEdge[]; themeId?: string; palette: string[]; defaultEnd: MapArrowHead; defaultRouting: MapRouting }): JSX.Element {
  const res = edges.map((e) => resolveEdgeStyle(e, themeId, defaultEnd))
  const routing = common(edges, (e) => e.routing ?? defaultRouting)
  return (
    <Section title={`Line${edges.length > 1 ? 's' : ''}`} testid="diagram-line-section">
      <Row label="Style">
        <div className="flex gap-0.5">
          {(
            [
              ['orthogonal', 'turn_right', 'Right-angle'],
              ['curved', 'gesture', 'Curved'],
              ['straight', 'horizontal_rule', 'Straight']
            ] as const
          ).map(([r, icon, title]) => (
            <IconBtn key={r} icon={icon} title={title} active={routing === r} onClick={() => cmd.setEdges({ routing: r, waypoints: undefined })} testid={`diagram-routing-${r}`} />
          ))}
        </div>
      </Row>
      <Row label="Colour">
        <ColorField value={common(edges, (e) => e.stroke)} onChange={(v) => cmd.setEdges({ stroke: v })} palette={palette} testid="diagram-line-color" />
        <NumberField value={common(res, (r) => r.strokeWidth)} onChange={(v) => cmd.setEdges({ strokeWidth: v })} min={0.5} max={20} step={0.5} width={48} suffix="px" testid="diagram-line-width" />
      </Row>
      <Row label="Pattern">
        <Select value={common(res, (r) => r.dash)} options={DASHES.filter((d) => d.value !== 'none')} onChange={(v) => cmd.setEdges({ dash: v, style: undefined })} testid="diagram-line-dash" />
      </Row>
      <Row label="Start">
        <ArrowPicker value={common(res, (r) => r.startArrow)} onChange={(v) => cmd.setEdges({ startArrow: v })} testid="diagram-start-arrow" />
      </Row>
      <Row label="End">
        <ArrowPicker value={common(res, (r) => r.endArrow)} onChange={(v) => cmd.setEdges({ endArrow: v })} testid="diagram-end-arrow" />
      </Row>
      <Row label="Label">
        <NumberField value={common(res, (r) => r.fontSize)} onChange={(v) => cmd.setEdges({ fontSize: v })} min={6} max={72} width={48} suffix="pt" />
        <ColorField value={common(edges, (e) => e.textColor)} onChange={(v) => cmd.setEdges({ textColor: v })} palette={palette} title="Label colour" />
      </Row>
      {edges.length === 1 && (
        <input
          value={edges[0]!.label ?? ''}
          onChange={(e) => cmd.setEdges({ label: e.target.value || undefined }, `elabel:${edges[0]!.id}`)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Line label"
          className="fb-field w-full h-6 px-1.5 text-[11px]"
          data-testid="diagram-edge-label-field"
        />
      )}
      <Toggle checked={!!common(edges, (e) => !!e.animated)} onChange={(v) => cmd.setEdges({ animated: v || undefined })} label="Animated flow" />
      <div className="flex flex-wrap gap-1">
        <button type="button" className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]" onClick={() => cmd.setEdges({ waypoints: undefined, sourceHandle: undefined, targetHandle: undefined })} data-testid="diagram-reset-line">
          Reset route
        </button>
        <button
          type="button"
          className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]"
          onClick={() => {
            const e = edges[0]!
            cmd.setEdges({ startArrow: e.endArrow ?? defaultEnd, endArrow: e.startArrow ?? 'none' })
          }}
        >
          Swap arrows
        </button>
        <IconBtn icon={common(edges, (e) => !!e.locked) ? 'lock' : 'lock_open'} title="Lock line" onClick={() => cmd.toggleLock()} />
      </div>
    </Section>
  )
}

// ── page ────────────────────────────────────────────────────────────────────

function PageSettings({ cmd, page, settings }: { cmd: Commands; page: Graph; settings: import('@shared/types').MapSettings }): JSX.Element {
  const theme = getTheme(settings.theme)
  return (
    <>
      <Section title="Theme" testid="diagram-theme-section">
        <div className="grid grid-cols-2 gap-1.5">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => cmd.setSettings({ theme: t.id === 'plexii' ? undefined : t.id })}
              data-testid={`diagram-theme-${t.id}`}
              className={`rounded-md border p-1.5 text-left ${theme.id === t.id ? 'border-[#2563eb] ring-1 ring-[#2563eb]' : 'border-[var(--edge-soft)] hover:border-[var(--edge-firm)]'}`}
            >
              <div className="h-7 rounded flex items-center justify-center gap-1" style={{ background: t.background }}>
                {t.palette.slice(0, 4).map((c) => (
                  <span key={c} className="h-3 w-4 rounded-sm" style={{ background: t.fillMode === 'tint' ? `${c}${t.fillOpacity > 0.5 ? '' : '33'}` : t.fill, border: `1.5px solid ${t.strokeMode === 'shape' ? c : t.stroke}` }} />
                ))}
              </div>
              <div className="text-[10px] mt-1 text-[var(--ink-70)]">{t.name}</div>
            </button>
          ))}
        </div>
        <button type="button" className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]" onClick={() => cmd.applyThemeToAll(theme.id)} title="Clears per-shape colours so every shape follows the theme">
          Apply theme to every shape
        </button>
      </Section>
      <Section title="Canvas">
        <Row label="Background">
          <ColorField value={settings.background} onChange={(v) => cmd.setSettings({ background: v === 'none' ? undefined : v })} palette={theme.palette} testid="diagram-bg" />
        </Row>
        <Toggle checked={settings.grid !== false} onChange={(v) => cmd.setSettings({ grid: v ? undefined : false })} label="Show grid" testid="diagram-grid" />
        <Row label="Grid size">
          <NumberField value={settings.gridSize ?? 16} onChange={(v) => cmd.setSettings({ gridSize: v === 16 ? undefined : v })} min={4} max={100} width={52} suffix="px" />
        </Row>
        <Toggle checked={settings.snap !== false} onChange={(v) => cmd.setSettings({ snap: v ? undefined : false })} label="Snap to grid" testid="diagram-snap" />
        <Toggle checked={settings.guides !== false} onChange={(v) => cmd.setSettings({ guides: v ? undefined : false })} label="Smart alignment guides" testid="diagram-guides" />
        <Toggle checked={settings.minimap !== false} onChange={(v) => cmd.setSettings({ minimap: v ? undefined : false })} label="Minimap" />
      </Section>
      <Section title="Lines">
        <Row label="New lines">
          <Select
            value={settings.defaultRouting ?? 'orthogonal'}
            options={[
              { value: 'orthogonal', label: 'Right-angle' },
              { value: 'curved', label: 'Curved' },
              { value: 'straight', label: 'Straight' }
            ]}
            onChange={(v) => cmd.setSettings({ defaultRouting: v === 'orthogonal' ? undefined : v })}
            testid="diagram-default-routing"
          />
        </Row>
        <Row label="Arrow">
          <ArrowPicker value={settings.defaultEndArrow ?? 'arrow'} onChange={(v) => cmd.setSettings({ defaultEndArrow: v === 'arrow' ? undefined : v })} />
        </Row>
        <Toggle checked={!!settings.lineJumps} onChange={(v) => cmd.setSettings({ lineJumps: v || undefined })} label="Line jumps where lines cross" testid="diagram-line-jumps" />
      </Section>
      <Section title="This page" defaultOpen={false}>
        <div className="text-[11px] text-[var(--ink-60)]">
          {page.nodes.length} shape{page.nodes.length === 1 ? '' : 's'} · {page.edges.length} line{page.edges.length === 1 ? '' : 's'}
          {page.nodes.some((n) => n.binding) ? ` · ${page.nodes.filter((n) => n.binding).length} linked to data` : ''}
        </div>
      </Section>
    </>
  )
}
