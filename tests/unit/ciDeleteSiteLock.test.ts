import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// ARCHITECTURE §2.5.3 — the CI delete-site lock. The revive-at-purge design is
// only sound while the set of hard-delete paths against `nodes` stays CLOSED:
// exactly four sanctioned sites (purgeExpiredTrash, agentHistory undo,
// pruneSharedRows, and DEC-021's purgeDeskPermanently), each carrying its
// detach-and-revive step. This test fails the build on:
//   1. any DELETE whose target table is or could be `nodes` (literal `nodes`
//      or a templated `${…}` table variable) without the allowlist marker;
//   2. `DROP TABLE nodes` outside the migration's sanctioned rebuild;
//   3. any `INSERT OR REPLACE INTO nodes` (it is a DELETE+INSERT under FKs —
//      the cascade fires exactly like a delete);
//   4. a NEW table declaring `REFERENCES nodes(id) ON DELETE CASCADE` (widens
//      the cascade blast radius unreviewed);
// and additionally pins the listNodes work_item exclusion and the
// `nodes.assignee` quarantine (GAP-016: assignee is Plan-domain).

const MAIN = join(__dirname, '..', '..', 'src', 'main')
const MARKER = 'ci-delete-allowlist'

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...tsFiles(p))
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

interface Hit {
  file: string
  line: number
  text: string
  allowlisted: boolean
}

function scan(re: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of tsFiles(MAIN)) {
    const lines = readFileSync(file, 'utf-8').split('\n')
    lines.forEach((text, i) => {
      if (!re.test(text)) return
      const windowAbove = lines.slice(Math.max(0, i - 6), i + 1).join('\n')
      hits.push({
        file: file.slice(MAIN.length + 1),
        line: i + 1,
        text: text.trim(),
        allowlisted: windowAbove.includes(MARKER)
      })
    })
  }
  return hits
}

describe('the closed four-site hard-delete enumeration', () => {
  it('every DELETE that is or could be against nodes carries the allowlist marker', () => {
    // Literal `DELETE FROM nodes` plus every templated `DELETE FROM ${…}` —
    // a template variable COULD resolve to nodes, so it must be marked (or the
    // table list provably excludes nodes, which still deserves the reviewer
    // stop this failure produces).
    const hits = scan(/DELETE FROM (nodes\b|\$\{)/)
    const unmarked = hits.filter((h) => !h.allowlisted)
    expect(unmarked, JSON.stringify(unmarked, null, 2)).toEqual([])
    // The sanctioned enumeration is CLOSED at exactly these files:
    const files = [...new Set(hits.map((h) => h.file))].sort()
    expect(files).toEqual(['ai/agentHistory.ts', 'db/nodeLifecycle.ts'])
  })

  it('DROP TABLE nodes exists only at the migration rebuild', () => {
    const hits = scan(/DROP TABLE nodes\b/)
    const unmarked = hits.filter((h) => !h.allowlisted)
    expect(unmarked, JSON.stringify(unmarked, null, 2)).toEqual([])
    expect([...new Set(hits.map((h) => h.file))]).toEqual(['db/migrateNodesKind.ts'])
  })

  it('no INSERT OR REPLACE INTO nodes anywhere', () => {
    expect(scan(/INSERT OR REPLACE INTO nodes\b/)).toEqual([])
  })

  it('the inbound ON DELETE CASCADE set into nodes is pinned', () => {
    // Every declaration widens what a nodes hard-delete destroys. Additions
    // must consciously update this pin AND the detach-and-revive reasoning.
    const hits = scan(/REFERENCES nodes\s*\(\s*id\s*\)\s*ON DELETE CASCADE/i)
    // The invariant is the TOTAL: that is what bounds what a hard delete
    // destroys. The per-file breakdown below is a reviewing aid and moves when
    // files are reorganised -- as it did when the schema and its migrations
    // were split out of database.ts so the cloud runtime could run them too,
    // which redistributed these 12 declarations without adding or removing one.
    expect(hits.length).toBe(12)
    const byFile = new Map<string, number>()
    for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1)
    expect(Object.fromEntries([...byFile.entries()].sort())).toMatchSnapshot()
  })
})

describe('standing S1 pins', () => {
  it('listNodes excludes work_items at the query', () => {
    const nodes = readFileSync(join(MAIN, 'db', 'nodes.ts'), 'utf-8')
    expect(nodes).toMatch(/SELECT \* FROM nodes WHERE trashed_at IS NULL AND kind != 'work_item'/)
  })

  it('nodes.assignee stays Plan-domain: no work-item module touches it (GAP-016)', () => {
    for (const file of tsFiles(MAIN)) {
      const base = file.slice(MAIN.length + 1)
      if (!/workitem/i.test(base)) continue
      expect(readFileSync(file, 'utf-8')).not.toMatch(/assignee/i)
    }
  })

  it('the search query is kind-filtered', () => {
    const search = readFileSync(join(MAIN, 'db', 'search.ts'), 'utf-8')
    expect(search).toContain("AND kind IN ('folder', 'task')")
  })
})
