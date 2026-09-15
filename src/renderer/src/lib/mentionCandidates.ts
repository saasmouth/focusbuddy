import type { FbNode, Widget } from '@shared/types'
import type { TextMention } from '@shared/mentionText'
import { catalogFor } from './widgetCatalog'

// What an `@` can reach.
//
// Desks and rooms, every widget on every desk, documents, and the people in the
// directory. Deliberately NOT filtered to the "attachable" set the assistant
// uses: that set exists because the resolver has to turn a reference into text
// for a prompt, and a timer has no text. Writing "see @Timer" in a note is a
// perfectly good sentence, and the link works whether or not a model could
// read it.

export interface MentionCandidate extends TextMention {
  icon: string
  /** Shown under the title so two things with one name can be told apart. */
  detail?: string
}

const score = (title: string, query: string): number => {
  const t = title.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 1
  const i = t.indexOf(q)
  if (i < 0) return 0
  // Prefix beats word-start beats anywhere, and shorter titles win ties: the
  // thing called exactly what you typed should not sit below a longer match.
  const base = i === 0 ? 1000 : /\s/.test(t[i - 1] ?? '') ? 500 : 100
  return base - Math.min(99, title.length)
}

export interface CandidateSources {
  nodes: readonly FbNode[]
  widgets: readonly Widget[]
  people?: ReadonlyArray<{ accountId: string; name: string; email?: string | null }>
  documents?: ReadonlyArray<{ id: string; title: string; docType?: string }>
}

/**
 * Rank everything mentionable against a query.
 *
 * An empty query returns a useful opening set rather than nothing: the point of
 * pressing `@` before typing is to be shown what is nearby.
 */
export function mentionCandidates(
  sources: CandidateSources,
  query: string,
  limit = 8
): MentionCandidate[] {
  const out: Array<{ c: MentionCandidate; s: number }> = []

  for (const n of sources.nodes) {
    if (n.archived) continue
    if (n.kind !== 'task' && n.kind !== 'folder') continue
    const title = n.title || (n.kind === 'task' ? 'Untitled desk' : 'Untitled room')
    const s = score(title, query)
    if (s > 0) {
      out.push({
        s,
        c: {
          kind: n.kind === 'task' ? 'desk' : 'room',
          id: n.id,
          title,
          taskId: n.kind === 'task' ? n.id : null,
          icon: n.kind === 'task' ? 'space_dashboard' : 'folder',
          detail: n.kind === 'task' ? 'Desk' : 'Room'
        }
      })
    }
  }

  for (const w of sources.widgets) {
    if (w.archived) continue
    const cat = catalogFor(w.kind)
    const title = w.title || cat?.label || w.kind
    const s = score(title, query)
    if (s > 0) {
      out.push({
        s: s - 5, // widgets sit just under desks at equal match
        c: {
          kind: 'widget',
          id: w.id,
          title,
          taskId: w.taskId,
          icon: cat?.icon ?? 'widgets',
          detail: cat?.label ?? w.kind
        }
      })
    }
  }

  for (const d of sources.documents ?? []) {
    const s = score(d.title || 'Untitled', query)
    if (s > 0) {
      out.push({
        s,
        c: {
          kind: 'document',
          id: d.id,
          title: d.title || 'Untitled',
          icon: 'description',
          detail: d.docType ?? 'Document'
        }
      })
    }
  }

  for (const p of sources.people ?? []) {
    const s = score(p.name, query)
    if (s > 0) {
      out.push({
        s,
        c: {
          kind: 'person',
          id: p.accountId,
          title: p.name,
          icon: 'person',
          detail: p.email ?? 'Person'
        }
      })
    }
  }

  return out
    .sort((a, b) => b.s - a.s || a.c.title.localeCompare(b.c.title))
    .slice(0, limit)
    .map((x) => x.c)
}
