// Brush size keys ([ and ]): 15% smaller or larger, at least 1px, 1..400.

import type { Command } from '../editor/types'

function resize(sign: 1 | -1): Command['run'] {
  return (ctx) => ctx.set((s) => ({ brush: { ...s.brush, size: Math.max(1, Math.min(400, s.brush.size + sign * Math.max(1, s.brush.size * 0.15))) } }))
}

export const commands: Command[] = [
  { id: 'brush.smaller', label: 'Smaller brush', run: resize(-1) },
  { id: 'brush.larger', label: 'Larger brush', run: resize(1) },
  {
    id: 'brush.set',
    label: 'Brush settings',
    run: (ctx, args) => ctx.set((s) => ({ brush: { ...s.brush, ...(args as object) } }))
  }
]
