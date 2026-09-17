import Icon from '../../Icon'
import { DRAW_BLEND_MODES, solid, type DrawBlend, type DrawObject, type DrawPaint, type DrawStroke, type DrawTextObject } from '@shared/draw'
import type { BooleanOp } from '@shared/drawGeometry'
import type { AlignEdge, ArrangeDir } from '@shared/drawOps'
import { BRUSH_PRESETS, brushFromPreset, type BrushSettings } from './brushes'
import { GOOGLE_FONTS, familyLabel, fontFamilyValue, loadGoogleFont } from '../../../lib/googleFonts'

// The PlexiDraw inspector — appearance and structure for whatever is selected.
// With nothing selected it edits the DEFAULTS the next shape will be drawn with,
// which is how Illustrator behaves and is what makes "set the fill, then draw"
// work. A painting tool swaps the top of the panel for the brush controls.

interface Props {
  selected: DrawObject[]
  fill: DrawPaint
  stroke: DrawStroke | undefined
  onFill: (p: DrawPaint) => void
  onStroke: (s: DrawStroke | undefined) => void
  onOpacity: (v: number) => void
  onBlend: (b: DrawBlend) => void
  onReshape: (patch: { cornerRadius?: number; sides?: number; innerRatio?: number }) => void
  onBoolean: (op: BooleanOp) => void
  onAlign: (edge: AlignEdge) => void
  onDistribute: (axis: 'h' | 'v') => void
  onArrange: (dir: ArrangeDir) => void
  onReverse: () => void
  onSetClosed: (closed: boolean) => void
  onJoin: () => void
  onTextPatch: (patch: Partial<DrawTextObject>) => void
  brush: BrushSettings
  onBrush: (patch: Partial<BrushSettings>) => void
  showBrush: boolean
}

export default function DrawInspector(p: Props): JSX.Element {
  const one = p.selected.length === 1 ? p.selected[0] : null
  const paths = p.selected.filter((o) => o.type === 'path')
  const text = one && one.type === 'text' ? one : null
  const liveShape = one && one.type === 'path' && one.shapeKind && one.shapeKind !== 'path' && one.shapeKind !== 'pen' && one.shapeKind !== 'pencil' ? one : null

  return (
    <div className="w-60 shrink-0 border-l border-[var(--edge-soft)] overflow-auto text-[12px]" data-testid="draw-inspector">
      {p.showBrush && (
        <>
          <Section title="Brush">
            <div className="grid grid-cols-4 gap-1" data-testid="draw-brush-presets">
              {BRUSH_PRESETS.map((b) => (
                <button
                  key={b.id}
                  onClick={() => p.onBrush(brushFromPreset(b, p.brush.color))}
                  title={`${b.name} — ${b.blurb}`}
                  aria-label={b.name}
                  aria-pressed={p.brush.id === b.id}
                  data-testid={`draw-brush-${b.id}`}
                  className={`flex flex-col items-center gap-0.5 rounded py-1.5 ${
                    p.brush.id === b.id ? 'bg-accent/15 text-accent' : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
                  }`}
                >
                  <Icon name={b.icon} size={16} />
                  <span className="text-[8px] leading-none text-center px-0.5 truncate w-full">{b.name.split(' ')[0]}</span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[var(--ink-40)] leading-snug">{p.brush.blurb}</p>
          </Section>

          <Section title="Brush settings">
            <Row label="Size">
              <input
                type="range"
                min={1}
                max={400}
                value={Math.round(p.brush.size)}
                data-testid="draw-brush-size"
                onChange={(e) => p.onBrush({ size: Number(e.target.value) })}
                className="flex-1 accent-[var(--accent)]"
              />
              <span className="w-9 text-right fb-tabular text-[var(--ink-50)]">{Math.round(p.brush.size)}</span>
            </Row>
            <Row label="Opacity">
              <input
                type="range"
                min={1}
                max={100}
                value={Math.round(p.brush.opacity * 100)}
                data-testid="draw-brush-opacity"
                onChange={(e) => p.onBrush({ opacity: Number(e.target.value) / 100 })}
                className="flex-1 accent-[var(--accent)]"
              />
              <span className="w-9 text-right fb-tabular text-[var(--ink-50)]">{Math.round(p.brush.opacity * 100)}%</span>
            </Row>
            <Row label="Flow">
              <input
                type="range"
                min={1}
                max={100}
                value={Math.round(p.brush.flow * 100)}
                data-testid="draw-brush-flow"
                onChange={(e) => p.onBrush({ flow: Number(e.target.value) / 100 })}
                className="flex-1 accent-[var(--accent)]"
              />
              <span className="w-9 text-right fb-tabular text-[var(--ink-50)]">{Math.round(p.brush.flow * 100)}%</span>
            </Row>
            <Row label="Hardness">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(p.brush.hardness * 100)}
                data-testid="draw-brush-hardness"
                onChange={(e) => p.onBrush({ hardness: Number(e.target.value) / 100 })}
                className="flex-1 accent-[var(--accent)]"
              />
              <span className="w-9 text-right fb-tabular text-[var(--ink-50)]">{Math.round(p.brush.hardness * 100)}%</span>
            </Row>
            <Row label="Colour">
              <ColorField value={p.brush.color} onChange={(c) => p.onBrush({ color: c })} testid="draw-brush-color" />
            </Row>
            <details className="text-[11px]">
              <summary className="cursor-pointer text-[var(--ink-50)] select-none">Texture &amp; dynamics</summary>
              <div className="pt-1.5 space-y-1.5">
                <Row label="Grain">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(p.brush.grain * 100)}
                    data-testid="draw-brush-grain"
                    onChange={(e) => p.onBrush({ grain: Number(e.target.value) / 100 })}
                    className="flex-1 accent-[var(--accent)]"
                  />
                </Row>
                <Row label="Scatter">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(p.brush.jitter * 100)}
                    data-testid="draw-brush-jitter"
                    onChange={(e) => p.onBrush({ jitter: Number(e.target.value) / 100 })}
                    className="flex-1 accent-[var(--accent)]"
                  />
                </Row>
                <Row label="Spacing">
                  <input
                    type="range"
                    min={2}
                    max={60}
                    value={Math.round(p.brush.spacing * 100)}
                    data-testid="draw-brush-spacing"
                    onChange={(e) => p.onBrush({ spacing: Number(e.target.value) / 100 })}
                    className="flex-1 accent-[var(--accent)]"
                  />
                </Row>
                <Row label="Angle">
                  <input
                    type="number"
                    value={Math.round(p.brush.angle)}
                    data-testid="draw-brush-angle"
                    onChange={(e) => p.onBrush({ angle: Number(e.target.value) || 0 })}
                    className="fb-field w-16 px-1.5 py-1"
                  />
                  <label className="flex items-center gap-1 text-[10px] text-[var(--ink-50)]">
                    <input
                      type="checkbox"
                      checked={p.brush.pressureSize}
                      onChange={(e) => p.onBrush({ pressureSize: e.target.checked })}
                      className="accent-[var(--accent)]"
                    />
                    Pressure
                  </label>
                </Row>
              </div>
            </details>
          </Section>
        </>
      )}

      <Section title={p.selected.length ? `Fill${p.selected.length > 1 ? ` (${p.selected.length})` : ''}` : 'Fill (next shape)'}>
        <PaintEditor value={p.fill} onChange={p.onFill} testid="draw-fill" />
      </Section>

      <Section title="Stroke">
        <PaintEditor
          value={p.stroke?.paint ?? { type: 'none' }}
          onChange={(paint) =>
            paint.type === 'none' ? p.onStroke(undefined) : p.onStroke({ width: p.stroke?.width ?? 2, cap: p.stroke?.cap, join: p.stroke?.join, dash: p.stroke?.dash, ...p.stroke, paint })
          }
          testid="draw-stroke"
        />
        {p.stroke && (
          <>
            <Row label="Width">
              <input
                type="number"
                min={0.1}
                step={0.5}
                value={p.stroke.width}
                data-testid="draw-stroke-width"
                onChange={(e) => p.onStroke({ ...p.stroke!, width: Math.max(0.1, Number(e.target.value) || 0.1) })}
                className="fb-field w-16 px-1.5 py-1"
              />
              <select
                value={p.stroke.dash && p.stroke.dash.length ? 'dashed' : 'solid'}
                data-testid="draw-stroke-dash"
                onChange={(e) => p.onStroke({ ...p.stroke!, dash: e.target.value === 'dashed' ? [p.stroke!.width * 3, p.stroke!.width * 2] : [] })}
                className="fb-field flex-1 min-w-0 px-1.5 py-1"
              >
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
              </select>
            </Row>
            <Row label="Ends">
              <select
                value={p.stroke.cap ?? 'butt'}
                onChange={(e) => p.onStroke({ ...p.stroke!, cap: e.target.value as 'butt' | 'round' | 'square' })}
                className="fb-field flex-1 min-w-0 px-1.5 py-1"
              >
                <option value="butt">Flat</option>
                <option value="round">Round</option>
                <option value="square">Square</option>
              </select>
              <select
                value={p.stroke.join ?? 'miter'}
                onChange={(e) => p.onStroke({ ...p.stroke!, join: e.target.value as 'miter' | 'round' | 'bevel' })}
                className="fb-field flex-1 min-w-0 px-1.5 py-1"
              >
                <option value="miter">Sharp</option>
                <option value="round">Round</option>
                <option value="bevel">Bevel</option>
              </select>
            </Row>
          </>
        )}
      </Section>

      {p.selected.length > 0 && (
        <Section title="Appearance">
          <Row label="Opacity">
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((one?.opacity ?? 1) * 100)}
              data-testid="draw-object-opacity"
              onChange={(e) => p.onOpacity(Number(e.target.value) / 100)}
              className="flex-1 accent-[var(--accent)]"
            />
            <span className="w-9 text-right fb-tabular text-[var(--ink-50)]">{Math.round((one?.opacity ?? 1) * 100)}%</span>
          </Row>
          <Row label="Blend">
            <select
              value={one?.blend ?? 'normal'}
              data-testid="draw-object-blend"
              onChange={(e) => p.onBlend(e.target.value as DrawBlend)}
              className="fb-field flex-1 min-w-0 px-1.5 py-1 capitalize"
            >
              {DRAW_BLEND_MODES.map((b) => (
                <option key={b} value={b}>
                  {b.replace('-', ' ')}
                </option>
              ))}
            </select>
          </Row>
        </Section>
      )}

      {liveShape && (liveShape.shapeKind === 'polygon' || liveShape.shapeKind === 'star') && (
        <Section title="Shape">
          <Row label="Points">
            <input
              type="number"
              min={3}
              max={60}
              value={liveShape.sides ?? (liveShape.shapeKind === 'star' ? 5 : 6)}
              data-testid="draw-shape-sides"
              onChange={(e) => p.onReshape({ sides: Math.max(3, Math.min(60, Number(e.target.value) || 3)) })}
              className="fb-field w-full px-1.5 py-1"
            />
          </Row>
          {liveShape.shapeKind === 'star' && (
            <Row label="Inset">
              <input
                type="range"
                min={5}
                max={95}
                value={Math.round((liveShape.innerRatio ?? 0.5) * 100)}
                data-testid="draw-shape-inner"
                onChange={(e) => p.onReshape({ innerRatio: Number(e.target.value) / 100 })}
                className="flex-1 accent-[var(--accent)]"
              />
            </Row>
          )}
        </Section>
      )}

      {liveShape && liveShape.shapeKind === 'roundRect' && (
        <Section title="Shape">
          <Row label="Corner">
            <input
              type="number"
              min={0}
              value={Math.round(liveShape.cornerRadius ?? 0)}
              data-testid="draw-shape-radius"
              onChange={(e) => p.onReshape({ cornerRadius: Math.max(0, Number(e.target.value) || 0) })}
              className="fb-field w-full px-1.5 py-1"
            />
          </Row>
        </Section>
      )}

      {text && (
        <Section title="Type">
          <Row label="Font">
            <select
              value={familyLabel(text.fontFamily)}
              data-testid="draw-text-family"
              onChange={(e) => {
                loadGoogleFont(e.target.value)
                p.onTextPatch({ fontFamily: fontFamilyValue(e.target.value) })
              }}
              className="fb-field w-full px-1.5 py-1"
              style={{ fontFamily: text.fontFamily }}
            >
              {!GOOGLE_FONTS.includes(familyLabel(text.fontFamily)) && familyLabel(text.fontFamily) !== 'Default' && (
                <option value={familyLabel(text.fontFamily)}>{familyLabel(text.fontFamily)}</option>
              )}
              {GOOGLE_FONTS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Size">
            <input
              type="number"
              min={1}
              value={Math.round(text.fontSize)}
              data-testid="draw-text-size"
              onChange={(e) => p.onTextPatch({ fontSize: Math.max(1, Number(e.target.value) || 1) })}
              className="fb-field w-16 px-1.5 py-1"
            />
            <select
              value={text.fontWeight ?? 400}
              onChange={(e) => p.onTextPatch({ fontWeight: Number(e.target.value) })}
              className="fb-field flex-1 min-w-0 px-1.5 py-1"
            >
              {[300, 400, 500, 600, 700, 800].map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Align">
            <div className="flex gap-0.5">
              {(['left', 'center', 'right'] as const).map((a) => (
                <button
                  key={a}
                  onClick={() => p.onTextPatch({ align: a })}
                  data-testid={`draw-text-align-${a}`}
                  title={`Align ${a}`}
                  className={`icon-btn !h-6 !w-6 ${(text.align ?? 'left') === a ? 'bg-accent/15 text-accent' : ''}`}
                >
                  <Icon name={`format_align_${a}`} size={14} />
                </button>
              ))}
              <button
                onClick={() => p.onTextPatch({ italic: !text.italic })}
                title="Italic"
                className={`icon-btn !h-6 !w-6 ${text.italic ? 'bg-accent/15 text-accent' : ''}`}
              >
                <Icon name="format_italic" size={14} />
              </button>
            </div>
          </Row>
          <Row label="Leading">
            <input
              type="number"
              min={0.5}
              step={0.05}
              value={text.lineHeight ?? 1.2}
              onChange={(e) => p.onTextPatch({ lineHeight: Math.max(0.5, Number(e.target.value) || 1.2) })}
              className="fb-field w-16 px-1.5 py-1"
            />
            <span className="text-[10px] text-[var(--ink-40)]">Tracking</span>
            <input
              type="number"
              step={0.5}
              value={text.letterSpacing ?? 0}
              onChange={(e) => p.onTextPatch({ letterSpacing: Number(e.target.value) || 0 })}
              className="fb-field w-14 px-1.5 py-1"
            />
          </Row>
        </Section>
      )}

      {paths.length >= 2 && (
        <Section title="Pathfinder">
          <div className="grid grid-cols-4 gap-1">
            {(
              [
                { op: 'union', icon: 'join_full', label: 'Unite' },
                { op: 'subtract', icon: 'join_left', label: 'Minus front' },
                { op: 'intersect', icon: 'join_inner', label: 'Intersect' },
                { op: 'exclude', icon: 'join_right', label: 'Exclude' }
              ] as const
            ).map((b) => (
              <button
                key={b.op}
                onClick={() => p.onBoolean(b.op)}
                title={b.label}
                data-testid={`draw-bool-${b.op}`}
                className="fb-btn-surface flex flex-col items-center gap-0.5 py-1.5 hover:border-accent"
              >
                <Icon name={b.icon} size={16} />
                <span className="text-[9px] leading-none text-[var(--ink-50)]">{b.label.split(' ')[0]}</span>
              </button>
            ))}
          </div>
          <button onClick={p.onJoin} data-testid="draw-path-join" className="fb-btn-surface w-full mt-1 py-1 text-[11px] hover:border-accent">
            Join into one path
          </button>
        </Section>
      )}

      {paths.length >= 1 && (
        <Section title="Path">
          <div className="flex gap-1">
            <button onClick={() => p.onSetClosed(true)} className="fb-btn-surface flex-1 py-1 text-[11px] hover:border-accent" title="Close the path">
              Close
            </button>
            <button onClick={() => p.onSetClosed(false)} className="fb-btn-surface flex-1 py-1 text-[11px] hover:border-accent" title="Open the path">
              Open
            </button>
            <button onClick={p.onReverse} className="fb-btn-surface flex-1 py-1 text-[11px] hover:border-accent" title="Reverse direction">
              Reverse
            </button>
          </div>
        </Section>
      )}

      {p.selected.length > 0 && (
        <Section title="Arrange">
          <div className="grid grid-cols-4 gap-1 mb-1">
            {(
              [
                { dir: 'front', icon: 'flip_to_front', label: 'Bring to front' },
                { dir: 'forward', icon: 'keyboard_arrow_up', label: 'Bring forward' },
                { dir: 'backward', icon: 'keyboard_arrow_down', label: 'Send backward' },
                { dir: 'back', icon: 'flip_to_back', label: 'Send to back' }
              ] as const
            ).map((b) => (
              <button key={b.dir} onClick={() => p.onArrange(b.dir)} title={b.label} data-testid={`draw-arrange-${b.dir}`} className="fb-btn-surface py-1 hover:border-accent">
                <Icon name={b.icon} size={15} />
              </button>
            ))}
          </div>
          <div className="grid grid-cols-6 gap-1">
            {(
              [
                { edge: 'left', icon: 'align_horizontal_left' },
                { edge: 'center', icon: 'align_horizontal_center' },
                { edge: 'right', icon: 'align_horizontal_right' },
                { edge: 'top', icon: 'align_vertical_top' },
                { edge: 'middle', icon: 'align_vertical_center' },
                { edge: 'bottom', icon: 'align_vertical_bottom' }
              ] as const
            ).map((b) => (
              <button key={b.edge} onClick={() => p.onAlign(b.edge)} title={`Align ${b.edge}`} data-testid={`draw-align-${b.edge}`} className="fb-btn-surface py-1 hover:border-accent">
                <Icon name={b.icon} size={14} />
              </button>
            ))}
          </div>
          {p.selected.length >= 3 && (
            <div className="grid grid-cols-2 gap-1 mt-1">
              <button onClick={() => p.onDistribute('h')} className="fb-btn-surface py-1 text-[11px] hover:border-accent" title="Distribute horizontally">
                Distribute H
              </button>
              <button onClick={() => p.onDistribute('v')} className="fb-btn-surface py-1 text-[11px] hover:border-accent" title="Distribute vertically">
                Distribute V
              </button>
            </div>
          )}
        </Section>
      )}
    </div>
  )
}

// ── Building blocks ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-2 py-2 border-b border-[var(--edge-soft)] space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-[var(--ink-40)]">{title}</div>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-[11px] text-[var(--ink-50)]">{label}</span>
      {children}
    </label>
  )
}

function ColorField({ value, onChange, testid }: { value: string; onChange: (c: string) => void; testid?: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1 flex-1 min-w-0">
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className="h-6 w-7 shrink-0 rounded border border-[var(--edge-firm)] bg-transparent p-0 cursor-pointer"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Colour hex value"
        className="fb-field flex-1 min-w-0 px-1.5 py-1 font-mono text-[11px]"
      />
    </span>
  )
}

/** Solid / gradient / none, with the stops a gradient needs. */
function PaintEditor({ value, onChange, testid }: { value: DrawPaint; onChange: (p: DrawPaint) => void; testid: string }): JSX.Element {
  const kind = value.type
  function setKind(next: DrawPaint['type']): void {
    if (next === kind) return
    if (next === 'none') return onChange({ type: 'none' })
    if (next === 'solid') return onChange(solid(kind === 'linear' || kind === 'radial' ? value.stops[0].color : '#6d5dfc'))
    const from = kind === 'solid' ? value.color : '#6d5dfc'
    const stops = [
      { offset: 0, color: from },
      { offset: 1, color: '#ffffff' }
    ]
    onChange(next === 'linear' ? { type: 'linear', angle: 90, stops } : { type: 'radial', stops })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-0.5" data-testid={`${testid}-kind`}>
        {(
          [
            { id: 'none', icon: 'block', label: 'None' },
            { id: 'solid', icon: 'square', label: 'Solid' },
            { id: 'linear', icon: 'gradient', label: 'Linear gradient' },
            { id: 'radial', icon: 'blur_circular', label: 'Radial gradient' }
          ] as const
        ).map((k) => (
          <button
            key={k.id}
            onClick={() => setKind(k.id)}
            title={k.label}
            data-testid={`${testid}-kind-${k.id}`}
            className={`icon-btn !h-6 !w-6 ${kind === k.id ? 'bg-accent/15 text-accent' : ''}`}
          >
            <Icon name={k.icon} size={14} />
          </button>
        ))}
      </div>
      {value.type === 'solid' && <ColorField value={value.color} onChange={(c) => onChange(solid(c, value.opacity))} testid={`${testid}-color`} />}
      {(value.type === 'linear' || value.type === 'radial') && (
        <div className="space-y-1">
          {value.stops.map((s, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#000000'}
                onChange={(e) => {
                  const stops = value.stops.map((x, j) => (j === i ? { ...x, color: e.target.value } : x))
                  onChange({ ...value, stops })
                }}
                className="h-6 w-7 shrink-0 rounded border border-[var(--edge-firm)] bg-transparent p-0 cursor-pointer"
              />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(s.offset * 100)}
                onChange={(e) => {
                  const stops = value.stops.map((x, j) => (j === i ? { ...x, offset: Number(e.target.value) / 100 } : x))
                  onChange({ ...value, stops })
                }}
                className="flex-1 accent-[var(--accent)]"
              />
              {value.stops.length > 2 && (
                <button
                  onClick={() => onChange({ ...value, stops: value.stops.filter((_, j) => j !== i) })}
                  title="Remove stop"
                  className="icon-btn !h-5 !w-5"
                >
                  <Icon name="close" size={11} />
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center gap-1">
            <button
              onClick={() => onChange({ ...value, stops: [...value.stops, { offset: 0.5, color: '#888888' }].sort((a, b) => a.offset - b.offset) })}
              className="fb-btn-surface flex-1 py-0.5 text-[10px] hover:border-accent"
            >
              Add stop
            </button>
            {value.type === 'linear' && (
              <input
                type="number"
                value={value.angle ?? 0}
                onChange={(e) => onChange({ ...value, angle: Number(e.target.value) || 0 })}
                title="Angle in degrees"
                className="fb-field w-14 px-1.5 py-0.5 text-[11px]"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
