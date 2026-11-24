// A small line diff for comparing two output versions side by side. LCS over
// lines, capped so a huge pair falls back to "no highlighting" rather than
// freezing the window.

export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string }

const MAX_CELLS = 4_000_000

export function diffLines(a: string, b: string): DiffOp[] | null {
  const A = a.split('\n')
  const B = b.split('\n')
  if (A.length * B.length > MAX_CELLS) return null
  const n = A.length
  const m = B.length
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  }
  const out: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: 'same', text: A[i] })
      i++
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      out.push({ kind: 'del', text: A[i++] })
    } else {
      out.push({ kind: 'add', text: B[j++] })
    }
  }
  while (i < n) out.push({ kind: 'del', text: A[i++] })
  while (j < m) out.push({ kind: 'add', text: B[j++] })
  return out
}

// Headings ("# Title", "## …") present in both: when they match, the two
// columns can scroll together (SPEC-AI-SPACE §5 Compare).
export function sharedHeadings(a: string, b: string): string[] {
  const h = (s: string) => s.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim())
  const hb = new Set(h(b))
  return h(a).filter((x) => hb.has(x))
}
