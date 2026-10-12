"""End-to-end + unit tests for the PlexiDesk interactive site.

Run:  pip install playwright && python -m playwright install chromium
      python tests/e2e_test.py            (screenshots land in tests/shots/)
Exits non-zero on the first failed check.
"""
import pathlib, sys, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / "index.html").as_uri()
SHOTS = ROOT / "tests" / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)

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
      return { groups: groups.length, uneven, noIcon, heights: [...heights] };
    }""", scope)

CHAPTERS = ["chaos", "desk", "office", "widgets", "views", "capture", "browse", "ask", "tasks", "lockin", "people", "return", "local", "cta"]
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        print("FAIL:", msg)
        sys.exit(1)
    passed += 1
    print("ok  ", msg)


def goto_chapter(page, name):
    page.evaluate(f"document.querySelector('.chapter[data-state=\"{name}\"]').scrollIntoView({{block:'center'}})")
    page.wait_for_function(f"window.__plexii.state === '{name}'", timeout=4000)
    page.wait_for_timeout(1000)


def run(viewport, tag, scheme="dark"):
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport=viewport, color_scheme=scheme)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and "fonts" not in m.text and errors.append(m.text))
        page.goto(URL)
        page.wait_for_timeout(900)

        check(page.is_visible("#hero h1"), f"[{tag}] hero question is the first thing shown")
        check(page.evaluate("document.body.classList.contains('locked')"), f"[{tag}] page scroll locked until a desk exists")
        page.screenshot(path=str(SHOTS / f"{tag}-00-hero.png"))

        if tag == "desktop":
            # ---- unit checks against the in-page model ----
            r = page.evaluate("""() => {
              const P = window.__plexii, fb = P.localSpec('Founder','x');
              const bad = P.normalise({deskName:'<script>alert(1)</script>Launch', tools:'nope', doc:{paragraphs:[1,2]},
                 sheet:{highlight:{row:9,col:0}}, ask:{sources:['Made up', fb.sheet.title]}, tasks:[{title:'T', source:'ghost'}]}, fb);
              return {name: bad.deskName, tools: bad.tools.length, paras: bad.doc.paragraphs.length,
                hl: bad.sheet.highlight, srcs: bad.ask.sources, tsrc: bad.tasks[0].source, titles: P.itemTitles(bad),
                nulls: JSON.stringify(P.normalise(null, fb)) === JSON.stringify(P.normalise({}, fb))};
            }""")
            check("<" not in r["name"] and ">" not in r["name"], "normalise strips markup from model output")
            check(r["tools"] == 6 and r["paras"] == 3, "normalise enforces array sizes")
            check(r["hl"]["col"] >= 1 and r["hl"]["row"] <= 4, "normalise rejects an out-of-range sheet highlight")
            check(all(s in r["titles"] for s in r["srcs"]) and len(r["srcs"]) >= 2, "Ask sources always point at real desk items")
            check(r["tsrc"] in r["titles"], "task sources always point at real desk items")
            check(r["nulls"], "null and empty input both fall back cleanly")
            roles = {"Agency founder": "account", "Freelance accountant": "accountant", "Growth marketer": "marketing", "Senior engineer": "techlead",
                     "Account executive": "sales", "Customer success manager": "csm", "Solutions architect": "techlead", "Landscape architect": "architect",
                     "Real estate agent": "realestate", "Brand designer": "designer", "Interior designer": "architect", "Uni student": "student",
                     "PhD student": "academic", "Startup CEO": "founder", "Marketing manager": "marketing",
                     "Family lawyer": "lawyer", "Talent acquisition partner": "recruiter", "UX researcher": "ux", "Senior lecturer": "academic",
                     "Reporter": "journalist", "Year 3 teacher": "teacher", "Executive assistant to the CEO": "ea", "Wedding planner": "events",
                     "People and culture lead": "hr", "Café owner": "smallbiz", "YouTuber": "creator", "Fundraising manager": "grants",
                     "Product owner": "product", "Management consultant": "consultant", "Nurse": None}
            got = page.evaluate("r => Object.fromEntries(Object.keys(r).map(k => [k, window.__plexii.matchPersona(k)]))", roles)
            check(got == roles, f"typed roles map to the right persona {[(k, got[k], v) for k, v in roles.items() if got[k] != v]}")
            order = page.evaluate("[...document.querySelectorAll('#roles button')].map(b => b.dataset.key)")
            check(len(order) == 20 and order == page.evaluate("window.__plexii.PERSONA_ORDER"), "all 20 personas offered, in the briefed order")
            clean = page.evaluate("""() => Object.keys(window.__plexii.LIB).map(k => { const d = window.__plexii.localSpec(window.__plexii.LIB[k].label, '', k);
               const raw = window.__plexii.LIB[k]; const j = JSON.stringify(d);
               return [k, !j.includes('…') && d.doc.paragraphs.join() === raw.doc.paragraphs.join() && d.ask.answer === raw.ask.answer
                 && JSON.stringify(d.ask.sources) === JSON.stringify(raw.ask.sources) && d.tasks.every((t, i) => t.source === raw.tasks[i].source)
                 && d.deskName === raw.deskName && d.story && d.story.pain === raw.story.pain]; }).filter(x => !x[1])""")
            check(clean == [], f"every persona's content survives validation untouched (no truncation, real sources) {clean}")
            pj = page.evaluate("""() => [window.__plexii.parseJSON('```json\\n{\"a\":1}\\n```'), window.__plexii.parseJSON('Sure: {\"a\":2} done'), window.__plexii.parseJSON('nope')]""")
            check(pj == [{"a": 1}, {"a": 2}, None], "tolerant JSON parsing")
            check("<work>" in page.evaluate("window.__plexii.buildPrompt('r','t')"), "prompt fences user input as data")
            # every preset is internally consistent: figure appears in doc and matches the highlighted cell
            cons = page.evaluate("""() => Object.keys(window.__plexii.LIB).map(k => { const d = window.__plexii.localSpec(window.__plexii.LIB[k].roleLabel, 'x');
               const c = d.sheet.rows[d.sheet.highlight.row][d.sheet.highlight.col]; return [k, d.doc.figure === c && d.doc.paragraphs.some(p => p.includes(c))]; })""")
            check(all(ok for _, ok in cons), f"every preset links its doc figure to its sheet cell {cons}")
            charts = page.evaluate("""() => Object.keys(window.__plexii.LIB).map(k => { const d = window.__plexii.localSpec(window.__plexii.LIB[k].roleLabel, 'x');
               const c = window.__plexii.sheetChart(d); return [k, !!c && c.querySelectorAll('i').length >= 3 && !!c.querySelector('i.on')]; })""")
            check(all(ok for _, ok in charts), f"every preset charts a same-unit sheet column with the highlighted bar {charts}")
            mixed = page.evaluate("""() => { const d = window.__plexii.localSpec('Founder','x'); d.sheet.rows = [['a','$1k','',''],['b','5%','',''],['c','3 hrs','',''],['d','$2k','',''],['e','x','','']]; d.sheet.highlight = {row:0,col:1}; return window.__plexii.sheetChart(d); }""")
            check(mixed is None, "mixed-unit columns fall back to bullets instead of a misleading chart")
            # ---- links: nothing points at the parked domain, everything at the live site or the GitHub release ----
            hrefs = page.evaluate("[...document.querySelectorAll('a[href]')].filter(a => !a.getAttribute('href').startsWith('#')).map(a => a.href)")
            check(not any("plexii.com" in h for h in hrefs), "no links to plexii.com (parked domain)")
            check(all(h.startswith("https://haptyx-web.vercel.app/") or h.startswith("https://github.com/saasmouth/focusbuddy/releases/download/v4.3.26/") or h.startswith("https://github.com/saasmouth/focusbuddy/releases/download/v4.3.8/") or h.startswith("https://claude.ai/artifact/A9GC12xHyXXaYrjgMRjT1y") for h in hrefs), "every link goes to the live site, the brochure site or a verified platform release")
            eng = page.evaluate("Object.fromEntries([...document.querySelectorAll('[data-link=live],[data-link=book]')].map(a => [a.dataset.link + (a.closest('.chapter') ? '-cta' : a.closest('.dock') ? '-dock' : '-nav'), a.href]))")
            check(eng.get("live-cta", "").endswith("#/live") and eng.get("book-cta", "").endswith("#/book") and eng.get("book-dock", "").endswith("#/book"), f"live session and book-a-demo options in the final chapter and dock {list(eng)}")
            check(page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(17, 18, 22)", "dark theme")
            learn = page.evaluate("[...document.querySelectorAll('[data-link=learn]')].map(a => a.closest('.hero, .chapter, .dock') ? (a.closest('.chapter') ? 'cta' : a.closest('.dock') ? 'dock' : 'hero') : 'other')")
            check(sorted(set(learn)) == ["cta", "dock", "hero"], f"'Learn more' appears in the hero, the final call to action and the explore dock {learn}")
            check(page.get_attribute('.meta-links [data-link="bPricing"]', "href").endswith("#/pricing") and page.get_attribute('.meta-links [data-link="bProduct"]', "href").endswith("#/product"), "plan and module links go to the brochure's pricing and product pages")
            icons = page.evaluate("[document.querySelectorAll('.count .ci').length, document.querySelectorAll('.win-bar .wi svg').length, document.querySelectorAll('#wdock button svg').length]")
            check(icons == [14, 12, 7], f"every chapter, widget and widget-bar button carries its icon {icons}")
            pr = pairs_ok(page)
            check(pr["pairs"] >= 4 and pr["ok"] and pr["mac"] == pr["win"] and pr["left"] == 0, f"every download call to action offers Mac and Windows together ({pr['pairs']} pairs)")

            # ---- validation ----
            page.click("#go")
            check("role" in page.inner_text("#err"), "empty submit explains what's missing")

        # ---- example build ----
        page.click("#example")
        page.wait_for_function("document.body.classList.contains('story-on')", timeout=8000)
        page.wait_for_timeout(700)
        check(page.evaluate("window.__plexii.state") == "chaos", f"[{tag}] build lands in chapter 1 (chaos)")
        check(page.locator(".win.in:not(.off)").count() == 5 and page.locator(".win").count() == 12, f"[{tag}] five windows on the desk, seven more widgets ready")
        page.screenshot(path=str(SHOTS / f"{tag}-01-chaos.png"))

        for i, ch in enumerate(CHAPTERS[1:], start=2):
            goto_chapter(page, ch)
            if ch == "office" and tag == "desktop":
                check(page.evaluate("document.getElementById('links').classList.contains('on')"), "office chapter draws sheet-to-doc link")
            if ch == "widgets":
                check(page.locator('.win[data-k="mindmap"]:not(.off)').count() == 1 and page.locator('.win[data-k="doc"].off').count() == 1, f"[{tag}] widget chapter swaps the docs for the widget set")
                if tag == "desktop":
                    page.locator(".mmn:not(.root)").nth(1).click(); page.wait_for_timeout(200)
                    check(page.locator(".mmn.sug").count() == 2, "mind map branch opens two suggested children")
                    check(page.evaluate("document.getElementById('ghost').classList.contains('on')"), "ghost line links the sticky to the mind map")
                    box = page.locator('.win[data-k="scratch"] canvas').bounding_box()
                    page.mouse.move(box["x"] + 20, box["y"] + 20); page.mouse.down(); page.mouse.move(box["x"] + 120, box["y"] + 70, steps=8); page.mouse.up()
                    inked = page.evaluate("(() => { const c = document.querySelector('.win[data-k=scratch] canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()")
                    check(inked > 500, f"the scratchpad takes drawing ({inked} inked pixels)")
            if ch == "views":
                first = page.evaluate("document.querySelector('#tvTabs [aria-pressed=true]').textContent")
                page.wait_for_timeout(2500)
                check(page.evaluate("document.querySelector('#tvTabs [aria-pressed=true]').textContent") != first, f"[{tag}] the table cycles through its views on its own")
                if tag == "desktop":
                    for v, sel, n in (("Kanban", ".kb-col", 3), ("Calendar", ".tv-cal > div", 5), ("Gantt", ".tv-gantt .bar", 5), ("Cards", ".tv-cards > div", 5), ("List", ".tv-list > div", 5), ("Table", ".tv-grid tr", 6)):
                        page.click(f"#tvTabs button:text-is('{v}')")
                        check(page.locator(sel).count() == n, f"table {v} view renders ({page.locator(sel).count()})")
                    page.wait_for_timeout(2500)
                    check(page.evaluate("document.querySelector('#tvTabs [aria-pressed=true]').textContent") == "Table", "clicking a view stops the auto-cycle")
            if ch == "capture" and tag == "desktop":
                page.click('.win[data-k="timer"] .mini.pri'); page.wait_for_timeout(2300)
                check(page.inner_text('.win[data-k="timer"] .tring b') in ("24:58", "24:57", "24:59"), "focus timer counts down")
                page.locator('.win[data-k="deck"] .keys button').nth(5).click()
                check(page.inner_text('.win[data-k="deck"] .deck-out').startswith("Ran: "), "SpeedDeck keys run")
                page.click('.win[data-k="voice"] .vtabs button:text-is("Speakers")')
                check("You:" in page.inner_text('.win[data-k="voice"] .vtext'), "voice note switches to the speakers view")
            if ch == "ask":
                check(page.is_visible("#act .btn-s.pri"), f"[{tag}] Ask asks before acting")
                page.screenshot(path=str(SHOTS / f"{tag}-{i:02d}-{ch}.png"))
                if tag == "desktop":
                    page.hover("#firstAnswer .src >> nth=0")
                    page.wait_for_timeout(300)
                    check(page.locator(".win.lit").count() == 1, "hovering a source highlights its window")
                    page.screenshot(path=str(SHOTS / f"{tag}-{i:02d}b-source-hover.png"))
                continue
            if ch == "tasks":
                check(page.locator(".task.proposed").count() == 3, f"[{tag}] tasks stay proposals until approved")
                page.click("#act .btn-s.pri")
                page.wait_for_timeout(300)
                check(page.locator(".task.proposed").count() == 0, f"[{tag}] approving turns proposals into tasks")
            if ch == "lockin":
                check(page.is_visible("#timer") and "Lock-in" in page.inner_text("#timer"), f"[{tag}] lock-in timer runs")
            if ch == "cta":
                ds = design_ok(page, '.chapter[data-state=cta]')
                check(not ds["uneven"] and not ds["noIcon"] and page.locator('.chapter[data-state=cta] .cta-row .btn').count() == 6, f"[{tag}] final chapter: six even-width buttons, each with an icon {ds}")
            if ch == "people":
                check(page.evaluate("document.getElementById('desk').classList.contains('people-on')"), f"[{tag}] collaborators join")
            if ch == "return":
                check(page.evaluate("document.getElementById('desk').classList.contains('packed')"), f"[{tag}] desk packs into overview")
            page.screenshot(path=str(SHOTS / f"{tag}-{i:02d}-{ch}.png"))

        # going back up restores the desk
        goto_chapter(page, "desk")
        check(not page.evaluate("document.getElementById('desk').classList.contains('packed')"), f"[{tag}] scrolling back reverses state")

        # ---- explore + live ask (offline path here) ----
        goto_chapter(page, "cta")
        page.click("[data-explore]")
        page.wait_for_timeout(900)
        check(page.evaluate("window.__plexii.state") == "explore", f"[{tag}] explore mode")
        if tag == "desktop":
            for kind in ("note", "calc", "table", "timer", "web", "page"):
                page.click(f'#wdock button[data-add="{kind}"]'); page.wait_for_timeout(150)
            check(page.locator(".win[data-free]").count() == 6, "the widget bar adds real widgets to the desk")
            calc = page.locator('.win[data-free] .w-calc').first
            for k in "7*8=": calc.locator(f"button:text-is('{k}')").click()
            check(calc.locator("output").inner_text() == "56", "the calculator widget calculates")
            page.locator(".win[data-free] .win-bar .x button").first.click()
            check(page.locator(".win[data-free]").count() == 5, "added widgets can be closed")
            page.evaluate("document.querySelectorAll('.win[data-free]').forEach(w => w.remove())")
        page.fill("#askInput", "What does the budget say?")
        page.click("#askBtn")
        page.wait_for_function("document.querySelectorAll('#askLog .msg-a').length >= 2 && !document.querySelector('#askLog .think')", timeout=15000)
        check(page.locator("#askLog .msg-a").last.locator(".src").count() >= 1, f"[{tag}] live answers come with sources")
        if tag == "desktop":
            w = page.locator('.win[data-k="note"] .win-bar')
            before = w.bounding_box()
            page.mouse.move(before["x"] + 40, before["y"] + 8); page.mouse.down(); page.mouse.move(before["x"] + 160, before["y"] + 90, steps=6); page.mouse.up()
            after = w.bounding_box()
            check(after["x"] - before["x"] > 80, "windows are draggable")
        page.screenshot(path=str(SHOTS / f"{tag}-12-explore.png"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        check(not page.evaluate("document.body.classList.contains('explore')"), f"[{tag}] Escape leaves explore")

        # ---- restart + personalised (offline -> role library) ----
        page.locator("[data-restart]").first.click()
        page.wait_for_timeout(500)
        check(page.is_visible("#hero h1"), f"[{tag}] restart returns to the question")
        page.fill("#role", "Backend engineer")
        page.fill("#task", "migrate billing service to the new queue")
        page.click("#go")
        page.wait_for_function("document.body.classList.contains('story-on')", timeout=20000)
        sp = page.evaluate("({n: window.__plexii.spec.deskName, d: window.__plexii.spec.doc.title, via: window.__plexii.lastVia})")
        check(sp["n"].startswith("Migrate billing"), f"[{tag}] desk is named after the visitor's work ({sp['n']})")
        check(sp["d"] == "Design doc" and sp["via"] == "local", f"[{tag}] offline fallback picks the right role preset")
        check(page.inner_text(".d-title") == sp["n"], f"[{tag}] desk title bound into the UI")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / f"{tag}-13-custom.png"))

        check(not errors, f"[{tag}] no page errors {errors}")
        b.close()


def endpoint_mode():
    """Production path: meta plexii-api set, endpoint returns model JSON (with some junk to be cleaned)."""
    import http.server, threading, functools
    html = (ROOT / "index.html").read_text().replace('<meta name="plexii-api" content="">', '<meta name="plexii-api" content="/api/personalise">')
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers(); self.wfile.write(html.encode())
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    model = {"deskName": "Term 4 science unit", "roleLabel": "Teacher", "tools": ["Gmail", "Word", "Excel", "Teams", "OneDrive", "Chrome"],
             "doc": {"title": "Unit plan", "heading": "Forces and motion", "paragraphs": ["Six lessons for Year 8.", "Last term 72% met the standard, so we add practical work.", "Book the lab."], "figure": "72%"},
             "sheet": {"title": "Results", "columns": ["Class", "Met", "Target", "Gap"], "rows": [["8A", "72%", "80%", "8 pts"], ["8B", "65%", "80%", "15"], ["8C", "70%", "80%", "10"], ["8D", "77%", "80%", "3"], ["All", "71%", "80%", "9"]], "highlight": {"row": 0, "col": 1}},
             "web": {"title": "Hands-on physics in middle school", "domain": "teaching-research.example", "snippet": "Practical lessons lift results."},
             "note": {"title": "Ideas", "text": "Trolley ramps."}, "slides": {"title": "Lesson 1", "slideTitle": "What is a force?", "bullets": ["Push", "Pull", "Friction"]},
             "ask": {"question": "Which class needs most help?", "answer": "8B, at 65%.", "sources": ["Results", "<img src=x onerror=alert(1)>"], "proposedAction": "Create 3 tasks", "actionResult": "Created 3 tasks"},
             "tasks": [{"title": "Book lab", "source": "Unit plan", "due": "Mon"}, {"title": "Print sheets", "source": "nowhere", "due": "Tue"}],
             "otherDesks": ["Reports", "Excursion", "Marking"], "collaborators": [{"name": "Ruth Smith", "role": "Head of science"}, {"name": "Ben", "role": "Lab tech"}], "chat": {"from": "Ruth", "text": "Lab is booked."}}
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={"width": 1440, "height": 900})
        seen = []
        page.route("**/api/personalise", lambda route: (seen.append(route.request.post_data_json), route.fulfill(status=200, content_type="application/json", body=json.dumps(model))))
        page.goto(f"http://127.0.0.1:{srv.server_address[1]}/")
        page.fill("#role", "Teacher"); page.fill("#task", "Term 4 science unit"); page.click("#go")
        page.wait_for_function("document.body.classList.contains('story-on')", timeout=10000)
        sp = page.evaluate("window.__plexii.spec"); via = page.evaluate("window.__plexii.lastVia")
        check(via == "endpoint" and seen[0]["role"] == "Teacher" and seen[0]["task"] == "Term 4 science unit" and seen[0]["hint"].startswith("Teacher."), "[endpoint] page posts role, task and persona hint, uses the response")
        check(page.inner_text('[data-bind="storyPain"]').startswith("Lesson plans"), "[endpoint] AI-written desk still tells the teacher story")
        check(sp["deskName"] == "Term 4 science unit" and sp["doc"]["figure"] == "72%", "[endpoint] model content lands on the desk")
        check(sp["ask"]["sources"] == ["Results"] or "Results" in sp["ask"]["sources"], "[endpoint] invented sources dropped")
        check(sp["tasks"][1]["source"] == "Unit plan" and len(sp["tasks"]) == 3, "[endpoint] task sources repaired, missing task filled")
        check(sp["collaborators"][0]["name"] == "Ruth" and sp["chat"]["from"] == "Ruth", "[endpoint] collaborator names trimmed to first names")
        check(page.locator("img").count() == 0, "[endpoint] no markup injected from model output")
        page.screenshot(path=str(SHOTS / "endpoint-01.png"))
        # endpoint down -> falls back without breaking
        page.unroute("**/api/personalise")
        page.route("**/api/personalise", lambda route: route.fulfill(status=503, body="{}"))
        page.locator("[data-restart]").first.click(); page.wait_for_timeout(400)
        page.fill("#role", "Freelance accountant"); page.fill("#task", "EOFY close for three clients"); page.click("#go")
        page.wait_for_function("document.body.classList.contains('story-on')", timeout=15000)
        check(page.evaluate("window.__plexii.lastVia") == "local" and page.evaluate("window.__plexii.spec.doc.title") == "Year-end notes", "[endpoint] a 503 falls back to the role library")
        b.close()
    srv.shutdown()


def personas():
    """Every persona chip builds its own ready-made story instantly, with no AI call."""
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={"width": 1440, "height": 900})
        calls = []
        page.route("**/*anthropic*", lambda r: (calls.append(r.request.url), r.abort()))
        page.goto(URL); page.wait_for_timeout(500)
        lib = page.evaluate("Object.fromEntries(window.__plexii.PERSONA_ORDER.map(k => [k, {label: window.__plexii.LIB[k].label, doc: window.__plexii.LIB[k].doc.title, desk: window.__plexii.LIB[k].deskName, pain: window.__plexii.LIB[k].story.pain, outcome: window.__plexii.LIB[k].story.outcome}]))")
        bad = []
        for i, (k, v) in enumerate(lib.items()):
            page.click(f'#roles button[data-key="{k}"]')
            if page.inner_text("#go") != f"Show me the {v['label'].lower()} desk": bad.append((k, "button"))
            page.click("#go")
            page.wait_for_function("document.body.classList.contains('story-on')", timeout=8000)
            sp = page.evaluate("({p: window.__plexii.spec.persona, d: window.__plexii.spec.doc.title, n: window.__plexii.spec.deskName, via: window.__plexii.lastVia})")
            pain = page.inner_text('[data-bind="storyPain"]'); out = page.inner_text('[data-bind="storyOutcome"]')
            if not (sp["p"] == k and sp["d"] == v["doc"] and sp["n"] == v["desk"] and sp["via"] == "persona" and pain == v["pain"] and out == v["outcome"]): bad.append((k, sp, pain[:30]))
            if k in ("lawyer", "teacher", "grants", "journalist", "events"):
                goto_chapter(page, "office")
                if not page.evaluate("document.getElementById('links').classList.contains('on')"): bad.append((k, "no chart link"))
                page.screenshot(path=str(SHOTS / f"persona-{k}-office.png"))
                goto_chapter(page, "chaos")
            if i == 0: page.screenshot(path=str(SHOTS / f"persona-{k}-chaos.png"))
            page.locator("[data-restart]").first.click(); page.wait_for_timeout(350)
        check(not bad, f"all 20 personas build their own desk and story instantly {bad}")
        check(not calls, "persona stories make no AI calls")
        page.screenshot(path=str(SHOTS / "persona-hero.png"))
        # typed role with work: personalised path keeps the persona story
        page.fill("#role", "Family lawyer"); page.fill("#task", "Property settlement for a separating couple"); page.click("#go")
        page.wait_for_function("document.body.classList.contains('story-on')", timeout=20000)
        check(page.evaluate("window.__plexii.spec.persona") == "lawyer" and page.inner_text('[data-bind="storyPain"]').startswith("Matter files"), "typed role + work keeps the matching persona story")
        # deep links
        page.goto(URL + "?persona=grant-writer"); page.wait_for_function("document.body.classList.contains('story-on')", timeout=8000)
        check(page.evaluate("window.__plexii.spec.persona") == "grants", "deep link ?persona=grant-writer opens straight into the story")
        page.goto(URL + "?persona=lawyer&work=Lease%20advice"); page.wait_for_timeout(800)
        check(page.is_visible("#hero h1") and page.input_value("#task") == "Lease advice" and page.input_value("#role") == "Lawyer", "deep link with work prefills and waits for a click (no surprise AI cost)")
        b.close()


def winarm():
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(); page = ctx.new_page()
        ctx.new_cdp_session(page).send("Emulation.setUserAgentOverride", {"userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36", "platform": "Win32",
            "userAgentMetadata": {"platform": "Windows", "platformVersion": "15.0.0", "architecture": "arm", "model": "", "mobile": False, "bitness": "64", "brands": [{"brand": "Chromium", "version": "128"}]}})
        page.goto(URL); page.wait_for_timeout(700)
        first = page.locator("#dl a").first
        check(first.inner_text() == "Download for Windows on Arm" and first.get_attribute("href").endswith("win-x64.exe") and page.locator("#dl a").nth(1).inner_text() == "Download for Mac", "[winarm] demo offers Windows on Arm first, Mac beside it")
        check("Windows 11 on Arm" in page.inner_text("#dlNote") and "Apple Silicon and Intel" in page.inner_text("#dlNote"), "platform note covers Apple Silicon and Windows on Arm")
        b.close()


def snapping():
    """Every chapter is a stop: one gesture moves one chapter, however hard."""
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp, tag in (({"width": 1440, "height": 900}, "desktop"), ({"width": 390, "height": 844}, "mobile")):
            page = b.new_page(viewport=vp); page.goto(URL); page.wait_for_timeout(400)
            page.click("#example"); page.wait_for_function("document.body.classList.contains('story-on')"); page.wait_for_timeout(900)
            st = lambda: page.evaluate("window.__plexii.state")
            check(page.evaluate("getComputedStyle(document.documentElement).scrollSnapType").startswith("y mandatory") and
                  page.evaluate("getComputedStyle(document.querySelector('.chapter')).scrollSnapStop") == "always", f"[{tag}] CSS snap with a stop on every chapter (touch, scrollbar)")
            page.mouse.move(200, 400)
            page.mouse.wheel(0, 6000); page.wait_for_timeout(1300)
            check(st() == "desk", f"[{tag}] a hard flick stops at the very next chapter ({st()})")
            for _ in range(30):                       # trackpad-style momentum tail: many small deltas
                page.mouse.wheel(0, 90); page.wait_for_timeout(20)
            page.wait_for_timeout(1300)
            check(st() == "office", f"[{tag}] one long momentum swipe still moves just one chapter ({st()})")
            page.mouse.wheel(0, 120); page.wait_for_timeout(1300)
            check(st() == "widgets", f"[{tag}] a fresh, deliberate scroll moves on ({st()})")
            page.mouse.wheel(0, -5000); page.wait_for_timeout(1300)
            check(st() == "office", f"[{tag}] scrolling up also stops one chapter at a time ({st()})")
            page.keyboard.press("PageDown"); page.wait_for_timeout(1300)
            check(st() == "widgets", f"[{tag}] PageDown moves one chapter")
            page.keyboard.press("End"); page.wait_for_timeout(1600)
            check(st() == "cta", f"[{tag}] End jumps to the last chapter")
            aligned = page.evaluate("Math.abs(scrollY - document.querySelector('.chapter[data-state=cta]').offsetTop)")
            check(aligned < 3, f"[{tag}] it settles exactly on the chapter ({aligned}px off)")
            if tag == "desktop":
                goto_chapter(page, "ask")
                for i in range(6):                     # fill the answer log so it can scroll
                    page.evaluate("document.getElementById('askLog').append(Object.assign(document.createElement('div'), {className: 'msg-a', textContent: 'filler '.repeat(80)}))")
                box = page.locator("#askLog").bounding_box()
                page.mouse.move(box["x"] + 40, box["y"] + 60)
                before = page.evaluate("document.getElementById('askLog').scrollTop")
                page.mouse.wheel(0, 300); page.wait_for_timeout(600)
                check(page.evaluate("document.getElementById('askLog').scrollTop") > before and st() == "ask", "wheeling over the Plexii panel scrolls the panel, not the chapter")
                page.mouse.move(200, 400)
                goto_chapter(page, "cta"); page.click("[data-explore]"); page.wait_for_timeout(600)
                check(not page.evaluate("document.documentElement.classList.contains('snap')"), "explore mode releases the scroll stops")
            page.close()
        b.close()


def landings():
    """The five campaign subpages: hash routes in the single file, path routes in the built site."""
    expect = {"real-estate-agents": ("realestate", "POV: six listings, and the vendor just called", "One desk per listing.", "Show me a listing desk", "Review & send", "Less admin. More listings."),
              "graphic-designers": ("designer", "The client said “make it pop.”", "One desk per client.", "Show me a client desk", "Add tasks", "Less hunting. More designing."),
              "marketing-teams": ("marketing", "Our launch lived in nine different tools", "One desk per campaign.", "Show me a campaign desk", "Add to calendar", "One brief. One team. One desk."),
              "university-students": ("student", "Essay due Friday. 41 tabs of readings.", "One desk per assignment.", "Show me an assignment desk", "Add sources", "It finds your sources. You write the essay."),
              "startup-founders": ("founder", "Fundraising is six jobs at once", "One desk per raise.", "Show me a raise desk", "Update slide", "Less time on admin. More time raising.")}
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={"width": 1440, "height": 900})
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        for slug, (key, hook, tag, cta, apply_label, outcome) in expect.items():
            page.goto(URL + "#/" + slug); page.wait_for_timeout(500)
            ok = (page.inner_text("#heroTitle") == hook and page.inner_text("#tagline") == tag and page.inner_text("#go") == cta
                  and not page.is_visible("#roleField") and page.evaluate("window.__plexii.spec.persona") == key and page.evaluate("window.__plexii.slug") == slug)
            check(ok, f"[{slug}] subpage hero: hook, tagline, CTA, persona desk behind it")
            check(all("utm_campaign=" + slug in h for h in page.evaluate("[...document.querySelectorAll('[data-link]')].map(a => a.href)") if "vercel.app" in h and "privacy" not in h), f"[{slug}] site links carry the campaign UTM")
            page.click("#go"); page.wait_for_function("document.body.classList.contains('story-on')", timeout=8000)
            check(page.inner_text("#deskHead") == tag and page.inner_text('[data-bind="storyOutcome"]') == outcome, f"[{slug}] story uses the subpage tagline and outcome")
            goto_chapter(page, "ask")
            check(page.inner_text("#act .btn-s.pri") == apply_label, f"[{slug}] approval button says '{apply_label}'")
            if slug == "real-estate-agents":
                page.screenshot(path=str(SHOTS / f"landing-{slug}-ask.png"))
                page.click("#act .btn-s.pri"); page.wait_for_timeout(200)
                check("Nothing sends until you press send" in page.inner_text("#act"), "[real-estate] the vendor report waits for the agent")
                goto_chapter(page, "tasks")
                check(page.locator(".task.proposed").count() == 0 and "links back" in page.inner_text("#taskNudge"), "[real-estate] tasks aren't shown as proposals when the card doesn't create them")
            if slug == "university-students":
                check("You write the essay" in page.inner_text("#firstAnswer"), "[student] Plexii finds sources and leaves the writing to the student")
            page.locator("[data-restart]").first.click(); page.wait_for_timeout(400)
            check(page.inner_text("#heroTitle") == hook, f"[{slug}] building another desk stays on the subpage")
        page.goto(URL + "#/real-estate-agents"); page.wait_for_timeout(400)
        page.screenshot(path=str(SHOTS / "landing-real-estate-agents-hero.png"))
        page.goto(URL + "#/university-students"); page.wait_for_timeout(400)
        page.screenshot(path=str(SHOTS / "landing-university-students-hero.png"))
        # navigation: main -> subpage -> back, without reloads
        page.goto(URL); page.wait_for_timeout(400)
        links = page.evaluate("[...document.querySelectorAll('#madeFor a')].map(a => a.getAttribute('href'))")
        check(links == ["#/real-estate-agents", "#/graphic-designers", "#/marketing-teams", "#/university-students", "#/startup-founders"], f"main page links to all five subpages {links}")
        page.click('#madeFor a[data-slug="startup-founders"]'); page.wait_for_timeout(400)
        check(page.inner_text("#heroTitle") == "Fundraising is six jobs at once", "clicking a subpage link switches the hero in place")
        page.click('#madeFor a[data-slug=""]'); page.wait_for_timeout(400)
        check(page.inner_text("#heroTitle") == "What's on your plate this week?" and page.is_visible("#roleField"), "'Every role' returns to the main page")
        check(not errors, f"no page errors on subpages {errors}")
        b.close()
    # production build: path routes + per-page meta
    import subprocess, http.server, threading
    out = subprocess.run(["node", "build.mjs"], cwd=ROOT, capture_output=True, text=True, env={**__import__("os").environ, "SITE_URL": "https://example.test"})
    check(out.returncode == 0, f"build.mjs runs {out.stderr[:200]}")
    dist = ROOT / "dist"
    for slug, (key, hook, tag, *_ ) in expect.items():
        html = (dist / f"{slug}.html").read_text()
        check(f'<link rel="canonical" href="https://example.test/{slug}">' in html and '<meta name="plexii-routes" content="path">' in html and '<meta name="plexii-api" content="/api/personalise">' in html and tag.replace(".", "").lower() in html.split("<title>")[1].split("</title>")[0], f"[build] {slug}.html has its own title, canonical, routes and API")
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(s, *a, **k): super().__init__(*a, directory=str(dist), **k)
        def translate_path(s, path):
            p = path.split("?")[0].rstrip("/")
            if p and "." not in p.rsplit("/", 1)[-1]: path = (p or "/index") + ".html"
            return super().translate_path(path)
        def log_message(s, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page()
        page.goto(f"http://127.0.0.1:{srv.server_address[1]}/graphic-designers"); page.wait_for_timeout(600)
        check(page.inner_text("#heroTitle") == "The client said “make it pop.”", "[build] /graphic-designers opens the designer subpage by path")
        check(page.evaluate("[...document.querySelectorAll('#madeFor a')].map(a => a.getAttribute('href'))")[0] == "/real-estate-agents", "[build] subpage links are clean paths in production")
        b.close()
    srv.shutdown()


def os_links():
    cases = {"mac": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/128 Safari/537.36", "PlexiDesk-4.3.26-mac-universal.dmg", "Download for Mac", "Haptyx-4.3.8-win-x64.exe"),
             "win": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36", "Haptyx-4.3.8-win-x64.exe", "Download for Windows", "PlexiDesk-4.3.26-mac-universal.dmg"),
             "mobile": ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "PlexiDesk-4.3.26-mac-universal.dmg", "Download for Mac", "Haptyx-4.3.8-win-x64.exe")}
    with sync_playwright() as p:
        b = p.chromium.launch()
        for os_name, (ua, file, label, other) in cases.items():
            ctx = b.new_context(user_agent=ua); page = ctx.new_page(); page.goto(URL); page.wait_for_timeout(300)
            check(page.evaluate("window.__plexii.os") == os_name, f"[{os_name}] OS detected")
            links = page.locator("#dl a"); href = links.first.get_attribute("href"); text = links.first.text_content()
            check(file in href and text == label, f"[{os_name}] main CTA leads with: {text} -> {href.split('/')[-1]}")
            check(other in links.nth(1).get_attribute("href"), f"[{os_name}] the other platform is right beside it")
            pr = pairs_ok(page)
            check(pr["ok"] and pr["mac"] == pr["win"] and pr["left"] == 0, f"[{os_name}] every Mac download has a Windows one ({pr['pairs']} pairs)")
            ctx.close()
        b.close()


winarm()
snapping()
personas()
landings()
os_links()
endpoint_mode()
run({"width": 1440, "height": 900}, "desktop")
run({"width": 390, "height": 844}, "mobile")
run({"width": 1280, "height": 800}, "light", scheme="light")
print(f"\nAll {passed} checks passed")
