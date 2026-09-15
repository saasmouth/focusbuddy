import type { ReactNode } from 'react'
import { parseMentionText } from '@shared/mentionText'
import { MentionChip } from '../components/MentionText'

// Inline text with its @-mentions and **bold** drawn.
//
// One implementation, because the sticky and the note had the same function
// copied twice already and mentions would have made it three. A mention that
// renders as a chip in one note and as raw markup in another is the sort of
// inconsistency that teaches people not to trust the feature.

export function renderInlineText(s: string): ReactNode[] {
  const out: ReactNode[] = []
  let key = 0
  // Mentions resolve FIRST so a title containing ** is not mangled into bold
  // halfway through a link.
  for (const seg of parseMentionText(s)) {
    if (seg.type === 'mention') {
      out.push(<MentionChip key={`m${key++}`} mention={seg.mention} />)
      continue
    }
    const re = /\*\*(.+?)\*\*/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(seg.text)) !== null) {
      if (m.index > last) out.push(seg.text.slice(last, m.index))
      out.push(<strong key={`b${key++}`}>{m[1]}</strong>)
      last = m.index + m[0].length
    }
    if (last < seg.text.length) out.push(seg.text.slice(last))
  }
  return out.length ? out : [s]
}
