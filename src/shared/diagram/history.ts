// Undo / redo for PlexiDiagrams. Stores whole-body snapshots (as JSON strings,
// cheap to compare and immune to later mutation), coalesces rapid edits that
// share a key (typing into one field, nudging with arrow keys) into one step,
// and caps memory. Pure: the editor owns when to record.

export interface HistoryOptions {
  limit?: number // max undo steps (default 200)
  coalesceMs?: number // same-key edits within this window merge (default 700)
}

export class History<T> {
  private past: string[] = []
  private future: string[] = []
  private lastKey: string | null = null
  private lastAt = 0
  private readonly limit: number
  private readonly coalesceMs: number

  constructor(opts: HistoryOptions = {}) {
    this.limit = opts.limit ?? 200
    this.coalesceMs = opts.coalesceMs ?? 700
  }

  // Record the state BEFORE a change. Same key within the window = same step.
  record(before: T, key?: string, now = Date.now()): void {
    const snap = JSON.stringify(before)
    if (key && key === this.lastKey && now - this.lastAt < this.coalesceMs) {
      this.lastAt = now
      this.future = []
      return
    }
    if (this.past[this.past.length - 1] === snap) {
      this.future = []
      return
    }
    this.past.push(snap)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
    this.lastKey = key ?? null
    this.lastAt = now
  }

  undo(current: T): T | null {
    const prev = this.past.pop()
    if (prev === undefined) return null
    this.future.push(JSON.stringify(current))
    this.lastKey = null
    return JSON.parse(prev) as T
  }

  redo(current: T): T | null {
    const next = this.future.pop()
    if (next === undefined) return null
    this.past.push(JSON.stringify(current))
    this.lastKey = null
    return JSON.parse(next) as T
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  clear(): void {
    this.past = []
    this.future = []
    this.lastKey = null
  }
}
