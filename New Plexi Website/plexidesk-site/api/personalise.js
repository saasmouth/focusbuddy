// Vercel Function (Node.js runtime, Web Handler): POST /api/personalise
// Body: {mode:"desk", role, task}  or  {mode:"ask", desk, question}
// Env:  ANTHROPIC_API_KEY  required
//       PLEXII_MODEL       optional, default claude-sonnet-5-5
//       ALLOWED_ORIGINS    optional, comma-separated (e.g. https://plexii.com,https://www.plexii.com)
// The browser never sees the key. The page re-validates everything the model returns (normalise() in index.html).
import { buildPrompt, buildAskPrompt, parseJSON } from "../lib/plexii-prompts.js";

const WINDOW_MS = 60_000, LIMIT = 8;
const hits = new Map(); // best-effort, per warm instance. Add a Vercel Firewall rate-limit rule for a hard limit.

const allowedOrigins = () => (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}
function corsHeaders(origin) {
  return origin && allowedOrigins().includes(origin) ? { "access-control-allow-origin": origin, vary: "origin" } : {};
}
export function originOk(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (allowedOrigins().includes(origin)) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}
export function rateLimited(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > LIMIT;
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: { ...corsHeaders(request.headers.get("origin")), "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
}

export async function POST(request) {
  const cors = corsHeaders(request.headers.get("origin"));
  if (!originOk(request)) return json({ error: "origin_not_allowed" }, 403);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "not_configured" }, 503, cors);
  const ip = (request.headers.get("x-forwarded-for") || "anon").split(",")[0].trim();
  if (rateLimited(ip)) return json({ error: "rate_limited" }, 429, { ...cors, "retry-after": "60" });

  const raw = await request.text();
  if (raw.length > 16_000) return json({ error: "too_large" }, 413, cors);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400, cors); }
  if (!body || typeof body !== "object") return json({ error: "bad_json" }, 400, cors);

  let prompt, maxTokens;
  if (body.mode === "ask") {
    if (typeof body.question !== "string" || !body.question.trim()) return json({ error: "missing_question" }, 400, cors);
    prompt = buildAskPrompt(body.desk, body.question);
    maxTokens = 600;
  } else {
    if (typeof body.role !== "string" || typeof body.task !== "string" || !body.role.trim() || !body.task.trim()) return json({ error: "missing_fields" }, 400, cors);
    prompt = buildPrompt(body.role, body.task, typeof body.hint === "string" ? body.hint : "");
    maxTokens = 2500;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 50_000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.PLEXII_MODEL || "claude-sonnet-5-5",
        max_tokens: maxTokens,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!r.ok) {
      console.error("anthropic", r.status, (await r.text()).slice(0, 300));
      return json({ error: "upstream_" + r.status }, 502, cors);
    }
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const out = parseJSON(text);
    if (!out || typeof out !== "object" || Array.isArray(out)) return json({ error: "invalid_json" }, 502, cors);
    return json(out, 200, cors);
  } catch (e) {
    return json({ error: e.name === "AbortError" ? "timeout" : "upstream_error" }, 504, cors);
  } finally {
    clearTimeout(timer);
  }
}
