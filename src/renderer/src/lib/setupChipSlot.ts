// Where the "Set up with AI" chip can sit on an empty work widget without
// covering anything you would press. Bottom centre is the usual place. If a
// control is there it moves to the top, and if controls fill both, it stays away:
// right-click "Build with AI" still reaches the same setup.

export type ChipSlot = 'bottom' | 'top' | null

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

export function chooseChipSlot(args: {
  body: Box
  chip: { width: number; height: number }
  controls: readonly Box[]
  inset: number
}): ChipSlot {
  const { body, chip, controls, inset } = args
  // A control covering most of the widget is its whole surface (a big drop
  // target, say), and the chip has always sat on top of those.
  const small = controls.filter((c) => c.width * c.height < body.width * body.height * 0.5)
  const left = body.left + (body.width - chip.width) / 2
  const at = (top: number): Box => ({ left, top, width: chip.width, height: chip.height })
  const free = (box: Box): boolean => !small.some((c) => overlaps(box, c))
  if (free(at(body.top + body.height - inset - chip.height))) return 'bottom'
  if (free(at(body.top + inset))) return 'top'
  return null
}
