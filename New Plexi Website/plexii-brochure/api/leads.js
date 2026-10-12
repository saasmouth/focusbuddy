// Vercel Function: POST /api/leads   Body: {kind: "live" | "demo", name, email, company?, role?, teamSize?, message?, page?}
// Stores live-session registrations and demo requests. Configure ONE destination:
//   Airtable: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE (default "Leads")
//             Fields expected: Kind, Name, Email, Company, Role, Team size, Message, Page (all single line / long text)
//   Webhook:  LEADS_WEBHOOK_URL (Make, Zapier, Slack incoming webhook, n8n...). Receives the JSON as-is.
// With neither set it answers 503 and the page falls back to a prefilled email, so nothing is lost.
const LIMIT = 5, WINDOW_MS = 60_000, hits = new Map();
const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function sameOrigin(request) {
  const o = request.headers.get("origin");
  if (!o) return true;
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  try { return allowed.includes(o) || new URL(o).host === new URL(request.url).host; } catch { return false; }
}

export async function POST(request) {
  if (!sameOrigin(request)) return json({ error: "origin_not_allowed" }, 403);
  const ip = (request.headers.get("x-forwarded-for") || "anon").split(",")[0].trim(), now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS); list.push(now); hits.set(ip, list);
  if (list.length > LIMIT) return json({ error: "rate_limited" }, 429);
  const raw = await request.text();
  if (raw.length > 8000) return json({ error: "too_large" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
  const lead = {
    kind: b.kind === "live" ? "live" : b.kind === "demo" ? "demo" : "",
    name: clean(b.name, 80), email: clean(b.email, 120), company: clean(b.company, 120), role: clean(b.role, 80),
    teamSize: clean(b.teamSize, 40), message: clean(b.message, 600), page: clean(b.page, 300), at: new Date().toISOString()
  };
  if (!lead.kind || !lead.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) return json({ error: "invalid" }, 400);
  if (b.website) return json({ ok: true }); // honeypot: bots fill hidden fields

  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE = "Leads", LEADS_WEBHOOK_URL } = process.env;
  try {
    if (AIRTABLE_TOKEN && AIRTABLE_BASE_ID) {
      const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`, {
        method: "POST", headers: { authorization: `Bearer ${AIRTABLE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ records: [{ fields: { Kind: lead.kind, Name: lead.name, Email: lead.email, Company: lead.company, Role: lead.role, "Team size": lead.teamSize, Message: lead.message, Page: lead.page } }], typecast: true })
      });
      if (!r.ok) { console.error("airtable", r.status, (await r.text()).slice(0, 300)); return json({ error: "store_failed" }, 502); }
      return json({ ok: true });
    }
    if (LEADS_WEBHOOK_URL) {
      const r = await fetch(LEADS_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(lead) });
      if (!r.ok) return json({ error: "store_failed" }, 502);
      return json({ ok: true });
    }
  } catch (e) { console.error("leads", e); return json({ error: "store_failed" }, 502); }
  return json({ error: "not_configured" }, 503);
}
