import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ADD_SUBTASK_DEFINITION, CREATE_TASK_DEFINITION } from '../../src/main/ai/vocabulary'
import { CREATION_KINDS } from '../../src/main/ai/creationGate'

// Adding a task must not mint a desk.
//
// A desk and a task are the same node kind, so a top-level one IS a desk — its
// own canvas, its own sidebar row. Every AI-created task used to land there.
// The fix could NOT be to redefine create-task: that verb is frozen (SPEC-044)
// and saved Flows persist it meaning "desk", so changing its default would have
// silently changed what every stored Flow does. Hence a second verb.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('the two verbs stay distinct', () => {
  it('create-task still means a desk, and still says so', () => {
    expect(CREATE_TASK_DEFINITION).toContain('DESK')
  })

  it('add-subtask means the desk the user is already on', () => {
    expect(ADD_SUBTASK_DEFINITION).toMatch(/DESK THE USER IS ALREADY ON/)
  })

  it('tells the model to prefer add-subtask, and when not to', () => {
    // Without this the model keeps reaching for the verb it has always used.
    expect(ADD_SUBTASK_DEFINITION).toMatch(/prefer it over create-task/)
    expect(ADD_SUBTASK_DEFINITION).toMatch(/ONLY when the user explicitly asks/)
  })

  it('offers add-subtask FIRST in the action catalogue', () => {
    const d = read('src/main/ai/agentDispatcher.ts')
    expect(d.indexOf('"kind":"add-subtask"')).toBeGreaterThan(-1)
    expect(d.indexOf('"kind":"add-subtask"')).toBeLessThan(d.indexOf('"kind":"create-task"'))
  })

  it('parses add-subtask into a proposal', () => {
    expect(read('src/main/ai/agentDispatcher.ts')).toContain("kind === 'add-subtask'")
  })

  it('gates it as workspace-building, like create-task', () => {
    expect(CREATION_KINDS.has('add-subtask')).toBe(true)
  })
})

describe('the executor', () => {
  const ex = read('src/renderer/src/lib/actionExecutor.ts')

  it('sends add-subtask to the current desk', () => {
    expect(ex).toMatch(/applyAddSubtask/)
    expect(ex).toMatch(/p\.parentId \?\? ctx\?\.activeTaskId \?\? null/)
  })

  it('REFUSES rather than making a desk when none is open', () => {
    // Silently creating one would be the exact behaviour this verb prevents.
    expect(ex).toMatch(/a task needs a desk to live on/)
  })

  it('leaves create-task creating a top-level desk', () => {
    expect(ex).toMatch(/parentId: p\.parentId \?\? null,\n\s+kind: 'task'/)
  })

  it('labels the two differently in the trace', () => {
    expect(ex).toMatch(/verb: 'New desk'/)
    expect(ex).toMatch(/verb: 'New task'/)
  })
})
