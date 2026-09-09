// The browser runtime's `path`, against Node's.
//
// db/files.ts derives a file's stored name from its original filename with
// extname, and that name is what the byte store is keyed by. Getting it wrong
// does not throw -- it writes bytes under one name and looks for them under
// another, so the file uploads successfully and is empty forever after. These
// compare the shim to node:path over the filenames people actually upload.
import { describe, it, expect } from 'vitest'
import * as node from 'node:path/posix'
import { extname, basename, join } from '../../src/web/shims/path'

const NAMES = [
  'report.pdf',
  'Q3 plan.final.docx',
  'archive.tar.gz',
  'no-extension',
  '.gitignore',
  '.env.local',
  'trailing.',
  'UPPER.PNG',
  'folder/nested/file.txt',
  'résumé 2026.pdf',
  '設計.sketch',
  'a.b.c.d.e'
]

describe('extname', () => {
  it('matches node for the filenames people upload', () => {
    for (const n of NAMES) expect(extname(n), n).toBe(node.extname(n))
  })

  it('treats a leading dot as a hidden file, not an extension', () => {
    // '.gitignore' has no extension. Getting this wrong names the stored blob
    // '<id>.gitignore' while lookups ask for '<id>', or the reverse.
    expect(extname('.gitignore')).toBe('')
    expect(extname('.env.local')).toBe('.local')
  })
})

describe('basename', () => {
  it('matches node, including trailing separators', () => {
    for (const n of [...NAMES, 'dir/', 'a/b/c/', '/leading']) {
      expect(basename(n), n).toBe(node.basename(n))
    }
  })

  it('strips a suffix when asked, but never reduces a name to nothing', () => {
    expect(basename('report.pdf', '.pdf')).toBe('report')
    expect(basename('.pdf', '.pdf')).toBe('.pdf')
  })

  it('handles a Windows-style path, which a dropped file can carry', () => {
    expect(basename('C:\\Users\\me\\report.pdf')).toBe('report.pdf')
    expect(extname('C:\\Users\\me\\report.pdf')).toBe('.pdf')
  })
})

describe('join', () => {
  it('matches node for the simple joins the runtime performs', () => {
    for (const parts of [['a', 'b'], ['a/', 'b'], ['a', 'b', 'c.txt'], ['files', 'id.png']]) {
      expect(join(...parts), parts.join('|')).toBe(node.join(...parts))
    }
  })

  it('returns "." for nothing, as node does', () => {
    expect(join()).toBe(node.join())
  })
})
