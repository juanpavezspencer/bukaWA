import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { captures, createAdminLoginToken, createLoginToken, messages, users, withAppRole, withBusiness, type Db } from "@bukuwa/db";
import { createTestBusiness, createTestDb } from "@bukuwa/db/testing";
import { postJournal, type DraftLine } from "@bukuwa/ledger";
import { linkSigner } from "@bukuwa/reports";
import { createApp } from "../src/app.js";
import { maskForStaff } from "../src/admin.js";

const ORIGIN = "https://app.bukuwa.test";
const NOW = new Date("2026-11-13T05:00:00Z");
const key = randomBytes(32);
let db: Db;
let bizA: string;
let bizB: string;
let userA: string;
let userB: string;
let saleA: string;
let saleB: string;
let failedCapture: string;

const app = () =>
  createApp({
    db,
    queue: { enqueueInbound: async () => {} },
    config: { WA_APP_SECRET: "test-app-secret-0123456789", WA_VERIFY_TOKEN: "verify-me-please", WA_WEBHOOK_MAX_BYTES: 1000 },
    files: { key },
    dashboard: {
      webOrigin: ORIGIN,
      sessionTtlDays: 7,
      cookieSecure: true,
      defaultRegime: "umkm_final_individual",
      maxBuckets: 120,
      signer: linkSigner({ key, baseUrl: "https://api.bukuwa.test", reportTtlMinutes: 15, evidenceTtlHours: 24 }),
    },
    admin: { webOrigin: ORIGIN, sessionHours: 12, cookieSecure: true, reviewConfidenceBelow: 0.7 },
    now: () => NOW,
    log: () => {},
  });

async function addUser(businessId: string, tag: string) {
  return withBusiness(db, businessId, async (tx) => {
    const [u] = await tx.insert(users).values({ businessId, phoneHash: `phone-${tag}`, phoneEnc: Buffer.from("x") }).returning();
    return u!.id;
  });
}

async function post(businessId: string, date: string, description: string, lines: DraftLine[]) {
  return withBusiness(db, businessId, async (tx) => (await postJournal(tx, { businessId, date, description, source: "text", lines })).id);
}

async function login(businessId: string, userId: string): Promise<string> {
  const token = await withBusiness(db, businessId, (tx) => createLoginToken(tx, { businessId, userId, now: NOW, ttlMs: 15 * 60_000 }));
  const res = await app().request("/api/auth/exchange", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token }) });
  expect(res.status).toBe(200);
  return /bw_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
}

const req = (cookie: string, path: string, init: RequestInit = {}) =>
  app().request(path, { ...init, headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...(init.headers ?? {}) } });

beforeAll(async () => {
  ({ db } = await createTestDb());
  bizA = await createTestBusiness(db, "Catering Rina");
  bizB = await createTestBusiness(db, "Toko Dimas");
  userA = await addUser(bizA, "a");
  userB = await addUser(bizB, "b");
  saleA = await post(bizA, "2026-11-03", "Jual nasi box", [{ accountCode: "1100", debit: 500_000n }, { accountCode: "4100", credit: 500_000n }]);
  await post(bizA, "2026-11-04", "Beli ayam", [{ accountCode: "5100", debit: 200_000n }, { accountCode: "1110", credit: 200_000n }]);
  await post(bizA, "2026-11-10", "Jual snack", [{ accountCode: "1120", debit: 300_000n }, { accountCode: "4100", credit: 300_000n }]);
  saleB = await post(bizB, "2026-11-05", "Jual pulsa", [{ accountCode: "1100", debit: 90_000n }, { accountCode: "4100", credit: 90_000n }]);
  await withBusiness(db, bizB, async (tx) => {
    await tx.insert(messages).values({ businessId: bizB, direction: "inbound", type: "text", body: "NIK 3171012345678901, hp 0812-3456-7890" });
    const [cap] = await tx.insert(captures).values({ businessId: bizB, source: "text", rawText: "npwp 01.234.567.8-901.000 bayar", status: "failed" }).returning();
    failedCapture = cap!.id;
  });
});

describe("dashboard login", () => {
  it("swaps a magic link for an HttpOnly 7-day session cookie, once", async () => {
    const token = await withBusiness(db, bizA, (tx) => createLoginToken(tx, { businessId: bizA, userId: userA, now: NOW, ttlMs: 15 * 60_000 }));
    const init = { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token }) };
    const res = await app().request("/api/auth/exchange", init);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Expires=Fri, 20 Nov 2026 05:00:00 GMT/);
    const again = await app().request("/api/auth/exchange", init);
    expect(again.status).toBe(401);
    expect((await again.json()).message).toMatch(/kedaluwarsa/);
  });

  it("needs a session", async () => {
    const res = await app().request("/api/me");
    expect(res.status).toBe(401);
  });

  it("refuses changes from another origin", async () => {
    const cookie = await login(bizA, userA);
    const res = await app().request(`/api/transactions/${saleA}/cancel`, { method: "POST", headers: { cookie: `bw_session=${cookie}`, origin: "https://evil.test", "idempotency-key": "abcdefgh1" } });
    expect(res.status).toBe(403);
  });

  it("logs out: the cookie stops working", async () => {
    const c = `bw_session=${await login(bizA, userA)}`;
    expect((await req(c, "/api/me")).status).toBe(200);
    expect((await req(c, "/api/auth/logout", { method: "POST" })).status).toBe(200);
    expect((await req(c, "/api/me")).status).toBe(401);
  });
});

describe("dashboard data", () => {
  let a: string;
  beforeAll(async () => {
    a = `bw_session=${await login(bizA, userA)}`;
  });

  it("shows the business and its local today", async () => {
    const body = await (await req(a, "/api/me")).json();
    expect(body.business).toMatchObject({ name: "Catering Rina", today: "2026-11-13" });
  });

  it("lists only this business's transactions, money as strings", async () => {
    const body = await (await req(a, "/api/transactions?from=2026-11-01&to=2026-11-30")).json();
    expect(body.transactions.map((t: { description: string }) => t.description)).toEqual(["Jual snack", "Beli ayam", "Jual nasi box"]);
    expect(body.transactions[2]).toMatchObject({ amountIdr: "500000", kind: "sale", editable: true, cancelled: false });
    expect(body.transactions.some((t: { id: string }) => t.id === saleB)).toBe(false);
  });

  it("searches by text", async () => {
    const body = await (await req(a, "/api/transactions?q=ayam")).json();
    expect(body).toMatchObject({ count: 1, totalIdr: "200000" });
  });

  it("can't touch another business's entry", async () => {
    const res = await req(a, `/api/transactions/${saleB}/cancel`, { method: "POST", headers: { "idempotency-key": "cross-tenant-1" } });
    expect(res.status).toBe(404);
  });

  it("splits P&L and cash flow into weekly buckets that add up to the total", async () => {
    const body = await (await req(a, "/api/reports/pnl?from=2026-11-01&to=2026-11-15&bucket=week")).json();
    expect(body.buckets.map((b: { from: string }) => b.from)).toEqual(["2026-11-01", "2026-11-02", "2026-11-09"]);
    const sum = (k: string) => body.buckets.reduce((s: bigint, b: Record<string, string>) => s + BigInt(b[k]!), 0n).toString();
    expect(sum("incomeIdr")).toBe(body.total.incomeIdr);
    expect(sum("profitIdr")).toBe(body.total.profitIdr);
    expect(sum("cashInIdr")).toBe(body.cashFlow.inIdr);
    expect(body.total).toMatchObject({ incomeIdr: "800000", expenseIdr: "200000", profitIdr: "600000" });
  });

  it("refuses a chart with too many buckets", async () => {
    const res = await req(a, "/api/reports/pnl?from=2020-01-01&to=2026-11-13&bucket=day");
    expect(res.status).toBe(400);
  });

  it("exports a monthly report as a signed link", async () => {
    const res = await req(a, "/api/exports", { method: "POST", body: JSON.stringify({ month: "2026-11", format: "xlsx" }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toMatch(/^https:\/\/api\.bukuwa\.test\/r\//);
    const file = await app().request(new URL(body.url).pathname);
    expect(file.status).toBe(200);
  });
});

describe("edit and delete post reversals", () => {
  let a: string;
  beforeAll(async () => {
    a = `bw_session=${await login(bizA, userA)}`;
  });

  it("corrects an amount: reversal plus corrected entry, original kept", async () => {
    const id = await post(bizA, "2026-11-11", "Jual kue", [{ accountCode: "1100", debit: 150_000n }, { accountCode: "4100", credit: 150_000n }]);
    const res = await req(a, `/api/transactions/${id}/correct`, { method: "POST", headers: { "idempotency-key": "fix-kue-0001" }, body: JSON.stringify({ amountIdr: "175000" }) });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.correctedId).toBeTruthy();
    const list = await (await req(a, "/api/transactions?q=kue")).json();
    expect(list.transactions.map((t: { amountIdr: string; cancelled: boolean }) => [t.amountIdr, t.cancelled])).toEqual([
      ["175000", false],
      ["150000", true],
    ]);
    expect(list.totalIdr).toBe("175000");
  });

  it("cancels once; a retry with the same key replays, a new key is a conflict", async () => {
    const id = await post(bizA, "2026-11-12", "Jual es", [{ accountCode: "1100", debit: 40_000n }, { accountCode: "4100", credit: 40_000n }]);
    const first = await (await req(a, `/api/transactions/${id}/cancel`, { method: "POST", headers: { "idempotency-key": "cancel-es-01" } })).json();
    const retry = await (await req(a, `/api/transactions/${id}/cancel`, { method: "POST", headers: { "idempotency-key": "cancel-es-01" } })).json();
    expect(retry).toMatchObject({ reversalId: first.reversalId, replayed: true });
    const other = await req(a, `/api/transactions/${id}/cancel`, { method: "POST", headers: { "idempotency-key": "cancel-es-02" } });
    expect(other.status).toBe(409);
    const audit = await withBusiness(db, bizA, (tx) => tx.query.auditLog.findMany({ where: (t, { eq, and }) => and(eq(t.entityId, id), eq(t.action, "dashboard.cancel")) }));
    expect(audit).toHaveLength(1);
  });

  it("needs an idempotency key", async () => {
    const res = await req(a, `/api/transactions/${saleA}/cancel`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("rejects a category that doesn't fit, in Bahasa", async () => {
    const res = await req(a, `/api/transactions/${saleA}/correct`, { method: "POST", headers: { "idempotency-key": "bad-cat-001" }, body: JSON.stringify({ categoryCode: "6100" }) });
    expect(res.status).toBe(422);
    expect((await res.json()).message).toMatch(/nggak cocok/);
  });
});

describe("contacts", () => {
  it("lists open receivables", async () => {
    const b = `bw_session=${await login(bizB, userB)}`;
    const body = await (await req(b, "/api/contacts")).json();
    expect(body.contacts).toEqual([]);
  });
});

describe("admin console", () => {
  let adm: string;
  beforeAll(async () => {
    const token = await withAppRole(db, (tx) => createAdminLoginToken(tx, { phoneHash: "staff-hash-0001", now: NOW, ttlMs: 600_000 }));
    const res = await app().request("/api/admin/auth/exchange", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/Path=\/api\/admin/);
    adm = `bw_admin=${/bw_admin=([^;]+)/.exec(res.headers.get("set-cookie")!)![1]}`;
  });

  it("an owner session is not an admin session", async () => {
    const owner = `bw_session=${await login(bizA, userA)}`;
    expect((await req(owner, "/api/admin/businesses")).status).toBe(401);
  });

  it("lists every business", async () => {
    const body = await (await req(adm, "/api/admin/businesses")).json();
    expect(body.businesses.map((b: { name: string }) => b.name).sort()).toEqual(["Catering Rina", "Toko Dimas"]);
  });

  it("shows message logs masked, and audits the view", async () => {
    const body = await (await req(adm, `/api/admin/businesses/${bizB}/messages`)).json();
    expect(body.messages[0].body).toBe("NIK [ID], hp 08•••890");
    const audit = await withBusiness(db, bizB, (tx) => tx.query.auditLog.findMany({ where: (t, { eq }) => eq(t.action, "admin.view_messages") }));
    expect(audit).toHaveLength(1);
  });

  it("queues failed captures for review until reviewed", async () => {
    const q = await (await req(adm, "/api/admin/review")).json();
    const item = q.items.find((i: { id: string }) => i.id === failedCapture);
    expect(item).toMatchObject({ reason: "failed", businessName: "Toko Dimas", rawText: "npwp [ID] bayar" });
    const r = await req(adm, `/api/admin/review/${failedCapture}`, { method: "POST", body: JSON.stringify({ verdict: "wrong", wrongFields: ["amount"], note: "nominal hilang" }) });
    expect(r.status).toBe(201);
    const after = await (await req(adm, "/api/admin/review")).json();
    expect(after.items.some((i: { id: string }) => i.id === failedCapture)).toBe(false);
  });
});

describe("maskForStaff", () => {
  it("masks +62 numbers too", () => {
    expect(maskForStaff("wa +62 812 3456 7890 ya")).toBe("wa 08•••890 ya");
  });
});
