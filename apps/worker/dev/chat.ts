/**
 * Local WhatsApp chat simulator (dev only). Runs the real worker code
 * (processInbound, onboarding, ledger) against an in-memory PGlite database
 * with a fake WhatsApp sender, so the bot can be tried without Meta or Postgres.
 * Everything is lost on restart.
 */
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { businesses, hashPii, onboardingSessions, piiKeysFromBase64, toE164, users, waInbound, withBusiness, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { trialBalance } from "@bukuwa/ledger";
import type { OutboundMessage, WaSender } from "@bukuwa/wa";
import { aiConfigFromEnv, anthropicModel } from "@bukuwa/ai";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { offlineModel } from "./offline-model.js";

const useClaude = Boolean(process.env.ANTHROPIC_API_KEY);
console.log(useClaude ? "chat simulator: using Claude" : "chat simulator: no ANTHROPIC_API_KEY, using the offline keyword stand-in (dev only)");

const PORT = Number(process.env.PORT ?? 8788);
const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));

const outbox: Array<{ to: string; msg: OutboundMessage }> = [];
const sender: WaSender = {
  async send(to, msg) {
    outbox.push({ to, msg });
    return `wamid.dev.out.${outbox.length}`;
  },
};

let db: Db;
let deps: InboundDeps;
let seq = 0;

async function reset() {
  ({ db } = await createTestDb());
  outbox.length = 0;
  deps = {
    db,
    sender,
    keys,
    ai: { model: useClaude ? anthropicModel() : offlineModel, config: aiConfigFromEnv() },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "dev", trialDays: 14, timezone: "Asia/Jakarta" },
    log: (e) => console.log(JSON.stringify(e)),
  };
}
await reset();

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

async function stateFor(from: string) {
  const hash = hashPii(keys, toE164(from));
  const [session] = await db.select().from(onboardingSessions).where(eq(onboardingSessions.phoneHash, hash));
  const [owner] = await db.select({ businessId: users.businessId }).from(users).where(eq(users.phoneHash, hash));
  if (!owner) return { onboarding: session ?? null, business: null };
  const business = await withBusiness(db, owner.businessId, async (tx) => {
    const [b] = await tx.select().from(businesses);
    const tb = await trialBalance(tx, owner.businessId);
    return {
      name: b!.name,
      type: b!.type,
      plan: b!.plan,
      trialEndsAt: b!.trialEndsAt,
      trialBalance: { balanced: tb.balanced, rows: tb.rows.map((r) => ({ code: r.code, name: r.name, balance: r.balance })) },
    };
  });
  return { onboarding: null, business };
}

const app = new Hono();
app.get("/", (c) => c.html(PAGE));
app.post("/send", async (c) => {
  const { from, text, replyId, title } = await c.req.json<{ from: string; text?: string; replyId?: string; title?: string }>();
  const id = `wamid.dev.in.${++seq}`;
  const payload = replyId
    ? { id, from, type: "interactive", interactive: { type: "button_reply", button_reply: { id: replyId, title: title ?? replyId } } }
    : { id, from, type: "text", text: { body: text ?? "" } };
  const before = outbox.length;
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: from, type: payload.type, payload });
  await processInbound(deps, id);
  const to = toE164(from);
  return c.json({ replies: outbox.slice(before).filter((o) => o.to === to).map((o) => o.msg), state: json(await stateFor(from)) });
});
app.get("/state", async (c) => c.json(json(await stateFor(c.req.query("from") ?? ""))));
app.post("/reset", async (c) => {
  await reset();
  return c.json({ ok: true });
});

serve({ fetch: app.fetch, port: PORT }, () => console.log(`chat simulator on http://localhost:${PORT}`));

const PAGE = /* html */ `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BukuWA chat simulator</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.4 system-ui, sans-serif; background: #f0f2f5; color: #111b21; display: flex; height: 100vh; }
  .chat { flex: 1 1 60%; display: flex; flex-direction: column; min-width: 320px; max-width: 640px; border-right: 1px solid #d1d7db; }
  header { background: #075e54; color: #fff; padding: 10px 14px; display: flex; gap: 8px; align-items: center; }
  header strong { flex: 1; }
  header input { width: 150px; padding: 4px 6px; border: 0; border-radius: 4px; }
  header button { background: #128c7e; color: #fff; border: 0; padding: 5px 9px; border-radius: 4px; cursor: pointer; }
  #log { flex: 1; overflow-y: auto; padding: 14px; background: #efeae2; display: flex; flex-direction: column; gap: 6px; }
  .msg { max-width: 82%; padding: 7px 10px; border-radius: 8px; white-space: pre-wrap; box-shadow: 0 1px 1px rgba(0,0,0,.08); }
  .in { align-self: flex-end; background: #d9fdd3; }
  .out { align-self: flex-start; background: #fff; }
  .opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .opts button { background: #fff; border: 1px solid #25d366; color: #008069; border-radius: 16px; padding: 4px 10px; cursor: pointer; font: inherit; }
  .opts button:disabled { opacity: .45; cursor: default; }
  .hint { font-size: 12px; color: #667781; margin-top: 4px; }
  form { display: flex; gap: 8px; padding: 10px; background: #f0f2f5; }
  form input { flex: 1; padding: 10px 12px; border: 0; border-radius: 20px; font: inherit; }
  form button { background: #00a884; color: #fff; border: 0; border-radius: 20px; padding: 0 16px; cursor: pointer; font: inherit; }
  aside { flex: 1 1 40%; padding: 14px; overflow-y: auto; font-size: 13px; }
  aside h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #667781; margin: 0 0 8px; }
  pre { background: #fff; padding: 10px; border-radius: 6px; overflow-x: auto; margin: 0; }
</style></head>
<body>
<section class="chat">
  <header><strong>BukuWA (dev${useClaude ? "" : ", offline model"})</strong>
    <label>Nomor <input id="from" value="6281234567890"></label>
    <button id="reset" title="Wipe the in-memory database">Reset DB</button></header>
  <div id="log"></div>
  <form id="f"><input id="t" placeholder="Ketik pesan" autocomplete="off" autofocus><button>Kirim</button></form>
</section>
<aside><h2>Database state for this number</h2><pre id="state">(belum ada)</pre></aside>
<script>
const log = document.getElementById('log'), from = document.getElementById('from'), stateEl = document.getElementById('state');
function bubble(cls, text) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
function render(m) {
  const d = bubble('out', m.body);
  const opts = m.kind === 'buttons' ? m.buttons : m.kind === 'list' ? m.rows : null;
  if (!opts) return;
  if (m.kind === 'list') { const h = document.createElement('div'); h.className = 'hint'; h.textContent = '☰ ' + m.buttonText; d.appendChild(h); }
  const box = document.createElement('div'); box.className = 'opts';
  for (const o of opts) { const b = document.createElement('button'); b.textContent = o.title;
    b.onclick = () => { box.querySelectorAll('button').forEach(x => x.disabled = true); send({ replyId: o.id, title: o.title }); }; box.appendChild(b); }
  d.appendChild(box);
}
async function send(body) {
  bubble('in', body.title ?? body.text);
  const r = await fetch('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: from.value, ...body }) });
  const j = await r.json(); j.replies.forEach(render); stateEl.textContent = JSON.stringify(j.state, null, 2);
}
document.getElementById('f').onsubmit = (e) => { e.preventDefault(); const t = document.getElementById('t'); if (!t.value.trim()) return; send({ text: t.value }); t.value = ''; };
document.getElementById('reset').onclick = async () => { await fetch('/reset', { method: 'POST' }); log.innerHTML = ''; stateEl.textContent = '(belum ada)'; };
from.onchange = async () => { log.innerHTML = ''; stateEl.textContent = JSON.stringify(await (await fetch('/state?from=' + encodeURIComponent(from.value))).json(), null, 2); };
</script></body></html>`;
