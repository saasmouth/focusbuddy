// Controls the PlexiiDraw top-bar tabs share. Every one is a bar primitive of
// the office shell (components/office/shell/primitives.tsx), so Draw looks
// like every other office app, and every one runs a registered command, so
// the bar, the menus, the keys and any other caller do exactly the same thing.
//
// - CmdButton / CmdToggle: a bar button for a command: its label, its LIVE key
//   (the keymap and the person's remapping, written for this platform) in the
//   tooltip, and disabled exactly when the command cannot work, with a reason.
// - PaintButton: Fill or Stroke paint (none, solid, linear or radial gradient)
//   in a popover, the editor that used to sit in the right-hand inspector.
// - useEditor: re-render a tab when the editor state changes.

import { useContext } from 'react'
import { useStore } from 'zustand'
import Icon from '../../../Icon'
import { BarButton, BarColor, BarContext, BarCustom, BarToggle } from '../../../office/shell'
import { solid } from '@shared/draw'
import { docPaintToCss } from '@shared/draw/svg'
import type { DrawDocPaint as DrawPaint, DrawDoc } from '@shared/draw/model'
import { commandById } from '../commands/registry'
import { commandShortcutLabel } from '../commands/keys'
import type { EditorCtx, EditorState } from '../editor/types'

/** The editor state, subscribed: a tab re-renders whenever anything it may read changes. */
export function useEditor(ctx: EditorCtx): EditorState {
  return useStore(ctx.store)
}

/** The live key of a command, formatted for this platform, or undefined. */
export function keyOf(id: string): string | undefined {
  return commandShortcutLabel(id) ?? commandById(id)?.shortcut ?? undefined
}

/** Is the command usable now? (A missing command is not.) */
export function canRun(ctx: EditorCtx, id: string): boolean {
  const c = commandById(id)
  return !!c && (!c.enabled || c.enabled(ctx))
}

interface CmdProps {
  ctx: EditorCtx
  /** The command to run. */
  id: string
  icon?: string
  /** Defaults to the command's own label. */
  label?: string
  showLabel?: boolean
  args?: unknown
  /** Why it is off when the command says it cannot run (shown in the tooltip). */
  reason?: string
  readOnlySafe?: boolean
  testid?: string
  /** Off for a reason of the caller's even though the command could run (Pathfinder needs two paths). */
  off?: boolean
}

/** Why a command is off: its own pending note, the caller's reason, or a plain fallback. */
function offReason(id: string, reason?: string, ctx?: EditorCtx): string {
  const c = commandById(id)
  return c?.pending ?? reason ?? (ctx && c?.disabledReason?.(ctx)) ?? 'not available for this selection'
}

export function CmdButton({ ctx, id, icon, label, showLabel, args, reason, readOnlySafe, testid, off }: CmdProps): JSX.Element {
  const c = commandById(id)
  const on = !off && canRun(ctx, id)
  return (
    <BarButton
      icon={icon ?? c?.icon}
      label={label ?? c?.label ?? id}
      showLabel={showLabel}
      shortcut={keyOf(id)}
      disabled={!on}
      disabledReason={on ? undefined : offReason(id, reason, ctx)}
      readOnlySafe={readOnlySafe}
      testid={testid}
      onClick={() => ctx.run(id, args)}
    />
  )
}

/** A command with a check mark in its menu (on/off): pressed while `checked`. */
export function CmdToggle({ ctx, id, icon, label, showLabel, args, reason, readOnlySafe, testid, pressed, off }: CmdProps & { pressed?: boolean }): JSX.Element {
  const c = commandById(id)
  const on = !off && canRun(ctx, id)
  return (
    <BarToggle
      icon={icon ?? c?.icon}
      label={label ?? c?.label ?? id}
      showLabel={showLabel}
      shortcut={keyOf(id)}
      pressed={pressed ?? !!c?.checked?.(ctx)}
      disabled={!on}
      disabledReason={on ? undefined : offReason(id, reason, ctx)}
      readOnlySafe={readOnlySafe}
      testid={testid}
      onChange={() => ctx.run(id, args)}
    />
  )
}

/** A short label in the bar, for a cluster ("Fill", "Stroke"). */
export function BarLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return <span className="shrink-0 px-1 text-[11px] text-[var(--ink-50)] select-none">{children}</span>
}

/** Is the bar read-only (a drawing from a newer PlexiiDraw)? Custom controls ask this themselves. */
export function useBarReadOnly(): boolean {
  return useContext(BarContext).readOnly
}

// ── Paint ────────────────────────────────────────────────────────────────────

export function ColorField({ value, onChange, testid, disabled }: { value: string; onChange: (c: string) => void; testid?: string; disabled?: boolean }): JSX.Element {
  return (
    <span className="flex items-center gap-1 flex-1 min-w-0">
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        disabled={disabled}
        aria-label="Colour"
        className="h-6 w-7 shrink-0 rounded border border-[var(--edge-firm)] bg-transparent p-0 cursor-pointer"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Colour hex value"
        disabled={disabled}
        className="fb-field flex-1 min-w-0 px-1.5 py-1 font-mono text-[11px]"
      />
    </span>
  )
}

/** Solid / gradient / none, with the stops a gradient needs. */
export function PaintEditor({ value, onChange, testid }: { value: DrawPaint; onChange: (p: DrawPaint) => void; testid: string }): JSX.Element {
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
            type="button"
            onClick={() => setKind(k.id)}
            title={k.label}
            aria-label={k.label}
            aria-pressed={kind === k.id}
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
                aria-label={`Stop ${i + 1} colour`}
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
                aria-label={`Stop ${i + 1} position`}
                value={Math.round(s.offset * 100)}
                onChange={(e) => {
                  const stops = value.stops.map((x, j) => (j === i ? { ...x, offset: Number(e.target.value) / 100 } : x))
                  onChange({ ...value, stops })
                }}
                className="flex-1 accent-[var(--accent)]"
              />
              {value.stops.length > 2 && (
                <button type="button" onClick={() => onChange({ ...value, stops: value.stops.filter((_, j) => j !== i) })} title="Remove stop" aria-label="Remove stop" className="icon-btn !h-6 !w-6">
                  <Icon name="close" size={11} />
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center gap-1">
            <button
              type="button"
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
                aria-label="Gradient angle in degrees"
                className="fb-field w-14 px-1.5 py-0.5 text-[11px]"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Fill or Stroke paint in the bar: a swatch button (testid) that opens the
 * paint editor in a popover. The swatch shows the paint; "none" shows a slash.
 */
export function PaintButton({ label, value, swatches, onChange, testid, stroke, disabledReason, semantic }: {
  label: string
  value: DrawPaint
  swatches: DrawDoc['swatches']
  onChange: (p: DrawPaint) => void
  testid: string
  /** The stroke paint (border icon) rather than a fill. */
  stroke?: boolean
  disabledReason?: string
  /** What the control means, for the control-type contract (Type › Text colour). */
  semantic?: 'text-color'
}): JSX.Element {
  // The colour control every office app uses (BarColor: its trigger, look and
  // aria), with Draw's own picker inside, because a Draw paint can be a
  // swatch, a gradient or none, which a flat palette cannot express (SPEC §3.9).
  const css = value.type === 'none' ? undefined : docPaintToCss({ swatches }, value)
  return (
    <BarCustom testid={`${testid}-cluster`}>
      <BarColor
        icon={stroke ? 'border_color' : semantic === 'text-color' ? 'format_color_text' : 'format_color_fill'}
        label={label}
        value={value.type === 'solid' ? css : undefined}
        swatch={css}
        palette={[]}
        onChange={() => undefined}
        disabled={!!disabledReason}
        disabledReason={disabledReason}
        semantic={semantic}
        testid={testid}
        popover={() => (
          <div className="p-2 w-[240px]">
            <PaintEditor value={value} onChange={onChange} testid={testid} />
          </div>
        )}
      />
    </BarCustom>
  )
}
