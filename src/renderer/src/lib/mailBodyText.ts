// Reading an email body as prose.
//
// Pure text work, kept out of the widget for the ordinary reason — it is the part
// worth testing, and a component cannot be imported into a node-environment test.

/**
 * Split a reply into what was newly written and the history it quotes back.
 *
 * A reply chain repeats every previous message, so the fifth reply is mostly text
 * the reader has already seen and the one new sentence is buried at the top. The
 * quoted part is returned rather than discarded: hiding it is right, losing it is
 * not, and the widget offers it behind a disclosure.
 *
 * Cuts at the first quote marker or attribution line. A message that OPENS with a
 * quote is left whole — a cut at the very first line would leave nothing to show,
 * and an empty card is worse than a slightly long one.
 */
export function splitQuoted(body: string): { main: string; quoted: string } {
  const lines = body.replace(/\r/g, '').split('\n')
  const cut = lines.findIndex((raw) => {
    const l = raw.trim()
    return (
      /^>/.test(l) ||
      // "On Tue, 3 Mar 2026 at 09:14, Dana Reed wrote:"
      /^On .{6,120}\bwrote:\s*$/i.test(l) ||
      /^-{2,}\s*(Original Message|Forwarded message)/i.test(l) ||
      // Outlook's divider.
      /^_{10,}$/.test(l) ||
      /^From:\s.+/.test(l)
    )
  })
  if (cut <= 0) return { main: body.trim(), quoted: '' }
  return {
    main: lines.slice(0, cut).join('\n').trim(),
    quoted: lines.slice(cut).join('\n').trim()
  }
}
