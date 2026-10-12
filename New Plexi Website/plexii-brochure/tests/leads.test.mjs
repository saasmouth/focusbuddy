import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../api/leads.js";
const real = globalThis.fetch; let calls;
const req = (b, h = {}) => new Request("https://site.test/api/leads", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.1.1." + Math.floor(Math.random() * 250), ...h }, body: typeof b === "string" ? b : JSON.stringify(b) });
const ok = { kind: "demo", name: "Sam", email: "sam@example.com", company: "Acme", teamSize: "2 to 10" };
beforeEach(() => { calls = []; for (const k of ["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "AIRTABLE_TABLE", "LEADS_WEBHOOK_URL"]) delete process.env[k]; globalThis.fetch = async (u, i) => { calls.push({ u, i }); return new Response("{}", { status: 200 }); }; });
test("not configured -> 503 so the page falls back to email", async () => { assert.equal((await POST(req(ok))).status, 503); globalThis.fetch = real; });
test("airtable", async () => {
  Object.assign(process.env, { AIRTABLE_TOKEN: "pat", AIRTABLE_BASE_ID: "appX" });
  assert.equal((await POST(req(ok))).status, 200);
  assert.equal(calls[0].u, "https://api.airtable.com/v0/appX/Leads");
  assert.equal(calls[0].i.headers.authorization, "Bearer pat");
  const f = JSON.parse(calls[0].i.body).records[0].fields;
  assert.equal(f.Kind, "demo"); assert.equal(f.Email, "sam@example.com"); assert.equal(f["Team size"], "2 to 10");
});
test("webhook", async () => {
  process.env.LEADS_WEBHOOK_URL = "https://hook.example/x";
  assert.equal((await POST(req({ ...ok, kind: "live" }))).status, 200);
  assert.equal(JSON.parse(calls[0].i.body).kind, "live");
});
test("validation, size, origin, honeypot", async () => {
  process.env.LEADS_WEBHOOK_URL = "https://hook.example/x";
  assert.equal((await POST(req({ ...ok, email: "nope" }))).status, 400);
  assert.equal((await POST(req({ ...ok, kind: "spam" }))).status, 400);
  assert.equal((await POST(req("x".repeat(9000)))).status, 413);
  assert.equal((await POST(req(ok, { origin: "https://evil.example" }))).status, 403);
  calls = []; assert.equal((await POST(req({ ...ok, website: "bot" }))).status, 200); assert.equal(calls.length, 0);
});
test("rate limit", async () => {
  process.env.LEADS_WEBHOOK_URL = "https://hook.example/x";
  const codes = []; for (let i = 0; i < 7; i++) codes.push((await POST(req(ok, { "x-forwarded-for": "9.9.9.9" }))).status);
  assert.deepEqual(codes.slice(5), [429, 429]);
});
