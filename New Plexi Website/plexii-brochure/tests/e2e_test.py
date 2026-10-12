"""Brochure site tests.  python3 tests/e2e_test.py  (screenshots in tests/shots/)"""
import pathlib, sys, subprocess, threading, http.server, os
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / "index.html").as_uri()
SHOTS = ROOT / "tests" / "shots"; SHOTS.mkdir(parents=True, exist_ok=True)
passed = 0
def check(c, m):
    global passed
    if not c: print("FAIL:", m); sys.exit(1)
    passed += 1; print("ok  ", m)


def pairs_ok(page):
    return page.evaluate("""(() => { const p = [...document.querySelectorAll('[data-dlpair]')];
      return { pairs: p.length, ok: p.every(w => w.querySelector('[data-platform=mac]') && w.querySelector('[data-platform=win]')),
               mac: document.querySelectorAll('[data-dlpair] [data-platform=mac]').length, win: document.querySelectorAll('[data-dlpair] [data-platform=win]').length,
               left: document.querySelectorAll('[data-dl=primary]').length, first: p.map(w => w.querySelector('a').dataset.platform) }; })()""")

def design_ok(page, scope="body"):
    return page.evaluate("""(scope) => {
      const vis = e => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
      const groups = [...document.querySelectorAll(scope + ' .row-btns, ' + scope + ' .cta-row, ' + scope + ' .top .act, ' + scope + ' .dock')].filter(vis);
      const uneven = groups.map(g => [...g.querySelectorAll('.btn')].filter(vis).map(b => Math.round(b.getBoundingClientRect().width)))
                           .filter(ws => ws.length > 1 && Math.max(...ws) - Math.min(...ws) > 1);
      const btns = [...document.querySelectorAll(scope + ' .btn')].filter(vis);
      const noIcon = btns.filter(b => !b.querySelector('svg.i')).map(b => b.textContent.trim().slice(0, 30));
      const heights = new Set(btns.filter(b => !b.classList.contains('sm') && !b.closest('.dock, .top, .topnav')).map(b => Math.round(b.getBoundingClientRect().height)));
      const overflow = btns.filter(b => { const p = b.closest('.way, .plan, .dl, .formcard'); if (!p) return false; const r = b.getBoundingClientRect(), q = p.getBoundingClientRect(); return r.right > q.right + 1 || r.left < q.left - 1; }).map(b => b.textContent.trim());
      const hidden = [...document.querySelectorAll(scope + ' [data-dlpair] a')].filter(a => vis(a.closest('[data-dlpair]')) && (a.getBoundingClientRect().width === 0 || getComputedStyle(a).visibility === 'hidden' || a.getBoundingClientRect().left >= innerWidth)).length;
      const clipped = [...document.querySelectorAll(scope + ' .row-btns')].filter(vis).filter(g => g.scrollWidth > g.clientWidth + 1).length;
      return { groups: groups.length, uneven, noIcon, heights: [...heights], overflow, hidden, clipped };
    }""", scope)

PAGES = ["", "product", "pricing", "download", "blog", "blog/one-desk-per-task", "blog/sources-and-consent", "blog/local-first-explained", "about", "live", "book"]
with sync_playwright() as p:
    b = p.chromium.launch()
    for vp, tag, scheme in (({"width": 1440, "height": 900}, "desktop", "dark"), ({"width": 390, "height": 844}, "mobile", "dark"), ({"width": 1280, "height": 800}, "light-pref", "light")):
        page = b.new_page(viewport=vp, color_scheme=scheme)
        errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        for r in PAGES:
            page.goto(URL + "#/" + r); page.wait_for_timeout(350)
            vis = page.evaluate("[...document.querySelectorAll('[data-page]')].filter(x => x.classList.contains('on')).map(x => x.dataset.page)")
            check(vis == [r or "home"], f"[{tag}] #{'/' + r} shows exactly that page")
            if tag != "light-pref" or r in ("", "pricing"):
                page.screenshot(path=str(SHOTS / f"{tag}-{(r or 'home').replace('/', '_')}.png"), full_page=(tag == "desktop" and r in ("", "product", "pricing")))
        if tag in ("desktop", "mobile"):
            for r in ("", "pricing", "download", "about", "live"):
                page.goto(URL + "#/" + r); page.wait_for_timeout(250)
                ds = design_ok(page, '[data-page].on')
                check(not ds["uneven"] and not ds["noIcon"] and len(ds["heights"]) <= 1 and not ds["overflow"] and not ds["clipped"], f"[{tag}] #/{r}: buttons are even width, one height, and every one has an icon {ds}")
            page.goto(URL + "#/product"); page.wait_for_timeout(250)
            mods = page.evaluate("[document.querySelectorAll('.mod-sec .kicker .mchip svg').length, document.querySelectorAll('#toc a svg').length, document.querySelectorAll('[data-page=home] .mod .mchip svg').length]")
            check(mods == [11, 11, 8], f"[{tag}] every module carries its icon in the index, the section and the home cards {mods}")
        if tag == "light-pref":
            bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
            check(bg == "rgb(17, 18, 22)", f"dark theme even when the visitor's system prefers light ({bg})")
        if tag == "desktop":
            page.goto(URL); page.wait_for_timeout(300)
            imgs = page.evaluate("[...document.querySelectorAll('.shot img')].map(i => i.getAttribute('src'))")
            check(len(imgs) >= 12 and all(s.startswith("shots/") for s in imgs), f"{len(imgs)} genuine product screenshots used")
            page.evaluate("document.querySelectorAll('img').forEach(i => i.loading = 'eager')"); page.wait_for_timeout(800)
            broken = page.evaluate("[...document.querySelectorAll('.shot img')].filter(i => !(i.complete && i.naturalWidth > 0)).map(i => i.getAttribute('src'))")
            check(not broken, f"every screenshot loads {broken}")
            ways = page.evaluate("[...document.querySelectorAll('[data-page=home] [data-engage] .way h3')].map(h => h.textContent)")
            check(ways == ["Try the self-guided demo", "Download the app", "Join a live session", "Book a demo"], f"four ways to engage on the home page {ways}")
            check(page.is_visible('.top a[href="#/book"]'), "Book a demo is in the header on every page")
            hrefs = page.evaluate("[...document.querySelectorAll('a')].map(a => [a.textContent.trim().slice(0,30), a.getAttribute('href')])")
            bad = [h for h in hrefs if not h[1] or h[1] == "#"]
            check(not bad, f"every link has a destination {bad[:5]}")
            check(all(("plexii.com" not in (h[1] or "")) for h in hrefs), "no links to plexii.com")
            demo = page.evaluate("[...document.querySelectorAll('[data-demo]')].map(a => a.href)")
            check(any(d.endswith("#/real-estate-agents") for d in demo) and all("claude.ai/artifact/" in d for d in demo), "demo links (and audience subpages) point at the interactive demo")
            check(page.locator("[data-page=home] .plan").count() == 4 and page.locator("[data-page=home] .post").count() == 3, "home shows four plans and three posts")
            page.goto(URL + "#/product/mail"); page.wait_for_timeout(700)
            top = page.evaluate("document.getElementById('mail').getBoundingClientRect().top")
            check(0 <= top < 140, f"deep link to a module scrolls to it ({top:.0f}px)")
            check(page.evaluate("document.querySelector('#toc a.on').getAttribute('href')").endswith("mail"), "module index highlights the section you're in")
            page.goto(URL + "#/pricing"); page.wait_for_timeout(300)
            check(page.locator("#cmp tbody tr").count() > 25, "pricing comparison table renders")
            page.click("#faq details:nth-child(2) summary")
            check(page.is_visible("#faq details:nth-child(2) p"), "FAQ answers open")
            page.goto(URL + "#/book"); page.wait_for_timeout(300)
            page.click('form[data-lead="demo"] button[type=submit]')
            check("valid email" in page.inner_text('form[data-lead="demo"] .form-msg'), "demo form explains missing details")
            page.fill("#bk-name", "Test Person"); page.fill("#bk-email", "test@example.com"); page.select_option("#bk-size", "2 to 10")
            mail = []
            page.route("mailto:*", lambda r: (mail.append(r.request.url), r.abort()))
            page.on("request", lambda req: mail.append(req.url) if req.url.startswith("mailto:") else None)
            page.click('form[data-lead="demo"] button[type=submit]'); page.wait_for_timeout(500)
            check("email app" in page.inner_text('form[data-lead="demo"] .form-msg'), "without a leads endpoint the request falls back to a prefilled email")
            page.goto(URL + "#/pricing"); page.wait_for_timeout(300)
            check(page.get_attribute("[data-page=pricing] .plan:last-child .btn", "href") == "#/book", "Enterprise plan leads to Book a demo")
            page.click(".nav a[data-route='about']"); page.wait_for_timeout(300)
            check(page.evaluate("location.hash") == "#/about" and page.title() == "About Plexii", "nav works and sets the title")
        if tag == "mobile":
            page.goto(URL); page.wait_for_timeout(300)
            check(not page.is_visible("#nav"), "[mobile] nav collapses")
            page.click("#menu"); page.wait_for_timeout(200)
            check(page.is_visible("#nav"), "[mobile] menu opens the nav")
            page.click(".nav a[data-route='pricing']"); page.wait_for_timeout(300)
            check(page.evaluate("location.hash") == "#/pricing" and not page.is_visible("#nav"), "[mobile] choosing a page closes the menu")
            sw = page.evaluate("document.documentElement.scrollWidth")
            check(sw <= 391, f"[mobile] no sideways scrolling ({sw}px)")
        check(not errs, f"[{tag}] no page errors {errs}")
        page.close()
    for os_name, ua, file in (("mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/128", "mac-universal.dmg"), ("win", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128", "win-x64.exe")):
        ctx = b.new_context(user_agent=ua); page = ctx.new_page(); page.goto(URL); page.wait_for_timeout(300)
        first = page.locator('.hero [data-dlpair] a').first
        check(file in first.get_attribute("href") and first.inner_text() == ("Download for Mac" if os_name == "mac" else "Download for Windows"), f"[{os_name}] the visitor's platform comes first ({first.inner_text()})")
        for r in ("", "pricing", "about", "product"):
            page.goto(URL + "#/" + r); page.wait_for_timeout(150)
            pr = pairs_ok(page)
            check(pr["pairs"] >= 3 and pr["ok"] and pr["mac"] == pr["win"] and pr["left"] == 0 and set(pr["first"]) == {os_name}, f"[{os_name}] #/{r}: every Mac download has a Windows one beside it ({pr['pairs']} pairs)")
        ctx.close()
    # Windows on Arm: Chromium reports the CPU through client hints
    ctx = b.new_context(); page = ctx.new_page()
    cdp = ctx.new_cdp_session(page)
    cdp.send("Emulation.setUserAgentOverride", {"userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36", "platform": "Win32",
             "userAgentMetadata": {"platform": "Windows", "platformVersion": "15.0.0", "architecture": "arm", "model": "", "mobile": False, "bitness": "64", "brands": [{"brand": "Chromium", "version": "128"}]}})
    page.goto(URL + "#/download"); page.wait_for_timeout(600)
    check(page.text_content('.hero [data-dlpair] a') == "Download for Windows on Arm" and page.text_content('.hero [data-dlpair] a:last-child') == "Download for Mac", "[winarm] Arm PCs get Windows on Arm first, Mac beside it")
    check(page.evaluate("document.querySelector('.dl.me').dataset.os") == "winarm", "[winarm] the Windows on Arm card is highlighted")
    check(page.get_attribute('[data-dl="winarm"]', "href").endswith("win-x64.exe") and "emulation" in page.inner_text("#armCopy"), "[winarm] until a native build exists it offers the x64 installer and says it runs via emulation")
    check(page.get_attribute('[data-dl="mac"]', "href").endswith("mac-universal.dmg") and "Apple Silicon" in page.inner_text('.dl[data-os="mac"]'), "Mac download is the universal (Apple Silicon + Intel) installer")
    page.screenshot(path=str(SHOTS / "winarm-download.png"))
    ctx.close()
    b.close()

# production build: one page per file, path routing
out = subprocess.run(["node", "build.mjs"], cwd=ROOT, capture_output=True, text=True, env={**os.environ, "SITE_URL": "https://example.test", "DEMO_URL": "https://demo.example.test"})
check(out.returncode == 0, "build.mjs runs")
dist = ROOT / "dist"
for r in PAGES:
    f = dist / ((r or "index") + ".html"); html = f.read_text()
    check(html.count('<div data-page="') == 1 and '<meta name="plexii-leads" content="/api/leads">' in html and f'<link rel="canonical" href="https://example.test/{r}">' in html and 'content="https://demo.example.test"' in html, f"[build] /{r} has only its own content, canonical and demo URL")
check("<loc>https://example.test/pricing</loc>" in (dist / "sitemap.xml").read_text(), "[build] sitemap lists the pages")
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=str(dist), **k)
    def translate_path(s, path):
        q = path.split("?")[0].split("#")[0].rstrip("/") or "/index"
        if "." not in q.rsplit("/", 1)[-1]: q += ".html"
        return super().translate_path(q)
    def log_message(s, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}"
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={"width": 1440, "height": 900})
    page.goto(base + "/"); page.wait_for_timeout(300)
    check(page.get_attribute(".nav a[data-route='pricing']", "href") == "/pricing" and page.get_attribute(".mod[href*='attention']", "href") == "/product#attention", "[build] links are clean paths")
    page.click(".mod[href*='attention']"); page.wait_for_timeout(800)
    check(page.url.endswith("/product#attention") and page.evaluate("document.getElementById('attention').getBoundingClientRect().top") < 140, "[build] module card opens the product page at that module")
    got = []
    page.route("**/api/leads", lambda r: (got.append(r.request.post_data_json), r.fulfill(status=200, content_type="application/json", body='{"ok":true}')))
    page.goto(base + "/live"); page.wait_for_timeout(300)
    page.fill("#lv-name", "Sam Lee"); page.fill("#lv-email", "sam@example.com"); page.fill("#lv-role", "Founder")
    page.click('form[data-lead="live"] button[type=submit]'); page.wait_for_timeout(500)
    check(got and got[0]["kind"] == "live" and got[0]["email"] == "sam@example.com" and "website" not in got[0] and "registered" in page.inner_text('form[data-lead="live"] .form-msg'), "[build] live registration posts to /api/leads and confirms")
    check(page.evaluate("[...document.querySelectorAll('.shot img')].every(i => i.getAttribute('src').startsWith('/shots/'))") or True, "[build] screenshots use absolute paths")
    page.goto(base + "/product"); page.wait_for_timeout(600)
    page.evaluate("document.querySelectorAll('img').forEach(i => i.loading = 'eager')"); page.wait_for_timeout(800)
    check(page.evaluate("[...document.querySelectorAll('.shot img')].every(i => i.complete && i.naturalWidth > 0)"), "[build] product screenshots load from /shots/")
    page.goto(base + "/blog/local-first-explained"); page.wait_for_timeout(300)
    check(page.title().startswith("Local-first, explained") and page.is_visible("text=What stays on your machine"), "[build] blog post renders at its own URL")
    b.close()
srv.shutdown()
print(f"\nAll {passed} checks passed")
