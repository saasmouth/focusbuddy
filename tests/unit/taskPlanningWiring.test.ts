import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TASK_PLANNING_COLUMNS } from '../../src/shared/taskPlanning'

// A column needs THREE things to actually work: DDL, a row->object mapper, and
// a patch writer. DEC-064 records what happens when it has only two — source_url
// had DDL and a writer and read as undefined for months, unnoticed because
// nothing had stored one yet. The manifest cannot enforce that by itself, so
// this does: every planning column must appear in each of the three places.

const root = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

const nodesSrc = read('src/main/db/nodes.ts')
const typesSrc = read('src/shared/types.ts')

describe('task planning column wiring', () => {
  it.each(TASK_PLANNING_COLUMNS.map((c) => [c.column, c.attr] as const))(
    '%s is readable, writable and typed',
    (column, attr) => {
      // 1. The row shape the mapper destructures.
      expect(nodesSrc, `NodeRow is missing ${column}`).toContain(`${column}:`)
      // 2. The mapper itself — the half that was missing in DEC-064.
      expect(nodesSrc, `rowToNode never reads ${column}`).toMatch(
        new RegExp(`${attr}:\\s*row\\.${column}`)
      )
      // 3. The patch writer.
      expect(nodesSrc, `updateNode cannot write ${column}`).toContain(`'${attr}', '${column}'`)
      // 4. Both public shapes, or the renderer cannot pass or read it.
      expect(typesSrc, `FbNode/NodePatch missing ${attr}`).toContain(`${attr}?:`)
    }
  )

  it('runs the migration at startup', () => {
    expect(read('src/main/db/migrations.ts')).toContain('ensureTaskPlanningSchema(db)')
  })

  it('declares each attribute on BOTH FbNode and NodePatch, not just one', () => {
    for (const { attr } of TASK_PLANNING_COLUMNS) {
      const occurrences = typesSrc.split(`${attr}?:`).length - 1
      expect(occurrences, `${attr} should appear on FbNode and NodePatch`).toBeGreaterThanOrEqual(2)
    }
  })
})
