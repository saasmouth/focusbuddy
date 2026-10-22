import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// What OTHER apps see on the macOS general pasteboard, read with AppKit
// itself (JavaScript for Automation, no compiled helper): every item's types
// and byte counts, whether NSImage -- what Pages, Keynote, Mail and TextEdit
// paste pictures through -- can make a picture of it, and the plain text.
// Also: putting files on the pasteboard the way Finder's Copy does, and
// posting a real key chord to ONE process (never the frontmost app).

function jxa(src: string): string {
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', src], { encoding: 'utf8' }).trim()
}

export interface PasteboardView {
  /** How many items (Finder writes one per file). */
  items: number
  changeCount: number
  types: string[]
  bytes: Record<string, number>
  image: { w: number; h: number } | null
  text: string | null
}

export function readPasteboard(): PasteboardView {
  const out = jxa(`
    ObjC.import('AppKit')
    var pb = $.NSPasteboard.generalPasteboard
    var items = pb.pasteboardItems
    var types = [], bytes = {}
    for (var i = 0; i < items.count; i++) {
      var it = items.objectAtIndex(i), ts = it.types
      for (var j = 0; j < ts.count; j++) {
        var t = ts.objectAtIndex(j).js
        var d = it.dataForType(t)
        if (types.indexOf(t) < 0) types.push(t)
        bytes[t] = d.isNil() ? -1 : d.length
      }
    }
    var img = $.NSImage.alloc.initWithPasteboard(pb)
    var s = pb.stringForType('public.utf8-plain-text')
    JSON.stringify({ items: Number(items.count), changeCount: pb.changeCount, types: types, bytes: bytes, image: img.isNil() ? null : { w: img.size.width, h: img.size.height }, text: s.isNil() ? null : s.js })
  `)
  // JXA hands NSUInteger values back as strings.
  const v = JSON.parse(out) as PasteboardView
  v.changeCount = Number(v.changeCount)
  for (const k of Object.keys(v.bytes)) v.bytes[k] = Number(v.bytes[k])
  if (v.image) v.image = { w: Number(v.image.w), h: Number(v.image.h) }
  return v
}

/** What Finder's Copy writes for files: one file URL per item (plus, from Finder, names and icons). */
export function copyFilesLikeFinder(paths: string[]): void {
  jxa(`
    ObjC.import('AppKit')
    var pb = $.NSPasteboard.generalPasteboard
    pb.clearContents
    // File URLs written as NSURL objects, as Finder writes them: one item per
    // file, plus the legacy filenames list naming them all.
    var arr = $.NSMutableArray.array;
    ${JSON.stringify(paths)}.forEach(function (p) { arr.addObject($.NSURL.fileURLWithPath(p)) })
    if (!pb.writeObjects(arr)) throw new Error('the pasteboard refused the files')
    'ok'
  `)
}

/** A real key chord, delivered to one process through the window server (so app menus see it, as a person's keypress). */
export function postKeyToPid(pid: number, keyCode: number, mods: Array<'cmd' | 'shift' | 'alt' | 'ctrl'> = []): void {
  const flag = { cmd: '$.kCGEventFlagMaskCommand', shift: '$.kCGEventFlagMaskShift', alt: '$.kCGEventFlagMaskAlternate', ctrl: '$.kCGEventFlagMaskControl' }
  const flags = mods.map((m) => flag[m]).join(' | ') || '0'
  jxa(`
    ObjC.import('CoreGraphics')
    var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState)
    var down = $.CGEventCreateKeyboardEvent(src, ${keyCode}, true)
    var up = $.CGEventCreateKeyboardEvent(src, ${keyCode}, false)
    $.CGEventSetFlags(down, ${flags})
    $.CGEventSetFlags(up, ${flags})
    $.CGEventPostToPid(${pid}, down)
    delay(0.03)
    $.CGEventPostToPid(${pid}, up)
    'ok'
  `)
}

/** macOS virtual key codes (kVK_ANSI_*) for the keys the specs press. */
export const KEY = { A: 0, C: 8, V: 9, O: 31, P: 35, Zero: 29, Minus: 27 } as const

// ── Saving and restoring the whole pasteboard ───────────────────────────────
//
// A spec that touches the system clipboard must leave the person's clipboard
// exactly as it found it: every item, every type, the bytes of each (text,
// pictures, file URLs, rich text, app-private types), not just the text.
// savePasteboard() copies each item's data per type into a private temp
// folder (bytes never pass through a command line, so big pictures are fine);
// restorePasteboard() writes the same items back, in order, and removes the
// folder. A type whose data the owning app only promises (nil when read) is
// skipped: there are no bytes to keep.

export interface SavedPasteboard {
  dir: string
  /** Per item: the types saved, in the order the item listed them. */
  items: string[][]
}

/** Copy every item and type on the general pasteboard to a temp folder. Call in beforeAll. */
export function savePasteboard(): SavedPasteboard {
  const dir = mkdtempSync(join(tmpdir(), 'plexii-pasteboard-'))
  const out = jxa(`
    ObjC.import('AppKit')
    var pb = $.NSPasteboard.generalPasteboard
    var items = pb.pasteboardItems
    var saved = []
    for (var i = 0; i < items.count; i++) {
      var it = items.objectAtIndex(i), ts = it.types, kept = []
      for (var j = 0; j < ts.count; j++) {
        var t = ts.objectAtIndex(j).js
        var d = it.dataForType(t)
        if (d.isNil()) continue
        d.writeToFileAtomically(${JSON.stringify(dir)} + '/' + i + '-' + kept.length + '.bin', true)
        kept.push(t)
      }
      saved.push(kept)
    }
    JSON.stringify(saved)
  `)
  return { dir, items: JSON.parse(out) as string[][] }
}

/** Put back exactly what savePasteboard() found (an empty pasteboard stays empty). Call in afterAll. */
export function restorePasteboard(saved: SavedPasteboard): void {
  // The saved bytes are removed only once they are back on the pasteboard, so
  // a failed restore leaves them in saved.dir to recover by hand.
  jxa(`
    ObjC.import('AppKit')
    var pb = $.NSPasteboard.generalPasteboard
    pb.clearContents
    var saved = ${JSON.stringify(saved.items)}
    var arr = $.NSMutableArray.array
    saved.forEach(function (types, i) {
      var item = $.NSPasteboardItem.alloc.init
      types.forEach(function (t, j) {
        var d = $.NSData.dataWithContentsOfFile(${JSON.stringify(saved.dir)} + '/' + i + '-' + j + '.bin')
        if (!d.isNil()) item.setDataForType(d, t)
      })
      arr.addObject(item)
    })
    if (arr.count > 0 && !pb.writeObjects(arr)) throw new Error('the pasteboard refused the saved items')
    'ok'
    `)
  rmSync(saved.dir, { recursive: true, force: true })
}
