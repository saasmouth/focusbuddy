// @vitest-environment node
// "Open This Room in Plexii": reading what PlexiiLite handed over, and checking
// each of the person's files before it is copied (main/liteRoomFiles.ts), against
// real files, links and folders on disk.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { checkRoomFile, checkRoomFolder, isDataless, liteRoomHandoffPath, readLiteRoomHandoff, SF_DATALESS, statFlags } from '../../src/main/liteRoomFiles'
import { LITE_ROOM_MAX_AGE_MS, LITE_ROOM_MAX_JSON_BYTES } from '../../src/shared/liteRoom'

const FIXTURE = readFileSync(resolve(__dirname, '../fixtures/plexiilite-room-v1.json'), 'utf8')
const ID = '3b241101-e2bb-4255-8caf-4136c566a962'
const NOW = Date.parse('2026-11-09T09:31:00.000Z')

let base: string
let lite: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plexii-literoom-')))
  lite = join(base, 'PlexiiLite')
  mkdirSync(join(lite, 'handoff'), { recursive: true })
})
afterEach(() => {
  // A test may have taken permissions away; give them back so the folder can go.
  try {
    chmodSync(join(base, 'room', 'locked'), 0o755)
  } catch {
    /* none */
  }
  rmSync(base, { recursive: true, force: true })
})

describe('reading the handoff', () => {
  it('reads <PlexiiLite data>/handoff/<id>.json and checks it in full', () => {
    writeFileSync(liteRoomHandoffPath(lite, ID), FIXTURE)
    const r = readLiteRoomHandoff(lite, ID, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.room.name).toBe('Launch')
  })

  it('an id that is no handoff id is never turned into a path', () => {
    writeFileSync(join(lite, 'secret.json'), FIXTURE)
    expect(readLiteRoomHandoff(lite, '../secret', NOW)).toEqual({ ok: false, refusal: 'missing' })
    expect(readLiteRoomHandoff(lite, ID.toUpperCase(), NOW)).toEqual({ ok: false, refusal: 'missing' })
  })

  it('unknown id: missing', () => {
    expect(readLiteRoomHandoff(lite, ID, NOW)).toEqual({ ok: false, refusal: 'missing' })
  })

  it('a handoff that is a link to a file elsewhere is not followed', () => {
    const elsewhere = join(base, 'elsewhere.json')
    writeFileSync(elsewhere, FIXTURE)
    symlinkSync(elsewhere, liteRoomHandoffPath(lite, ID))
    expect(readLiteRoomHandoff(lite, ID, NOW)).toEqual({ ok: false, refusal: 'unreadable' })
  })

  it('a handoff folder that is a link to elsewhere is not followed', () => {
    rmSync(join(lite, 'handoff'), { recursive: true })
    const other = join(base, 'other')
    mkdirSync(other)
    writeFileSync(join(other, `${ID}.json`), FIXTURE)
    symlinkSync(other, join(lite, 'handoff'))
    expect(readLiteRoomHandoff(lite, ID, NOW)).toEqual({ ok: false, refusal: 'unreadable' })
  })

  it('PlexiiLite\'s data folder itself reached through a link is fine: what matters is where the file really is', () => {
    writeFileSync(liteRoomHandoffPath(lite, ID), FIXTURE)
    const viaLink = join(base, 'Application Support Link')
    symlinkSync(lite, viaLink)
    expect(readLiteRoomHandoff(viaLink, ID, NOW).ok).toBe(true)
  })

  it('not a file, or more than 1 MiB: unreadable', () => {
    mkdirSync(liteRoomHandoffPath(lite, ID))
    expect(readLiteRoomHandoff(lite, ID, NOW)).toEqual({ ok: false, refusal: 'unreadable' })
    rmSync(liteRoomHandoffPath(lite, ID), { recursive: true })
    writeFileSync(liteRoomHandoffPath(lite, ID), FIXTURE)
    truncateSync(liteRoomHandoffPath(lite, ID), LITE_ROOM_MAX_JSON_BYTES + 1)
    expect(readLiteRoomHandoff(lite, ID, NOW)).toEqual({ ok: false, refusal: 'unreadable' })
  })

  it('not JSON, or not the schema: refused whole', () => {
    writeFileSync(liteRoomHandoffPath(lite, ID), '{"format": "plexiilite.room",')
    expect(readLiteRoomHandoff(lite, ID, NOW)).toEqual({ ok: false, refusal: 'schema' })
    const f = JSON.parse(FIXTURE)
    f.tiles[0].relPath = '../../.ssh/id_rsa'
    writeFileSync(liteRoomHandoffPath(lite, ID), JSON.stringify(f))
    expect(readLiteRoomHandoff(lite, ID, NOW)).toEqual({ ok: false, refusal: 'schema' })
  })

  it('more than a day old: expired', () => {
    writeFileSync(liteRoomHandoffPath(lite, ID), FIXTURE)
    expect(readLiteRoomHandoff(lite, ID, NOW + LITE_ROOM_MAX_AGE_MS)).toEqual({ ok: false, refusal: 'expired' })
  })
})

describe('checking each file before it is copied', () => {
  let room: string
  beforeEach(() => {
    room = join(base, 'room')
    mkdirSync(room)
    writeFileSync(join(room, 'plan.md'), '# Plan\n')
    mkdirSync(join(room, 'Ideas'))
    writeFileSync(join(room, 'Ideas', 'idea.md'), '# Idea\n')
    writeFileSync(join(base, 'secret.txt'), 'not in the room')
  })
  const local = (): boolean => false

  it('a regular file directly in the folder: its path and size', () => {
    expect(checkRoomFile(room, 'plan.md', local)).toEqual({ ok: true, path: join(room, 'plan.md'), size: 7 })
  })
  it('a name that would leave the folder is never looked at', () => {
    expect(checkRoomFile(room, '../secret.txt', local)).toEqual({ ok: false, why: 'outside' })
    expect(checkRoomFile(room, 'Ideas/idea.md', local)).toEqual({ ok: false, why: 'outside' })
    expect(checkRoomFile(room, '..', local)).toEqual({ ok: false, why: 'outside' })
    expect(checkRoomFile(room, '', local)).toEqual({ ok: false, why: 'outside' })
  })
  it('a link to a file outside the folder is left out; a link to one inside is the file it names', () => {
    symlinkSync(join(base, 'secret.txt'), join(room, 'escape.txt'))
    expect(checkRoomFile(room, 'escape.txt', local)).toEqual({ ok: false, why: 'outside' })
    symlinkSync('../secret.txt', join(room, 'relative-escape.txt'))
    expect(checkRoomFile(room, 'relative-escape.txt', local)).toEqual({ ok: false, why: 'outside' })
    symlinkSync(join(room, 'Ideas', 'idea.md'), join(room, 'shortcut.md'))
    expect(checkRoomFile(room, 'shortcut.md', local)).toEqual({ ok: true, path: join(room, 'Ideas', 'idea.md'), size: 7 })
  })
  it('a folder, a package or a special file is not a plain file', () => {
    expect(checkRoomFile(room, 'Ideas', local)).toEqual({ ok: false, why: 'not-a-file' })
    mkdirSync(join(room, 'Notes.rtfd'))
    expect(checkRoomFile(room, 'Notes.rtfd', local)).toEqual({ ok: false, why: 'not-a-file' })
    execFileSync('/usr/bin/mkfifo', [join(room, 'pipe')])
    expect(checkRoomFile(room, 'pipe', local)).toEqual({ ok: false, why: 'not-a-file' })
  })
  it('gone since PlexiiLite listed it', () => {
    expect(checkRoomFile(room, 'deleted.md', local)).toEqual({ ok: false, why: 'gone' })
    symlinkSync(join(room, 'nowhere'), join(room, 'dangling.md'))
    expect(checkRoomFile(room, 'dangling.md', local)).toEqual({ ok: false, why: 'gone' })
  })
  it('a folder macOS won\'t let Plexii look into: not allowed', () => {
    mkdirSync(join(room, 'locked'))
    writeFileSync(join(room, 'locked', 'x.md'), 'x')
    chmodSync(join(room, 'locked'), 0o000)
    expect(checkRoomFile(join(room, 'locked'), 'x.md', local)).toEqual({ ok: false, why: 'denied' })
  })
  it('only in iCloud: left out, and never read', () => {
    let asked = ''
    expect(checkRoomFile(room, 'plan.md', (p) => ((asked = p), true))).toEqual({ ok: false, why: 'in-cloud' })
    expect(asked).toBe(join(room, 'plan.md'))
  })
  it('the folder itself: its real path, which must be a folder', () => {
    const link = join(base, 'room-link')
    symlinkSync(room, link)
    expect(checkRoomFolder(link)).toEqual({ ok: true, real: room })
    expect(checkRoomFolder(join(room, 'plan.md'))).toEqual({ ok: false, why: 'not-a-folder' })
    expect(checkRoomFolder(join(base, 'nope'))).toEqual({ ok: false, why: 'gone' })
  })
})

describe('telling a file only in iCloud without reading it', () => {
  const st = (size: number, blocks: number) => ({ size, blocks })
  it('a file with blocks, or empty, is here: its flags aren\'t even asked', () => {
    const never = (): number => {
      throw new Error('asked')
    }
    expect(isDataless('/x', st(100, 8), never, 'darwin')).toBe(false)
    expect(isDataless('/x', st(0, 0), never, 'darwin')).toBe(false)
  })
  it('bytes and no blocks: its SF_DATALESS flag decides', () => {
    expect(isDataless('/x', st(100, 0), () => SF_DATALESS, 'darwin')).toBe(true)
    expect(isDataless('/x', st(100, 0), () => 0, 'darwin')).toBe(false)
  })
  it('flags that can\'t be read count as in iCloud: never read one by accident', () => {
    expect(
      isDataless(
        '/x',
        st(100, 0),
        () => {
          throw new Error('no stat')
        },
        'darwin'
      )
    ).toBe(true)
  })
  it('a real sparse file (no blocks, not in iCloud) reads as here, by macOS\'s own stat', () => {
    const p = join(base, 'sparse.bin')
    writeFileSync(p, '')
    truncateSync(p, 10 * 1024 * 1024)
    expect(statFlags(p) & SF_DATALESS).toBe(0)
    expect(isDataless(p, { size: 10 * 1024 * 1024, blocks: 0 })).toBe(false)
  })
})
