import { expect } from 'vitest'
import { readOnlySafeOf, type OfficeCommand } from '../../src/renderer/src/lib/menus/officeCommand'

// The shell fixtures build Deck's, Design's and Diagrams' command records from
// stub-deps PROXIES, where a missing key answers a function. Since the
// registries take `readOnly` (readonly-menus-41), a fixture that silently
// became read-only would grey every writing command and every assertion about
// a live ribbon or menu would test the wrong state. Each fixture says
// `readOnly: false` explicitly AND asserts it here: no command in its record
// refuses with the read-only sentence.
export function expectNotReadOnly<T extends Record<string, OfficeCommand> | OfficeCommand[]>(name: string, cmds: T): T {
  const refusing = Object.values(cmds)
    .filter((c) => !readOnlySafeOf(c))
    .map((c) => c.id)
  expect(refusing, `${name}: this fixture's command record is read-only; give its deps readOnly: false`).toEqual([])
  return cmds
}
