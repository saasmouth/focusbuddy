import { useMemo, useState } from 'react'
import Icon from '../../Icon'
import {
  addSwatch,
  applySwatchEdit,
  assignSwatchTo,
  defaultSwatches,
  deleteSwatch,
  spotInks,
  swatchUsage,
  tintedColor,
  type DesignSwatch
} from '@shared/designSwatches'
import type { DesignBody } from '@shared/design'

// Named colours, including spot inks — the other engine that shipped with no
// control attached to it.
//
// The model is "resolved value plus link": a fill keeps the hex it draws AND
// the id of the swatch it came from. That is what makes this additive — every
// document written before swatches existed still draws exactly as it did — and
// it is safe because the only way to change a swatch (applySwatchEdit) rewrites
// every fill that points at it in the same operation, so the cached value is
// never stale.
//
// Tints mix toward WHITE, because that is what tinting an ink on white paper
// does: a 20% tint of a dark blue is a pale blue, not a transparent one.
//
// Spot inks are the part that costs money. Each one is a separate plate, so the
// panel says how many are in use and preflight reports them by the name a
// printer is told ("Pantone 286 C"), not by the screen approximation.

interface Props {
  design: DesignBody
  /** Ids of the current selection, so a swatch can be applied to it. */
  selectedIds: string[]
  /** Replace the document. Swatch edits rewrite element fills, so this is a body, not a patch. */
  onBody: (next: DesignBody) => void
}

export default function SwatchesPanel({ design, selectedIds, onBody }: Props): JSX.Element {
  // A document with no palette of its own shows the default one. Nothing is
  // written until something is added, applied or edited — the same bargain the
  // styles panel makes.
  const swatches = useMemo(() => design.swatches ?? defaultSwatches(), [design.swatches])
  const [selected, setSelected] = useState<string>(swatches[0]?.id ?? '')
  const [tint, setTint] = useState(100)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#2563eb')
  const [newInk, setNewInk] = useState('')

  const swatch = swatches.find((s) => s.id === selected) ?? swatches[0] ?? null
  const usage = swatch ? swatchUsage(design, swatch.id) : []
  const spots = spotInks(design)

  /** Edits go through the engine, which carries them into every fill. */
  function edit(patch: Partial<Omit<DesignSwatch, 'id'>>): void {
    if (!swatch) return
    // Materialise the palette first if the document has none, so the edit has
    // something to change.
    const base = design.swatches ? design : { ...design, swatches }
    onBody(applySwatchEdit(base, swatch.id, patch))
  }

  return (
    <div className="text-[12px]" data-testid="design-swatches-panel">
      <div className="grid gap-3 md:grid-cols-3">
        {/* ── The palette ───────────────────────────────────────────────── */}
        <section>
          <h4 className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)] mb-1">Swatches</h4>
          <ul className="flex flex-col gap-0.5 max-h-44 overflow-auto pr-1" data-testid="design-swatch-list">
            {swatches.map((s) => {
              const count = swatchUsage(design, s.id).length
              return (
                <li key={s.id}>
                  <button
                    onClick={() => setSelected(s.id)}
                    className={`flex w-full items-center gap-2 px-1.5 py-1 rounded-md text-left ${
                      s.id === swatch?.id ? 'bg-[rgb(var(--accent)/0.1)]' : 'hover:bg-[var(--surface-base)]'
                    }`}
                    data-testid={`design-swatch-${s.id}`}
                  >
                    <span
                      className="h-4 w-4 shrink-0 rounded border border-[var(--edge-soft)]"
                      style={{ background: s.color }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] text-[var(--ink-90)] truncate">
                        {s.name}
                        {s.spot && <span className="text-[var(--ink-40)]"> · spot</span>}
                        {s.locked && <span className="text-[var(--ink-40)]"> · brand</span>}
                      </span>
                      <span className="block fb-t-caption text-[var(--ink-40)]">
                        {s.color}
                        {count ? ` · used ${count}×` : ' · unused'}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {spots.length > 0 && (
            <p className="mt-1.5 fb-t-caption text-[var(--ink-50)] leading-snug" data-testid="design-spot-summary">
              {spots.length} spot ink{spots.length === 1 ? '' : 's'} in use: {spots.map((s) => s.spot?.inkName).join(', ')}.
              Each one is a separate plate and is priced as one.
            </p>
          )}
        </section>

        {/* ── The selected swatch ───────────────────────────────────────── */}
        <section className="space-y-1.5">
          <h4 className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)]">{swatch?.name ?? 'No swatch'}</h4>
          {swatch && (
            <>
              <label className="block">
                <span className="fb-t-caption text-[var(--ink-50)]">Name</span>
                <input
                  value={swatch.name}
                  disabled={swatch.locked}
                  onChange={(e) => edit({ name: e.target.value })}
                  className="fb-field w-full px-1.5 py-1 mt-0.5 disabled:opacity-60"
                  data-testid="design-swatch-name"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="fb-t-caption text-[var(--ink-50)]">Colour</span>
                <input
                  type="color"
                  value={swatch.color.startsWith('#') ? swatch.color : '#000000'}
                  disabled={swatch.locked}
                  onChange={(e) => edit({ color: e.target.value })}
                  className="h-6 w-10 rounded border border-[var(--edge-soft)] bg-transparent disabled:opacity-60"
                  data-testid="design-swatch-color"
                />
                <span className="fb-t-caption text-[var(--ink-40)]">{swatch.color}</span>
              </label>
              <label className="flex items-start gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!swatch.spot}
                  disabled={swatch.locked}
                  onChange={(e) => edit({ spot: e.target.checked ? { inkName: swatch.spot?.inkName || swatch.name } : undefined })}
                  className="mt-0.5"
                  data-testid="design-swatch-spot"
                />
                <span className="min-w-0">
                  <span className="block text-[12px] text-[var(--ink-90)]">Spot ink</span>
                  <span className="block fb-t-caption text-[var(--ink-40)] leading-snug">
                    Printed with its own ink on its own plate. The colour here is only an on-screen
                    approximation of it.
                  </span>
                </span>
              </label>
              {swatch.spot && (
                <label className="block">
                  <span className="fb-t-caption text-[var(--ink-50)]">Ink name, as the printer is told</span>
                  <input
                    value={swatch.spot.inkName}
                    disabled={swatch.locked}
                    onChange={(e) => edit({ spot: { inkName: e.target.value } })}
                    placeholder="Pantone 286 C"
                    className="fb-field w-full px-1.5 py-1 mt-0.5 disabled:opacity-60"
                    data-testid="design-swatch-ink-name"
                  />
                </label>
              )}
              <p className="fb-t-caption text-[var(--ink-40)] leading-snug">
                {usage.length
                  ? `Used by ${usage.length} element${usage.length === 1 ? '' : 's'}. Changing the colour changes all of them.`
                  : 'Nothing uses this yet.'}
              </p>
              <button
                onClick={() => {
                  if (!swatch || swatch.locked) return
                  const base = design.swatches ? design : { ...design, swatches }
                  onBody(deleteSwatch(base, swatch.id))
                  setSelected('')
                }}
                disabled={swatch.locked}
                title={
                  swatch.locked
                    ? 'Brand colours come from the brand kit; edit it there'
                    : usage.length
                      ? `${usage.length} element${usage.length === 1 ? '' : 's'} keep this colour and lose the link — the artwork will not change`
                      : 'Delete this swatch'
                }
                className="fb-btn-surface px-2 py-1 text-[11px] hover:bg-[var(--surface-sunken)] disabled:opacity-40"
                data-testid="design-swatch-delete"
              >
                Delete
              </button>
            </>
          )}
        </section>

        {/* ── Apply, and make new ───────────────────────────────────────── */}
        <section className="space-y-2">
          <h4 className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)]">Apply</h4>
          <label className="flex items-center gap-2">
            <span className="fb-t-caption text-[var(--ink-50)]">Tint</span>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={tint}
              onChange={(e) => setTint(Number(e.target.value))}
              className="flex-1"
              data-testid="design-swatch-tint"
            />
            <span className="w-10 text-right fb-t-caption text-[var(--ink-60)]">{tint}%</span>
            <span
              className="h-5 w-5 rounded border border-[var(--edge-soft)]"
              style={{ background: swatch ? tintedColor(swatch.color, tint) : 'transparent' }}
              data-testid="design-swatch-tint-preview"
            />
          </label>
          <button
            onClick={() => {
              if (!swatch) return
              const base = design.swatches ? design : { ...design, swatches }
              onBody(assignSwatchTo(base, selectedIds, swatch.id, tint === 100 ? undefined : tint))
            }}
            disabled={!swatch || selectedIds.length === 0}
            className="fb-btn-surface w-full px-2 py-1 text-[11px] hover:border-accent disabled:opacity-40"
            title={selectedIds.length === 0 ? 'Select something on the page first' : undefined}
            data-testid="design-swatch-apply"
          >
            {selectedIds.length === 0
              ? 'Select something to colour'
              : `Apply to ${selectedIds.length} selected`}
          </button>

          <h4 className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)] pt-1">New swatch</h4>
          <div className="flex items-center gap-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              className="fb-field min-w-0 flex-1 px-1.5 py-1"
              data-testid="design-swatch-new-name"
            />
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              className="h-6 w-10 shrink-0 rounded border border-[var(--edge-soft)] bg-transparent"
              aria-label="New swatch colour"
              data-testid="design-swatch-new-color"
            />
          </div>
          <input
            value={newInk}
            onChange={(e) => setNewInk(e.target.value)}
            placeholder="Spot ink name (optional)"
            className="fb-field w-full px-1.5 py-1"
            data-testid="design-swatch-new-ink"
          />
          <button
            onClick={() => {
              const name = newName.trim()
              if (!name) return
              const base = design.swatches ? design : { ...design, swatches }
              const { body, id } = addSwatch(base, {
                name,
                color: newColor,
                ...(newInk.trim() ? { spot: { inkName: newInk.trim() } } : {})
              })
              onBody(body)
              setSelected(id)
              setNewName('')
              setNewInk('')
            }}
            disabled={!newName.trim()}
            className="fb-btn-surface w-full px-2 py-1 text-[11px] hover:border-accent disabled:opacity-40"
            data-testid="design-swatch-add"
          >
            <Icon name="add" size={13} className="inline mr-1" />
            Add swatch
          </button>
        </section>
      </div>
    </div>
  )
}
