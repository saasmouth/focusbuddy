// The default keymap: key string -> [command id, 'prevent' when the browser's
// own handling must be suppressed]. ONE LINE PER BINDING, kept sorted, so two
// packages adding shortcuts never touch the same line; a unit test fails on a
// key bound twice (an object literal cannot hold one twice, and the test also
// checks the tool letters do not collide with these).
//
// Key strings: 'mod+' for ⌘/Ctrl, then 'shift+', then the key as
// KeyboardEvent.key lower-cased. A Shift chord falls back to the plain key when
// it has no binding of its own (see keyBinding).
//
// Tool letters (V, A, P, N, R, ...) are declared on the tools themselves.

export const KEYMAP: Record<string, readonly [string, 'prevent'?]> = {
  '[': ['brush.smaller'],
  ']': ['brush.larger'],
  arrowdown: ['object.nudgeDown', 'prevent'],
  arrowleft: ['object.nudgeLeft', 'prevent'],
  arrowright: ['object.nudgeRight', 'prevent'],
  arrowup: ['object.nudgeUp', 'prevent'],
  backspace: ['edit.delete', 'prevent'],
  delete: ['edit.delete', 'prevent'],
  enter: ['pen.finish'],
  escape: ['edit.escape'],
  'mod+a': ['edit.selectAll', 'prevent'],
  'mod+d': ['edit.duplicate', 'prevent'],
  'mod+shift+z': ['edit.redo', 'prevent'],
  'mod+y': ['edit.redo', 'prevent'],
  'mod+z': ['edit.undo', 'prevent']
}
