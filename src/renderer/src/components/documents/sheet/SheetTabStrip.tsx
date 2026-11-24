// The sheet tab strip at the bottom: switch, add, rename (double-click) and
// delete tabs within one spreadsheet document.

import { useState } from 'react'
import type { SheetBodyV2 } from '@shared/types'
import Icon from '../../Icon'
import { readingControl } from '../../../lib/widgetSurface'

interface Props {
  body: SheetBodyV2
  onSwitch: (index: number) => void
  onAdd: () => void
  onRename: (index: number, name: string) => void
  onDelete: (index: number) => void
  /** Read-only: switching sheets only (a reading control); no add, rename or delete. */
  readOnly?: boolean
}

export default function SheetTabStrip({ body, onSwitch, onAdd, onRename, onDelete, readOnly = false }: Props): JSX.Element {
  const active = body.activeSheet ?? 0
  const [editing, setEditing] = useState<number | null>(null)

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-t border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)]" data-testid="sheet-tab-strip">
      {body.sheets.map((s, i) => (
        <div
          key={s.id}
          {...(readOnly ? readingControl : {})}
          className={`group inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] cursor-pointer ${
            i === active
              ? 'fb-card fb-press text-accent font-medium'
              : 'text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]'
          }`}
          onClick={() => onSwitch(i)}
          onDoubleClick={readOnly ? undefined : () => setEditing(i)}
        >
          {editing === i && !readOnly ? (
            <input
              autoFocus
              defaultValue={s.name}
              onBlur={(e) => {
                onRename(i, e.target.value.trim() || s.name)
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
              className="w-20 bg-transparent border-b border-accent"
            />
          ) : (
            <span>{s.name}</span>
          )}
          {body.sheets.length > 1 && !readOnly && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDelete(i)
              }}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--ink-40)] hover:text-red-500"
              title="Delete sheet"
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button onClick={onAdd} className="icon-btn" title="Add sheet">
          <Icon name="add" size={15} />
        </button>
      )}
    </div>
  )
}
