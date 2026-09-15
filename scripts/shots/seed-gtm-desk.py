"""Seed the Plexii Marketing & GTM desk into the Preview 3 database.

This is a WORKING desk, not a showcase, so the No-Fakery rule governs what
goes on it. Everything factual here is drawn from the product as it actually
is; everything forward-looking is a task or a target, labelled as such. In
particular there are NO invented metrics: the funnel starts at zero because
nothing has shipped yet, and a launch tracker showing 24,000 views before
launch would be worse than useless -- it would be the thing you check instead
of the truth.

Contacts are left empty for the same reason: inventing names for a real
campaign puts fictional people in a real address book.
"""
import json, sqlite3, uuid, os, time

DB = os.path.expanduser('~/Library/Application Support/PlexiDesk3Preview/focusbuddy.db')
NOW = int(time.time() * 1000)
DAY = 86_400_000
uid = lambda: str(uuid.uuid4())

# Local midnight, so dates land on the day a person means.
import datetime
def day(offset):
    d = datetime.date.today() + datetime.timedelta(days=offset)
    return int(datetime.datetime(d.year, d.month, d.day).timestamp() * 1000)

con = sqlite3.connect(DB); con.execute('PRAGMA foreign_keys = ON'); cur = con.cursor()

DESK = uid()
cur.execute("""INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
 sort_order,created_at,updated_at,extensions_minutes,is_plan,org_id,needs_sync,sync_rev)
 VALUES (?,NULL,'task',?,?, 'open',1,3,1,?,?,?,0,0,'personal',1,0)""",
 (DESK, 'Plexii — Marketing & GTM',
  'Go-to-market for the Plexii desktop launch: positioning, channels, assets, pricing and the funnel.',
  NOW, NOW, NOW))

# ── The plan ────────────────────────────────────────────────────────────────
# Seven workstreams, each with its own subtasks, start/due dates, an owner and
# -- where one genuinely exists -- a dependency. The dates run a six-week
# campaign from today. Owner defaults to Michael because this is a one-person
# GTM until it isn't; reassigning is one field.
#
# Several of these are outstanding items already known to be real:
# the download URL is still a placeholder, storage quotas were designed and
# never built, and the screenshot set is genuinely done.
OWNER = 'Michael'

WORKSTREAMS = [
    ('Positioning & messaging', 0, 7, [
        ('Write the one-line promise', 0, 2, 'open'),
        ('Define the ICP and three segments', 1, 4, 'open'),
        ('Teardown: Notion, Miro, Arc, Muse', 2, 5, 'open'),
        ('Test the message with five users', 5, 7, 'open'),
    ]),
    ('Website & download flow', 3, 17, [
        ('Landing page copy', 3, 8, 'open'),
        ('Product screenshots', -2, 0, 'done'),
        ('Pricing page', 9, 13, 'open'),
        ('Replace the placeholder download URL', 10, 12, 'open'),
        ('Signed + notarised build behind the button', 12, 17, 'open'),
    ]),
    ('Launch assets', 7, 21, [
        ('90-second demo video', 7, 14, 'open'),
        ('Widget showcase images', -2, 0, 'done'),
        ('Press kit and one-pager', 14, 18, 'open'),
        ('Founder launch thread draft', 16, 21, 'open'),
    ]),
    ('Pricing & packaging', 5, 19, [
        ('Decide the Pro price', 5, 10, 'open'),
        ('Free vs Pro feature split', 8, 12, 'open'),
        ('Billing integration', 12, 19, 'open'),
        ('Per-tenant storage quotas', 14, 19, 'open'),
    ]),
    ('Onboarding & activation', 10, 26, [
        ('First-run desk template', 10, 16, 'open'),
        ('Empty-state copy pass', 14, 19, 'open'),
        ('Define the activation metric', 12, 15, 'open'),
        ('Instrument first-desk-created', 17, 22, 'open'),
    ]),
    ('Measurement', 12, 24, [
        ('Define the funnel events', 12, 16, 'open'),
        ('Wire analytics end to end', 16, 22, 'open'),
        ('Weekly review cadence', 22, 24, 'open'),
    ]),
    ('Launch', 28, 42, [
        ('Product Hunt', 35, 36, 'open'),
        ('Show HN', 35, 36, 'open'),
        ('Reddit: r/macapps, r/productivity', 36, 38, 'open'),
        ('LinkedIn + X founder thread', 35, 37, 'open'),
        ('Email the waitlist', 34, 35, 'open'),
    ]),
]

def add_task(parent, title, start_off, due_off, status, order, assignee=None,
             depends_on=None, lag=None, notes=''):
    nid = uid()
    cur.execute("""INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
     sort_order,created_at,updated_at,extensions_minutes,due_date,planned_start_at,assignee,
     depends_on,lag_days,org_id,needs_sync,sync_rev)
     VALUES (?,?,'task',?,?,?,3,3,3,?,?,?,0,?,?,?,?,?,'personal',1,0)""",
     (nid, parent, title, notes, status, order, NOW, NOW,
      day(due_off), day(start_off), assignee, depends_on, lag))
    return nid

ws_ids = {}
prev = None
for i, (title, start, due, subs) in enumerate(WORKSTREAMS):
    # Launch waits on the assets being finished -- the one dependency here that
    # is a real constraint rather than a decoration.
    dep, lag = (None, None)
    if title == 'Launch' and prev:
        dep, lag = prev, 7
    wid = add_task(DESK, title, start, due, 'open', i, OWNER, dep, lag)
    ws_ids[title] = wid
    if title == 'Launch assets':
        prev = wid
    for j, (st, s_off, d_off, status) in enumerate(subs):
        add_task(wid, st, s_off, d_off, status, j, OWNER)

# ── Tables ──────────────────────────────────────────────────────────────────
def table(title, columns, rows):
    tid = uid()
    cur.execute("""INSERT INTO fb_tables (id,task_id,title,schema_json,created_at,updated_at,org_id,needs_sync,sync_rev)
                   VALUES (?,?,?,?,?,?,'personal',1,0)""",
                (tid, DESK, title, json.dumps({'columns': columns}), NOW, NOW))
    for i, cells in enumerate(rows):
        cur.execute("""INSERT INTO fb_rows (id,table_id,cells_json,sort_order,created_at,updated_at,needs_sync,sync_rev)
                       VALUES (?,?,?,?,?,?,1,0)""", (uid(), tid, json.dumps(cells), i, NOW, NOW))
    return tid

# Channels: real places a desktop productivity tool launches, with the effort
# and the owner. Results are EMPTY on purpose -- they get filled in from real
# numbers after launch, and a pre-filled "Signups" column would be fiction.
CHANNELS = table('Channel plan', [
    {'id':'ch-name','type':'text-short','label':'Channel','config':{}},
    {'id':'ch-type','type':'text-short','label':'Type','config':{}},
    {'id':'ch-when','type':'text-short','label':'When','config':{}},
    {'id':'ch-owner','type':'text-short','label':'Owner','config':{}},
    {'id':'ch-status','type':'text-short','label':'Status','config':{}},
    {'id':'ch-signups','type':'number','label':'Signups','config':{}},
], [
 {'ch-name':'Product Hunt','ch-type':'Launch','ch-when':'Week 6','ch-owner':OWNER,'ch-status':'Not started'},
 {'ch-name':'Show HN','ch-type':'Launch','ch-when':'Week 6','ch-owner':OWNER,'ch-status':'Not started'},
 {'ch-name':'r/macapps','ch-type':'Community','ch-when':'Week 6','ch-owner':OWNER,'ch-status':'Not started'},
 {'ch-name':'r/productivity','ch-type':'Community','ch-when':'Week 6','ch-owner':OWNER,'ch-status':'Not started'},
 {'ch-name':'X / LinkedIn thread','ch-type':'Owned','ch-when':'Week 6','ch-owner':OWNER,'ch-status':'Not started'},
 {'ch-name':'Waitlist email','ch-type':'Owned','ch-when':'Week 5','ch-owner':OWNER,'ch-status':'Not started'},
 {'ch-name':'Shared-desk links','ch-type':'Viral loop','ch-when':'Ongoing','ch-owner':OWNER,'ch-status':'Live'},
 {'ch-name':'Founder DMs / design partners','ch-type':'Direct','ch-when':'Weeks 1-4','ch-owner':OWNER,'ch-status':'Not started'},
])

ASSETS = table('Assets', [
    {'id':'a-name','type':'text-short','label':'Asset','config':{}},
    {'id':'a-kind','type':'text-short','label':'Kind','config':{}},
    {'id':'a-status','type':'text-short','label':'Status','config':{}},
    {'id':'a-where','type':'text-short','label':'Where','config':{}},
], [
 {'a-name':'Product screenshots (39)','a-kind':'Image set','a-status':'Done','a-where':'~/Desktop/plexii marketing screens and widgets new'},
 {'a-name':'Widget showcase (44)','a-kind':'Image set','a-status':'Done','a-where':'~/Desktop/plexii marketing screens and widgets new'},
 {'a-name':'90-second demo video','a-kind':'Video','a-status':'Not started','a-where':''},
 {'a-name':'Landing page','a-kind':'Web','a-status':'In progress','a-where':'haptyx-web (Vercel)'},
 {'a-name':'Shared-desk experience','a-kind':'Web','a-status':'Live','a-where':'haptyx-web.vercel.app/share'},
 {'a-name':'Press kit','a-kind':'Doc','a-status':'Not started','a-where':''},
 {'a-name':'Pricing page','a-kind':'Web','a-status':'Not started','a-where':''},
 {'a-name':'One-pager','a-kind':'Doc','a-status':'Not started','a-where':''},
])

# ── Widgets ─────────────────────────────────────────────────────────────────
Z = [0]
def w(kind, title, content, x, y, width, height, color=None):
    Z[0] += 1
    cur.execute("""INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,color,pinned,
      created_at,updated_at,needs_sync,sync_rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,1,0)""",
      (uid(), DESK, kind, title, content, x, y, width, height, Z[0], color, NOW, NOW))

def tiptap(blocks):
    out = []
    for kind, text in blocks:
        if kind == 'h':
            out.append({'type':'heading','attrs':{'level':3},'content':[{'type':'text','text':text}]})
        elif kind == 'li':
            out.append({'type':'bulletList','content':[{'type':'listItem','content':[
                {'type':'paragraph','content':[{'type':'text','text':t}]}]} for t in text]})
        else:
            out.append({'type':'paragraph','content':[{'type':'text','text':text}]})
    return json.dumps({'type':'doc','content':out})

C = [320, 760, 1200, 1640]
W, G = 420, 20
WIDE = W * 2 + G
R = [60, 400, 740, 1080]

# Row 1 — what this is, what's to do, when, and what's coming in.
w('markdown', 'The brief', """## Plexii — go to market

**A desktop workspace you arrange like a desk.** Browsers, docs, sheets, PDFs,
notes, tasks, maps and mail as widgets on one spatial canvas. Local-first:
the data is on your machine, in your SQLite file.

**The wedge** — share a desk as a link. It runs in the browser, read-and-edit,
and expires after 48 hours. The only way to keep it is to install the app.
That is the loop: the artefact does the selling.

**Who it's for** — people whose work is many open things at once: agents,
consultants, researchers, founders. The complaint to sell against is
tab-bankruptcy, not "I need another notes app".

**Six weeks.** Positioning → site → assets → pricing → instrumentation →
launch week.
""", C[0], R[0], W, 320)

w('task-list', 'Campaign', json.dumps({'scope': 'desk', 'filter': 'open'}), C[1], R[0], W, 320)
w('calendar', 'Schedule', json.dumps({'scope': 'desk'}), C[2], R[0], W, 320)
w('inbox', 'Inbox — campaign', json.dumps({
    'scan': 200,
    'rules': {'from': [], 'subject': ['plexii', 'launch', 'press', 'product hunt'], 'sinceDays': 30}
}), C[3], R[0], W, 320)

# Row 2 — the plan for reaching people, and the numbers that will judge it.
w('table', 'Channel plan', CHANNELS, C[0], R[1], WIDE, 320)
w('metrics', 'Launch funnel', json.dumps({
    'title': 'Launch funnel',
    'cells': [
        {'label': 'Visitors', 'value': 0, 'points': []},
        {'label': 'Downloads', 'value': 0, 'points': []},
        {'label': 'First desk', 'value': 0, 'points': []},
        {'label': 'Shares sent', 'value': 0, 'points': []},
    ],
    'source': 'No data yet — nothing has launched. Fills in once analytics is wired (see Measurement).'
}), C[2], R[1], W, 320)
w('stat-card', 'Week-4 targets', json.dumps({
    'series': [
        {'label': 'Downloads', 'caption': 'Target for week 4 after launch · actual is 0',
         'display': '0 / 500', 'points': []},
        {'label': 'Activated', 'caption': 'Created a desk with 3+ widgets · actual is 0',
         'display': '0 / 150', 'points': []},
    ], 'activeIndex': 0
}), C[3], R[1], W, 320)

# Row 3 — the working papers.
w('table', 'Assets', ASSETS, C[0], R[2], WIDE, 320)
w('page', 'Positioning', tiptap([
    ('h', 'Positioning'),
    ('p', 'For people who work with many things open at once, Plexii is a desktop workspace where everything lives side by side on a canvas you arrange yourself — unlike tabs and a notes app, which make you rebuild your context every morning.'),
    ('h', 'Three things to prove'),
    ('li', ['A desk survives a week of real work and still reads clearly.',
            'Sharing one is faster than explaining it.',
            'It is genuinely local — nothing leaves the machine unless you send it.']),
    ('h', 'What not to claim'),
    ('li', ['Not an AI product. AI is in it; it is not the pitch.',
            'Not a team tool yet — sharing is a link with a 48-hour clock.',
            'No numbers until there are numbers.']),
    ('h', 'Open questions'),
    ('li', ['Pro price, and what sits behind it.',
            'Windows: build exists, untested at launch scale.',
            'Which single segment leads the messaging.']),
]), C[2], R[2], W, 320)
w('contacts', 'Who to brief', json.dumps({
    'groups': ['Design partner', 'Press', 'Community'],
    'activeGroup': 'All',
    'contacts': []
}), C[3], R[2], W, 320)

# Row 4 — the week, and somewhere to think.
w('sticky', 'Launch week', """LAUNCH WEEK

Tue — Show HN, 8am PT
Tue — Product Hunt, 12:01am PT
Tue — founder thread
Wed — Reddit
Thu — waitlist email
Fri — retro + numbers""", C[0], R[3], W, 320, '#FEF3C7')
w('sticky', 'Decide first', """BLOCKING

1. Pro price
2. One lead segment
3. Real download URL
   (still a placeholder)
4. Signed + notarised build""", C[1], R[3], W, 320, '#FEE2E2')
w('note', 'Scratch', 'Ideas, objections, things people say when they first see it.', C[2], R[3], W, 320)

con.commit()
print('desk:', DESK)
print('tasks:', cur.execute('SELECT COUNT(*) FROM nodes WHERE parent_id=? OR parent_id IN (SELECT id FROM nodes WHERE parent_id=?)', (DESK, DESK)).fetchone()[0])
print('widgets:', cur.execute('SELECT COUNT(*) FROM widgets WHERE task_id=?', (DESK,)).fetchone()[0])
con.close()
