// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('formerly dead affordances', () => {
  it('imports CSV/XLSX from the sheet assistant using the editor import path', () => {
    const panel = read('src/renderer/src/components/documents/sheet/SheetAiPanel.tsx')
    const editor = read('src/renderer/src/components/documents/SheetEditor.tsx')
    expect(panel).toContain('onImportSource: () => Promise<void>')
    expect(panel).toContain('Import CSV or workbook')
    expect(panel).not.toContain('Connect a source (coming soon)')
    expect(editor).toContain('onImportSource={importFile}')
  })

  it('executes button-field shell commands through the guarded main executor', () => {
    const field = read('src/renderer/src/components/fields/FieldEditor.tsx')
    const main = read('src/main/streamdeckActions.ts')
    expect(field).toContain("type: 'run-shell'")
    expect(field).toContain('window.api.streamdeck.execute')
    expect(field).not.toContain('Shell execution not yet enabled')
    expect(main).toContain('cancelId: 0')
    expect(main).toContain('return runShell(action)')
  })
})
