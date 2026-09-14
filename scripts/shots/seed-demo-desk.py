import json, sqlite3, uuid, os, time

DB = os.path.expanduser('~/Library/Application Support/PlexiDesk3Preview/focusbuddy.db')
NOW = int(time.time() * 1000)
DAY = 86_400_000
uid = lambda: str(uuid.uuid4())
con = sqlite3.connect(DB); con.execute('PRAGMA foreign_keys = ON'); cur = con.cursor()

DESK = uid()
cur.execute("""INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
 sort_order,created_at,updated_at,extensions_minutes,is_plan,org_id,needs_sync,sync_rev)
 VALUES (?,NULL,'task',?,?, 'open',3,3,3,?,?,?,0,0,'personal',1,0)""",
 (DESK, '12 Ridge St, Dover Heights — campaign',
  'A working desk: the listing, its numbers, its people and its tasks in one place. Illustrative data.',
  NOW, NOW, NOW))

# Real child tasks — this is what makes the Tasks widget a genuine lens rather
# than a picture of one. It reads nodes, and these are nodes.
TASKS = [
    ('Call Johnsons — buyer follow-up', 0, 'done'),
    ('Send contract to solicitor', 0, 'open'),
    ('Prepare vendor report', 1, 'open'),
    ('Schedule photography', 1, 'open'),
    ('Update listing on realestate.com.au', 3, 'open'),
    ('Review offers', 3, 'open'),
    ('Confirm Saturday inspection times', 2, 'open'),
    ('Draft price-guidance note for vendor', 5, 'open'),
]
for i, (title, due_in, status) in enumerate(TASKS):
    cur.execute("""INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
     sort_order,created_at,updated_at,extensions_minutes,due_date,org_id,needs_sync,sync_rev)
     VALUES (?,?,'task',?,'',?,3,3,3,?,?,?,0,?,'personal',1,0)""",
     (uid(), DESK, title, status, i, NOW, NOW, NOW + due_in * DAY))

def table(title, columns, rows):
    tid = uid()
    cur.execute("""INSERT INTO fb_tables (id,task_id,title,schema_json,created_at,updated_at,org_id,needs_sync,sync_rev)
                   VALUES (?,?,?,?,?,?,'personal',1,0)""",
                (tid, DESK, title, json.dumps({'columns': columns}), NOW, NOW))
    for i, cells in enumerate(rows):
        cur.execute("""INSERT INTO fb_rows (id,table_id,cells_json,sort_order,created_at,updated_at,needs_sync,sync_rev)
                       VALUES (?,?,?,?,?,?,1,0)""", (uid(), tid, json.dumps(cells), i, NOW, NOW))
    return tid

COMPS = table('Comparable sales', [
    {'id':'c-addr','type':'text-short','label':'Address','config':{}},
    {'id':'c-beds','type':'number','label':'Beds','config':{}},
    {'id':'c-land','type':'text-short','label':'Land','config':{}},
    {'id':'c-price','type':'number','label':'Sold ($m)','config':{}},
    {'id':'c-when','type':'text-short','label':'Sold','config':{}},
], [
 {'c-addr':'8 Ridge St','c-beds':4,'c-land':'612 m²','c-price':4.95,'c-when':'Aug 2026'},
 {'c-addr':'15 Military Rd','c-beds':4,'c-land':'589 m²','c-price':5.20,'c-when':'Jul 2026'},
 {'c-addr':'21 Portland St','c-beds':5,'c-land':'702 m²','c-price':5.75,'c-when':'Jun 2026'},
 {'c-addr':'3 Wallaroy Cres','c-beds':4,'c-land':'580 m²','c-price':4.80,'c-when':'May 2026'},
 {'c-addr':'27 Dover Rd','c-beds':5,'c-land':'664 m²','c-price':5.40,'c-when':'Apr 2026'},
])

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

# ── A four-column grid on a 20px rhythm: x = 60, 500, 940, 1380 ──────────────
C = [320, 760, 1200, 1640]
W = 420
G = 20

# Row 1 — the brief, the work, the numbers, the people.
w('markdown', 'Key points', """## 12 Ridge St, Dover Heights

**Listing · Active** · Guide $5.0m – $5.5m

- 4 bed · 3 bath · 2 car · 612 m²
- Auction **Saturday 3 Oct, 10:00** on site
- Vendor: K. Farrow · Week 3 of 4

Northern aspect and the lock-up garage are doing the selling.
""", C[0], 60, W, 320)

w('task-list', 'Tasks', json.dumps({'scope': 'desk', 'filter': 'open'}), C[1], 60, W, 320)

w('metrics', 'Campaign', json.dumps({
    'title': 'Listing campaign',
    'cells': [
        {'label': 'Views', 'value': 24821, 'display': '24,821', 'points': [18100, 19400, 21000, 22150, 23600, 24821]},
        {'label': 'Enquiries', 'value': 142, 'points': [96, 104, 112, 121, 133, 142]},
        {'label': 'Inspections', 'value': 36, 'points': [22, 25, 28, 30, 33, 36]},
        {'label': 'Saves', 'value': 89, 'points': [58, 63, 69, 74, 82, 89]},
    ],
    'bars': [310, 420, 380, 560, 640, 590, 720, 810, 760, 880, 930, 1010],
    'barsLabel': 'Views by day, last 12 days',
    'source': 'Illustrative figures — a demonstration desk'
}), C[2], 60, W, 320)

w('contacts', 'Contacts', json.dumps({
    'groups': ['Buyer', 'Vendor', 'Solicitor'],
    'activeGroup': 'All',
    'contacts': [
        {'name': 'Sarah Lin', 'role': 'Buyer', 'tag': 'Hot', 'tone': 'hot', 'phone': '0412 345 678'},
        {'name': 'David Chen', 'role': 'Buyer', 'tag': 'Warm', 'tone': 'warm', 'phone': '0418 765 432'},
        {'name': 'Emma Wilson', 'role': 'Vendor', 'tag': 'Active', 'tone': 'cool', 'phone': '0402 111 222'},
        {'name': 'James Carter', 'role': 'Solicitor', 'tag': 'Contracts', 'tone': 'neutral', 'phone': '02 9327 4400'},
        {'name': 'Priya Nair', 'role': 'Buyer', 'tag': 'Cooling', 'tone': 'neutral', 'phone': '0433 900 121'},
    ]
}), C[3], 60, W, 320)

# Row 2 — the evidence.
w('table', 'Comparable sales', COMPS, C[0], 400, W * 2 + G, 320)
w('stat-card', 'Median price', json.dumps({
    'title': 'Dover Heights',
    'series': [
        {'label': 'Sales', 'caption': 'Median house price · 12 months', 'display': '$5.2M',
         'points': [4.6, 4.7, 4.65, 4.8, 4.9, 4.88, 5.0, 5.05, 5.1, 5.0, 5.15, 5.2]},
        {'label': 'Rentals', 'caption': 'Median weekly rent · 12 months', 'display': '$1,240',
         'points': [1080, 1100, 1120, 1115, 1160, 1180, 1175, 1200, 1210, 1225, 1230, 1240]},
    ], 'activeIndex': 0
}), C[2], 400, W, 320)
w('chart', 'Comparables by price', json.dumps({
    'tableId': COMPS, 'type': 'bar', 'xColumnId': 'c-addr',
    'series': [{'columnId': 'c-price', 'agg': 'sum'}]
}), C[3], 400, W, 320)

# Row 3 — the working papers.
w('page', 'Vendor report — week 3', tiptap([
    ('h', 'Vendor report — week 3 of 4'),
    ('p', 'Auction Saturday 3 October, 10:00am on site.'),
    ('li', ['34 groups through Saturday, 11 through the Wednesday twilight.',
            'Six contracts issued; two buyers have ordered strata reports.',
            'Two registered bidders expected, a third deciding after finance Thursday.']),
    ('p', 'Recommendation: hold the guide. Three genuine bidders is the number that makes a Dover Heights auction competitive.'),
    ('p', 'Prepared for K. Farrow · illustrative sample report.'),
]), C[0], 740, W, 320)

w('gallery', 'Photography', json.dumps({'fileIds': []}), C[1], 740, W, 320)

w('sticky', 'Saturday', 'SAT 3 OCT\n\n10:00  on-site auction\n\nBuyer feedback into the vendor report the same afternoon — never Monday.',
  C[2], 740, 200, 320, '#fde68a')
w('calculator', 'Commission @ 2.2%', '114400', C[2] + 220, 740, 200, 320)

w('webview', 'Domain listing', 'https://www.domain.com.au', C[3], 740, W, 320)

# Row 4 — the wider view.
w('note', 'Buyer feedback', 'Price expectation clustering at $5.1m–$5.4m. Two groups noted the kitchen; neither treated it as a barrier.',
  C[0], 1080, W, 260)
w('field', 'Days on market', json.dumps({'def': {'id': 'f1', 'type': 'number', 'label': 'Days on market', 'config': {}}, 'value': 21}),
  C[1], 1080, 200, 260)
w('timer', 'Open home', '1800', C[1] + 220, 1080, 200, 260)
w('scratchpad', 'Scratch', 'strata report $385\ncouncil rates $2,140 pa\nwater $1,010 pa', C[2], 1080, W, 260)
w('card', 'Next step', json.dumps({'title': 'Thursday, 6pm',
    'body': 'Finance decision from the third bidder. If it lands we go to auction with three genuine bidders.',
    'accent': '#f2b705'}), C[3], 1080, W, 260)

con.commit()
print(f'desk_id={DESK}')
print(f'widgets={Z[0]}  tasks={len(TASKS)}  table_rows=5')
con.close()
