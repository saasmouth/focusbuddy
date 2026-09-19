// Getting the cookie wall out of the way.
//
// Reported as: the run "seems to get stuck with pop ups like cookie consent,
// doing the same thing over and over and costing money to not achieve
// anything." All three symptoms, one cause.
//
// Nearly every page on the open web opens with a consent dialog. It covers the
// content, it usually freezes scrolling, and it is the most prominent thing on
// screen — so the model clicks at it. Meanwhile `read_page` returns the
// banner's text instead of the article, and the element ranker actively pushes
// banner controls DOWN (they are unlabelled links in a div) so the model often
// cannot even see the button that would dismiss it. The run then reads the same
// nothing, tries the same click, and pays for a round each time.
//
// PLEXII DOES NOT CONSENT ON YOUR BEHALF. It would be easy to click "Accept
// all" — one selector per vendor and every wall falls. But this browser has a
// persistent profile: that click sets real tracking cookies in the session you
// browse with, and nobody asked for it. It sits with signing in, paying and
// moving files on the list of things the agent does not do for you.
//
// So this hides the overlay and gives the page its scrolling back. No consent
// is given, no cookies are set, and the content underneath becomes readable —
// which is all the run actually needed.

// Below this area a fixed element is a toast, a chat bubble or a sticky header,
// none of which block reading. A consent wall is big.
const MIN_BLOCKING_AREA = 40_000

// What a consent dialog says. Deliberately about the SUBJECT rather than the
// buttons: "Accept" alone matches a checkout, a licence, a comment form.
const CONSENT_TEXT =
  'cookie|consent|gdpr|ccpa|privacy preference|tracking|personalised ads|personalized ads|legitimate interest|we value your privacy|your privacy choices'

/**
 * The in-page pass. Pure string-building so it tests against a real DOM.
 *
 * Every rule here is a guard against hiding the page itself, which would be a
 * far worse failure than the banner: an agent that blanks the article and then
 * reports what it read is worse than one that gets stuck.
 */
export function dismissOverlaysJs(): string {
  return `(() => {
  var hidden = [];
  var RE = new RegExp(${JSON.stringify(CONSENT_TEXT)}, 'i');
  var nodes = document.querySelectorAll('div,section,aside,dialog,form,[role="dialog"],[role="alertdialog"]');
  for (var i = 0; i < nodes.length && hidden.length < 6; i++) {
    var el = nodes[i];
    if (!el || !el.getBoundingClientRect) continue;
    var cs = null;
    try { cs = getComputedStyle(el) } catch (e) { continue }
    // A banner is pinned to the viewport. Article text is not, so this one
    // test excludes almost the whole page before anything else runs.
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var r = el.getBoundingClientRect();
    if (r.width * r.height < ${MIN_BLOCKING_AREA}) continue;
    var txt = (el.innerText || '').slice(0, 1200);
    if (!RE.test(txt)) continue;
    // Never hide something that CONTAINS the page. A few sites render the whole
    // document inside a fixed wrapper; hiding that blanks everything.
    if (el.querySelector('main, article, [role="main"]')) continue;
    if (el.contains(document.querySelector('main, article, [role="main"]'))) continue;
    var label = (txt.replace(/\\s+/g, ' ').trim().slice(0, 80)) || el.tagName.toLowerCase();
    try {
      el.style.setProperty('display', 'none', 'important');
      hidden.push(label);
    } catch (e) { /* ignore */ }
  }
  // Consent walls freeze the page behind them. Reading needs it back, and this
  // is safe to do unconditionally: a page that genuinely wants no scrolling
  // re-applies it on its own.
  var unfroze = false;
  var roots = [document.documentElement, document.body];
  for (var j = 0; j < roots.length; j++) {
    var n = roots[j];
    if (!n) continue;
    var s = null;
    try { s = getComputedStyle(n) } catch (e) { continue }
    if (s.overflow === 'hidden' || s.overflowY === 'hidden' || s.position === 'fixed') {
      n.style.setProperty('overflow', 'auto', 'important');
      n.style.setProperty('overflow-y', 'auto', 'important');
      if (s.position === 'fixed') n.style.setProperty('position', 'static', 'important');
      unfroze = true;
    }
  }
  return { hidden: hidden, unfroze: unfroze };
})()`
}

export interface OverlayResult {
  hidden: string[]
  unfroze: boolean
}

/**
 * What to tell the model, or null when nothing was in the way.
 *
 * It has to be TOLD. The banner it saw last round is simply gone this round,
 * and a model that does not know why will reasonably assume its last click
 * worked and keep using that strategy.
 */
export function overlayNotice(r: OverlayResult | null): string | null {
  if (!r) return null
  const n = r.hidden.length
  if (n === 0) return r.unfroze ? 'The page had scrolling disabled; it has been re-enabled for you.' : null
  return (
    `${n} consent or cookie ${n === 1 ? 'banner was' : 'banners were'} covering this page and ${n === 1 ? 'has' : 'have'} been hidden for you` +
    `${r.unfroze ? ', and scrolling re-enabled' : ''}. ` +
    'Do NOT try to accept, reject or close cookie dialogs — Plexii does not answer them on the user\'s behalf, and they are already out of your way. ' +
    'Read the page underneath instead.'
  )
}
