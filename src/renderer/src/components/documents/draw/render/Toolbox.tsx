import { useStore } from 'zustand'
import Icon from '../../../Icon'
import { docPaintToCss } from '@shared/draw/svg'
import { drawTools } from '../tools/registry'
import type { EditorCtx } from '../editor/types'

/** The tool column, built from the tool registry, with the current fill and stroke under it. */
export default function Toolbox({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const tool = useStore(ctx.store, (s) => s.tool)
  const readOnly = useStore(ctx.store, (s) => s.readOnly)
  const fill = useStore(ctx.store, (s) => s.fill)
  const stroke = useStore(ctx.store, (s) => s.stroke)
  const swatches = useStore(ctx.store, (s) => s.doc.swatches)
  const tools = drawTools()
  return (
    <div className="shrink-0 w-10 border-r border-[var(--edge-soft)] py-1 overflow-y-auto" data-testid="draw-toolbox">
      {tools.map((t, i) => {
        const off = readOnly && !t.readOnlySafe
        return (
            <div key={t.id}>
              {i > 0 && tools[i - 1].group !== t.group && <div className="my-1 mx-2 h-px bg-[var(--edge-soft)]" />}
              <button
                onClick={() => ctx.setTool(t.id)}
                title={off ? `${t.label} — not available: this artwork is read-only` : `${t.label} (${t.key})`}
                aria-label={t.label}
                aria-pressed={tool === t.id}
                disabled={off}
                data-testid={`draw-tool-${t.id}`}
                className={`w-8 h-8 mx-1 rounded flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed ${
                  tool === t.id ? 'bg-accent/15 text-accent' : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <Icon name={t.icon} size={17} />
              </button>
            </div>
        )
      })}
      <div className="my-1 mx-2 h-px bg-[var(--edge-soft)]" />
      <div className="mx-1 mt-1 flex flex-col items-center gap-1">
        <div className="w-6 h-6 rounded border border-[var(--edge-firm)]" style={{ background: docPaintToCss({ swatches }, fill) }} title="Current fill" data-testid="draw-current-fill" />
        <div
          className="w-6 h-6 rounded border-2"
          style={{ borderColor: stroke ? docPaintToCss({ swatches }, stroke.paint) : 'var(--edge-firm)' }}
          title="Current stroke"
          data-testid="draw-current-stroke"
        />
      </div>
    </div>
  )
}
