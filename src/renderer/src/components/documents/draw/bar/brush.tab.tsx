// Brush (contextual, while a painting tool is active: Brush, Eraser, Paint
// bucket, Eyedropper): the brush presets, then size, opacity, flow,
// hardness and colour, then texture and dynamics (grain, scatter, spacing,
// angle, pressure). It was the top of the inspector while painting.

import { BarColor, BarGroup, BarNumber, BarSep, BarToggle } from '../../../office/shell'
import { BRUSH_PRESETS, brushFromPreset, type BrushSettings } from '../brushes'
import { commandShortcutLabel } from '../commands/keys'
import type { DrawBarTab, EditorCtx, EditorState } from '../editor/types'
import { toolById } from '../tools/registry'
import { BarLabel, useEditor } from './controls'

const PALETTE = ['#000000', '#ffffff', '#6d5dfc', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#78716c', '#1c1917', '#a8a29e', '#fde68a', '#bae6fd']

export const paintToolActive = (s: Pick<EditorState, 'tool'>): boolean => toolById(s.tool)?.paint === true

function BrushTab({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const s = useEditor(ctx)
  const b = s.brush
  const set = (patch: Partial<BrushSettings>): void => ctx.run('brush.set', patch)
  const pct = (v: number): number => Math.round(v * 100)
  return (
    <>
      <BarGroup label="Brush presets" testid="draw-brush-presets">
        {BRUSH_PRESETS.map((p) => (
          <BarToggle key={p.id} icon={p.icon} label={`${p.name} — ${p.blurb}`} pressed={b.id === p.id} onChange={() => set(brushFromPreset(p, b.color))} testid={`draw-brush-${p.id}`} />
        ))}
      </BarGroup>
      <BarSep />
      <BarGroup label="Brush settings">
        <BarLabel>Size</BarLabel>
        <BarNumber label="Size" value={Math.round(b.size)} min={1} max={400} suffix="px" width={44} shortcut={`${commandShortcutLabel('brush.smaller') ?? '['} / ${commandShortcutLabel('brush.larger') ?? ']'}`} onChange={(size) => set({ size })} testid="draw-brush-size" />
        <BarLabel>Opacity</BarLabel>
        <BarNumber label="Opacity" value={pct(b.opacity)} min={1} max={100} suffix="%" width={40} onChange={(v) => set({ opacity: v / 100 })} testid="draw-brush-opacity" />
        <BarLabel>Flow</BarLabel>
        <BarNumber label="Flow" value={pct(b.flow)} min={1} max={100} suffix="%" width={40} onChange={(v) => set({ flow: v / 100 })} testid="draw-brush-flow" />
        <BarLabel>Hardness</BarLabel>
        <BarNumber label="Hardness" value={pct(b.hardness)} min={0} max={100} suffix="%" width={40} onChange={(v) => set({ hardness: v / 100 })} testid="draw-brush-hardness" />
        <BarColor icon="palette" label="Brush colour" value={b.color} palette={PALETTE} onChange={(c) => c && set({ color: c })} testid="draw-brush-color" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Texture and dynamics">
        <BarLabel>Grain</BarLabel>
        <BarNumber label="Grain" value={pct(b.grain)} min={0} max={100} suffix="%" width={40} onChange={(v) => set({ grain: v / 100 })} testid="draw-brush-grain" />
        <BarLabel>Scatter</BarLabel>
        <BarNumber label="Scatter" value={pct(b.jitter)} min={0} max={100} suffix="%" width={40} onChange={(v) => set({ jitter: v / 100 })} testid="draw-brush-jitter" />
        <BarLabel>Spacing</BarLabel>
        <BarNumber label="Spacing" value={pct(b.spacing)} min={2} max={60} suffix="%" width={40} onChange={(v) => set({ spacing: v / 100 })} testid="draw-brush-spacing" />
        <BarLabel>Angle</BarLabel>
        <BarNumber label="Angle" value={Math.round(b.angle)} suffix="°" width={40} onChange={(angle) => set({ angle })} testid="draw-brush-angle" />
        <BarToggle icon="stylus" label="Pressure changes the size" pressed={b.pressureSize} onChange={(pressureSize) => set({ pressureSize })} testid="draw-brush-pressure" />
      </BarGroup>
    </>
  )
}

const brush: DrawBarTab = { id: 'brush', label: 'Brush', order: 120, when: paintToolActive, component: BrushTab }

export default brush
