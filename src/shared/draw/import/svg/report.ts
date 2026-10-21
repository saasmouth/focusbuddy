// The honest account of an import: what came in as editable art, and what
// did not (and what happened to it instead). Shown to the user after every
// Open, Import and Place of an SVG -- "3 filters were rasterised as images",
// never a silent loss.

export interface ImportCounts {
  paths: number
  groups: number
  texts: number
  images: number
  clipGroups: number
}

interface Entry {
  count: number
  one: string
  many: string
  /** Something that was NOT brought in as editable art (as opposed to a remark). */
  loss: boolean
}

export class SvgImportReport {
  counts: ImportCounts = { paths: 0, groups: 0, texts: 0, images: 0, clipGroups: 0 }
  private entries = new Map<string, Entry>()
  /** Descriptions of what was rasterised, e.g. "filter", "mask". */
  rasterised = new Map<string, number>()

  /**
   * Record something once per occurrence. `one` and `many` are the sentence
   * for a single and several occurrences; `{n}` in `many` is the count.
   */
  note(key: string, one: string, many: string, loss = true): void {
    const e = this.entries.get(key)
    if (e) e.count++
    else this.entries.set(key, { count: 1, one, many, loss })
  }

  raster(reason: string): void {
    this.rasterised.set(reason, (this.rasterised.get(reason) ?? 0) + 1)
  }

  /** Every remark as a sentence, losses first. */
  lines(): string[] {
    const out: string[] = []
    const rs = [...this.rasterised.entries()]
    if (rs.length) {
      const what = rs.map(([k, n]) => `${n} ${n === 1 ? k : plural(k)}`)
      out.push(`${joinList(what)} ${rs.reduce((a, [, n]) => a + n, 0) === 1 ? 'was' : 'were'} not editable here and ${rs.reduce((a, [, n]) => a + n, 0) === 1 ? 'was' : 'were'} rasterised as an embedded image.`)
    }
    const sorted = [...this.entries.values()].sort((a, b) => Number(b.loss) - Number(a.loss))
    for (const e of sorted) out.push(e.count === 1 ? e.one : e.many.replace('{n}', String(e.count)))
    return out
  }

  hasLosses(): boolean {
    return this.rasterised.size > 0 || [...this.entries.values()].some((e) => e.loss)
  }

  /** "Imported 12 paths, 2 groups and 1 text." */
  summary(): string {
    const c = this.counts
    const parts: string[] = []
    const add = (n: number, one: string, many: string): void => {
      if (n) parts.push(`${n} ${n === 1 ? one : many}`)
    }
    add(c.paths, 'path', 'paths')
    add(c.groups, 'group', 'groups')
    add(c.clipGroups, 'clipping group', 'clipping groups')
    add(c.texts, 'text object', 'text objects')
    add(c.images, 'image', 'images')
    return parts.length ? `Imported ${joinList(parts)}.` : 'Nothing in the file could be imported.'
  }
}

function plural(k: string): string {
  if (/[^aeiou]y$/.test(k)) return `${k.slice(0, -1)}ies`
  if (/(s|x|ch|sh)$/.test(k)) return `${k}es`
  return `${k}s`
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
