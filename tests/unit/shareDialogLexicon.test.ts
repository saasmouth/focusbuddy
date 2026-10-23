// ShareDialog names what is being shared in the product's own words. A desk is
// a node of kind 'task' and a room one of kind 'folder', and the dialog used to
// print the kind: "Share this task" on a desk, "Share this folder" on a room,
// and "desk item" for what the lexicon calls a work widget (red176 side note).
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { SHARE_KIND_LABEL } from '../../src/renderer/src/components/ShareDialog'

describe('ShareDialog lexicon', () => {
  it('a desk is a desk, a room a room, a widget a work widget', () => {
    expect(SHARE_KIND_LABEL.task).toBe('desk')
    expect(SHARE_KIND_LABEL.folder).toBe('room')
    expect(SHARE_KIND_LABEL.widget).toBe('work widget')
  })

  it('no label the dialog shows says "task"', () => {
    for (const label of Object.values(SHARE_KIND_LABEL)) expect(label).not.toMatch(/\btasks?\b/i)
  })

  it('every place the dialog names the thing goes through the label map', () => {
    const src = readFileSync(join(__dirname, '../../src/renderer/src/components/ShareDialog.tsx'), 'utf8')
    // JSX text and template literals only (comments stripped): no hard-coded "this task".
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/this (task|folder)\b/i)
    expect(code.match(/SHARE_KIND_LABEL\[kind\]/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})
