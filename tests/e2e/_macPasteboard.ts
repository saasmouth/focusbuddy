import { execFileSync } from 'child_process'

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
    JSON.stringify({ changeCount: pb.changeCount, types: types, bytes: bytes, image: img.isNil() ? null : { w: img.size.width, h: img.size.height }, text: s.isNil() ? null : s.js })
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
    // One pasteboard item per file, each with its file URL, as Finder writes them.
    var items = ${JSON.stringify(paths)}.map(function (p) {
      var it = $.NSPasteboardItem.alloc.init
      it.setStringForType($.NSURL.fileURLWithPath(p).absoluteString, 'public.file-url')
      return it
    })
    pb.writeObjects($(items))
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
