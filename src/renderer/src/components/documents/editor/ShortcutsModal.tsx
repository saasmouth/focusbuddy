import { MenuModal } from './menuBarKit'
import { commandHint, type OfficeCommand } from '../../../lib/menus/officeCommand'

// Help ▸ Keyboard shortcuts, GENERATED from the app's command registry.
//
// PlexiiWrite and PlexiiCells each used to hand-write this list, and both
// listed the same eight rows — including "Clear formatting ⌘\" for PlexiiCells,
// which did not bind that key. A hand-written list of keys goes stale the first
// time a binding changes, and it goes stale silently, because nothing compares
// it to the keymap.
//
// Reading the registry means the dialog shows exactly the keys the app really
// has: a command with no `keys` is not listed, and a new binding appears here
// the moment it is added.

export default function ShortcutsModal({
  commands,
  onClose
}: {
  commands: Record<string, OfficeCommand>
  onClose: () => void
}): JSX.Element {
  // Registry order inside each group, groups in the order they first appear —
  // which is the order the registry declares them, so Edit comes before Format.
  const bound = Object.values(commands).filter((c) => c.keys || c.otherKeys)
  const groups: Array<[string, OfficeCommand[]]> = []
  for (const c of bound) {
    const name = c.group ?? ''
    const found = groups.find(([g]) => g === name)
    if (found) found[1].push(c)
    else groups.push([name, [c]])
  }

  return (
    <MenuModal width={320} title="Keyboard shortcuts" onClose={onClose}>
      {bound.length === 0 ? (
        // Honest empty state: an app with no bound keys says so rather than
        // showing a list of keys it does not have.
        <div className="text-[13px] text-[var(--ink-50)]" data-testid="shortcuts-none">
          This app has no keyboard shortcuts yet.
        </div>
      ) : (
        <div className="space-y-3" data-testid="shortcuts-list">
          {groups.map(([group, list]) => (
            <div key={group} className="space-y-1.5">
              {group && <div className="text-[11px] uppercase tracking-wide text-[var(--ink-40)]">{group}</div>}
              {list.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-4 text-[13px]">
                  <span className="text-[var(--ink-70)]">{c.label}</span>
                  <span className="text-[var(--ink-40)] fb-tabular shrink-0">{commandHint(c)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </MenuModal>
  )
}
