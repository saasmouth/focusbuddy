// Isolation mode's bar, above the canvas as in Illustrator: a back arrow that
// goes up one level, then the path to the isolated group -- its layer, then
// each group -- where clicking a crumb goes back to that level and clicking
// the layer leaves isolation mode. Hidden when not isolated.

import { useStore } from 'zustand'
import Icon from '../../../Icon'
import { exitIsolation, isolationChain, isolationLayerName } from '../editor/isolation'
import type { EditorCtx } from '../editor/types'

export default function IsolationBar({ ctx }: { ctx: EditorCtx }): JSX.Element | null {
  const doc = useStore(ctx.store, (s) => s.doc)
  const isolation = useStore(ctx.store, (s) => s.isolation)
  const chain = isolationChain({ doc, isolation })
  if (!chain.length) return null
  const layer = isolationLayerName({ doc, isolation }) ?? 'Layer'
  const crumb = 'px-1.5 py-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 truncate max-w-[14rem]'
  return (
    <div
      className="shrink-0 flex items-center gap-1 px-2 py-1 text-[12px] bg-stone-300/80 dark:bg-stone-700/80 border-b border-[var(--edge-soft)]"
      data-testid="draw-isolation-bar"
      role="navigation"
      aria-label="Isolation mode"
    >
      <button type="button" className={crumb} title="Back one level" aria-label="Back one level" data-testid="draw-isolation-up" onClick={() => exitIsolation(ctx, chain.length - 1)}>
        <Icon name="arrow_back" size={16} />
      </button>
      <button type="button" className={crumb} title="Exit isolation mode" data-testid="draw-isolation-exit" onClick={() => exitIsolation(ctx)}>
        {layer}
      </button>
      {chain.map((g, i) => (
        <span key={g.id} className="flex items-center gap-1 min-w-0">
          <span aria-hidden="true" className="opacity-60">
            ›
          </span>
          <button
            type="button"
            className={`${crumb} ${i === chain.length - 1 ? 'font-semibold' : ''}`}
            data-testid={`draw-isolation-crumb-${i}`}
            disabled={i === chain.length - 1}
            onClick={() => exitIsolation(ctx, i + 1)}
          >
            {g.name || (g.clip ? '<Clip Group>' : '<Group>')}
          </button>
        </span>
      ))}
      <span className="ml-auto opacity-70">Isolation mode · Esc to exit</span>
    </div>
  )
}
