"""Seed a 'Test drive' desk into Preview 3 covering everything built today.

Every widget here is wired to something real: the metrics and stat card are
bound to an actual table (so they recompute when you edit a row), the task has
real planning fields and subtasks, and the sticky carries a real @-mention token
pointing at a second desk. Nothing is a picture of a feature.
"""
import json, sqlite3, uuid, os, time, datetime

DB = os.path.expanduser('~/Library/Application Support/PlexiDesk3Preview/focusbuddy.db')
NOW = int(time.time() * 1000)
DAY = 86_400_000
uid = lambda: str(uuid.uuid4())

def day(offset):
    d = datetime.date.today() + datetime.timedelta(days=offset)
    return int(datetime.datetime(d.year, d.month, d.day).timestamp() * 1000)

con = sqlite3.connect(DB); con.execute('PRAGMA foreign_keys = ON'); cur = con.cursor()

DESK = uid()
cur.execute("""INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
 sort_order,created_at,updated_at,extensions_minutes,is_plan,org_id,needs_sync,sync_rev)
 VALUES (?,NULL,'task',?,?, 'open',2,3,2,?,?,?,0,0,'personal',1,0)""",
 (DESK, 'Test drive — everything new',
  'One desk exercising today\'s work: bound metrics, task planning, calendar criteria, inbox rules, a real map, contacts and @-mentions.',
  NOW, NOW, NOW))

# A second desk, so the @-mention in the sticky points somewhere real.
OTHER = uid()
cur.execute("""INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
 sort_order,created_at,updated_at,extensions_minutes,is_plan,org_id,needs_sync,sync_rev)
 VALUES (?,NULL,'task',?,'', 'open',3,3,3,?,?,?,0,0,'personal',1,0)""",
 (OTHER, 'Ridgeway Campaign', NOW, NOW, NOW))

# ── Tasks with the full planning surface ────────────────────────────────────
def task(parent, title, start_off, due_off, status, order, assignee=None, dep=None, lag=None, notes=''):
    nid = uid()
    cur.execute("""INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
     sort_order,created_at,updated_at,extensions_minutes,due_date,planned_start_at,assignee,
     depends_on,lag_days,org_id,needs_sync,sync_rev)
     VALUES (?,?,'task',?,?,?,3,3,3,?,?,?,0,?,?,?,?,?,'personal',1,0)""",
     (nid, parent, title, notes, status, order, NOW, NOW,
      day(due_off), day(start_off), assignee, dep, lag))
    return nid

shoot = task(DESK, 'Book the photographer', 0, 2, 'in_progress', 0, 'Michael',
             notes='Two-hour slot, drone if the weather holds.')
task(shoot, 'Confirm the time', 0, 1, 'done', 0, 'Michael')
task(shoot, 'Send the brief', 1, 2, 'open', 1, 'Michael')
# A real dependency with negative lag: copy starts two days BEFORE the shoot ends.
copy = task(DESK, 'Draft the listing copy', 1, 6, 'open', 1, 'Sarah', shoot, -2,
            notes='Lead with the northern aspect.')
task(copy, 'First pass', 1, 3, 'open', 0, 'Sarah')
task(DESK, 'Review with the vendor', 6, 9, 'open', 2, 'Michael', copy, 1)
task(DESK, 'Internal draft — should be filtered out', 0, 3, 'open', 3, 'Michael')

# ── A table for the metrics and stat card to bind to ────────────────────────
TID = uid()
cur.execute("""INSERT INTO fb_tables (id,task_id,title,schema_json,created_at,updated_at,org_id,needs_sync,sync_rev)
               VALUES (?,?,?,?,?,?,'personal',1,0)""",
  (TID, DESK, 'Enquiries', json.dumps({'columns': [
    {'id': 'c-name', 'type': 'text-short', 'label': 'Name', 'config': {}},
    {'id': 'c-source', 'type': 'text-short', 'label': 'Source', 'config': {}},
    {'id': 'c-value', 'type': 'number', 'label': 'Budget', 'config': {}},
    {'id': 'c-hot', 'type': 'checkbox', 'label': 'Hot', 'config': {}},
    {'id': 'c-when', 'type': 'date', 'label': 'Enquired', 'config': {}},
  ]}), NOW, NOW))

ROWS = [
    ('Sarah Lin', 'Portal', 1850000, 1, -21),
    ('David Chen', 'Portal', 1620000, 1, -14),
    ('Emma Wilson', 'Walk-in', 1400000, 0, -12),
    ('James Carter', 'Referral', 2100000, 1, -7),
    ('Priya Nair', 'Portal', 1350000, 0, -5),
    ('Tom Adams', 'Walk-in', 1750000, 0, -2),
]
for i, (name, src, val, hot, off) in enumerate(ROWS):
    cur.execute("""INSERT INTO fb_rows (id,table_id,cells_json,sort_order,created_at,updated_at,needs_sync,sync_rev)
                   VALUES (?,?,?,?,?,?,1,0)""",
      (uid(), TID, json.dumps({
        'c-name': name, 'c-source': src, 'c-value': val,
        'c-hot': bool(hot),
        'c-when': datetime.date.fromtimestamp(day(off)/1000).isoformat()
      }), i, NOW, NOW))

# ── Time blocks, so the calendar has bookings as well as due dates ──────────
def block(title, day_off, hour, mins, task_id=None):
    d = datetime.date.today() + datetime.timedelta(days=day_off)
    start = int(datetime.datetime(d.year, d.month, d.day, hour).timestamp() * 1000)
    cur.execute("""INSERT INTO time_blocks (id,task_id,title,start_ms,duration_min,status,
                   origin,locked,push_policy,created_at,updated_at,needs_sync,sync_rev)
                   VALUES (?,?,?,?,?, 'planned','manual',0,'local',?,?,1,0)""",
      (uid(), task_id, title, start, mins, NOW, NOW))

block('Photographer on site', 2, 10, 120, shoot)
block('Vendor call', 6, 15, 30, None)

# ── Contacts, real records linked to this desk ──────────────────────────────
def contact(name, email, role, company):
    cid = uid()
    cur.execute("""INSERT INTO contacts (id,name,email,phone,company,role,notes,kind,account_id,tags,created_at,updated_at)
                   VALUES (?,?,?,NULL,?,?,NULL,'guest',NULL,NULL,?,?)""",
      (cid, name, email, company, role, NOW, NOW))
    cur.execute("INSERT INTO contact_links (contact_id,node_id,created_at) VALUES (?,?,?)", (cid, DESK, NOW))
    return cid

contact('Sarah Whitfield', 'sarah@example.com', 'Conveyancer', 'Whitfield Legal')
contact('Dan Okafor', 'dan@example.com', 'Photographer', 'Okafor Studio')

Z = [0]
def w(kind, title, content, x, y, width, height, color=None):
    Z[0] += 1
    cur.execute("""INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,color,pinned,
      created_at,updated_at,needs_sync,sync_rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,1,0)""",
      (uid(), DESK, kind, title, content, x, y, width, height, Z[0], color, NOW, NOW))

C = [320, 760, 1200, 1640]
W, G = 420, 20
R = [60, 460, 860]

# Row 1 — tasks (planning), calendar (criteria), metrics (bound), stat card (bound)
w('task-list', 'Tasks', json.dumps({'scope': 'desk', 'filter': 'open'}), C[0], R[0], W, 380)

w('calendar', 'Schedule', json.dumps({
    'filter': {
        'scope': 'desk',
        'sources': {'task': True, 'block': True, 'external': True},
        'exclude': ['internal'],
        'taskStatus': 'all'
    }
}), C[1], R[0], W, 380)

w('metrics', 'Enquiries', json.dumps({
    'title': 'Enquiries',
    'cells': [
        {'label': 'Enquiries', 'value': 0,
         'binding': {'source': {'kind': 'table', 'tableId': TID}, 'agg': 'count'}},
        {'label': 'Hot', 'value': 0,
         'binding': {'source': {'kind': 'table', 'tableId': TID}, 'agg': 'countTrue', 'columnId': 'c-hot'}},
        {'label': 'Avg budget', 'value': 0,
         'binding': {'source': {'kind': 'table', 'tableId': TID}, 'agg': 'avg',
                     'columnId': 'c-value', 'format': 'currency', 'compact': True}},
        {'label': 'From portal', 'value': 0,
         'binding': {'source': {'kind': 'table', 'tableId': TID}, 'agg': 'count',
                     'filters': [{'columnId': 'c-source', 'op': 'eq', 'value': 'Portal'}]}},
    ]
}), C[2], R[0], W, 380)

w('stat-card', 'Pipeline', json.dumps({
    'title': 'Budget in play',
    'series': [],
    'binding': {
        'source': {'kind': 'table', 'tableId': TID},
        'agg': 'sum', 'columnId': 'c-value',
        'groupBy': {'columnId': 'c-when', 'bucket': 'week'},
        'format': 'currency', 'compact': True
    }
}), C[3], R[0], W, 380)

# Row 2 — the table itself, inbox rules, a real map, contacts
w('table', 'Enquiries', TID, C[0], R[1], W * 2 + G, 380)

w('inbox', 'Inbox — this desk', json.dumps({
    'scan': 200,
    'rules': {'from': [], 'subject': ['ridgeway', 'photographer', 'listing'], 'sinceDays': 30}
}), C[2], R[1], W, 380)

w('location-map', 'Location', json.dumps({'zoom': 16}), C[3], R[1], W, 380)

# Row 3 — contacts, and a sticky carrying a real @-mention
w('contacts', 'People', json.dumps({'activeGroup': 'All'}), C[0], R[2], W, 320)

w('sticky', '', f"""Try these:

**@ mention** — the link below is real, click it:
see @[Ridgeway Campaign](plexii://desk/{OTHER})

Type **@** anywhere in this note to add another.""", C[1], R[2], W, 320, '#FEF3C7')

w('note', 'What to test', """1. Tasks — click a task TITLE for dates, duration,
   dependency, lag, subtasks, attachments.
2. Calendar — the tune icon sets criteria. Note the
   "internal" task is excluded. Double-click a day.
3. Metrics / Stat card — edit a Budget in the table
   and watch the numbers move. Hover a cell for the
   tune icon to rebind it.
4. Inbox — needs a mail account; otherwise it says so.
5. Map — search "Double Bay, NSW".
6. Contacts — add someone, then invite or share.""", C[2], R[2], W * 2 + G, 320)

con.commit()
print('desk:', DESK)
print('widgets:', cur.execute('SELECT COUNT(*) FROM widgets WHERE task_id=?', (DESK,)).fetchone()[0])
print('tasks:', cur.execute('SELECT COUNT(*) FROM nodes WHERE parent_id=? OR parent_id IN (SELECT id FROM nodes WHERE parent_id=?)', (DESK, DESK)).fetchone()[0])
con.close()
