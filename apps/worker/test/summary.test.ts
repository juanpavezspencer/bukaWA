import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, hashPii, messages, piiKeysFromBase64, summarySchedules, waInbound, withBusiness, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { buildJournalDraft, findOrCreateContact, postJournal, type PostableEntry } from "@bukuwa/ledger";
import { renderTemplate, type OutboundMessage, type WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { runDueSummaries } from "../src/summary.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";

/* F9: daily / weekly summary pushed at the owner's chosen time, via an approved template. */

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const RINA = "6281234567890";
const DIMAS = "6289876543210";

class FakeSender implements WaSender {
  sent: Array<{ to: string; msg: OutboundMessage }> = [];
  async send(to: string, msg: OutboundMessage) {
    this.sent.push({ to, msg });
    return undefined;
  }
  lastText() {
    const m = this.sent.at(-1)!.msg;
    return m.kind === "template" ? renderTemplate(m) : m.body;
  }
}

let db: Db;
let sender: FakeSender;
let now: Date;
let deps: InboundDeps;
let seq = 0;
const biz: Record<string, string> = {};

async function say(from: string, input: { text?: string; replyId?: string }) {
  const id = `wamid.sum.${++seq}`;
  const payload = input.replyId
    ? { id, from, type: "interactive", interactive: { button_reply: { id: input.replyId, title: "x" } } }
    : { id, from, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: from, type: payload.type, payload });
  await processInbound(deps, id);
}

async function onboard(phone: string, name: string) {
  for (const s of [{ text: "halo" }, { replyId: "consent_yes" }, { text: name }, { replyId: "type_fnb" }, { text: "0" }, { replyId: "confirm_ok" }]) {
    await say(phone, s);
  }
  const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${phone}`)));
  return b!.id;
}

const entry = (e: Partial<PostableEntry> & Pick<PostableEntry, "kind" | "amountIdr" | "date" | "description">): PostableEntry => ({
  source: "text",
  paymentMethod: "cash",
  ...e,
});

async function schedule(businessId: string) {
  return withBusiness(db, businessId, async (tx) => (await tx.select().from(summarySchedules))[0]);
}

beforeEach(async () => {
  ({ db } = await createTestDb());
  sender = new FakeSender();
  now = new Date("2026-11-12T03:00:00Z"); // 10:00 WIB Thursday
  deps = {
    db,
    sender,
    keys,
    ai: { model: new ScriptedModel(), config: aiConfig },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "v1", trialDays: 14, timezone: "Asia/Jakarta" },
    now: () => now,
    log: () => {},
  };
  biz.rina = await onboard(RINA, "Catering Bu Rina");
  biz.dimas = await onboard(DIMAS, "Toko Dimas");
  await withBusiness(db, biz.rina, async (tx) => {
    const post = (e: PostableEntry) => postJournal(tx, buildJournalDraft(biz.rina!, e));
    await post(entry({ kind: "owner_capital", amountIdr: 2_000_000n, date: "2026-11-01", description: "Modal" }));
    await post(entry({ kind: "sale", amountIdr: 900_000n, date: "2026-11-12", description: "Jual nasi box" }));
    await post(entry({ kind: "sale", amountIdr: 360_000n, date: "2026-11-12", description: "Jual kue lapis", paymentMethod: "qris" }));
    await post(entry({ kind: "expense", amountIdr: 878_000n, date: "2026-11-12", description: "Belanja ayam", accountCode: "5100" }));
    await post(entry({ kind: "sale", amountIdr: 500_000n, date: "2026-11-11", description: "Jual tumpeng" }));
    const sari = await findOrCreateContact(tx, biz.rina!, "Bu Sari", "customer");
    await post(entry({ kind: "receivable", amountIdr: 300_000n, date: "2026-11-10", description: "Jual nasi box", paymentMethod: null, contactId: sari }));
  });
  await withBusiness(db, biz.dimas, (tx) =>
    postJournal(tx, buildJournalDraft(biz.dimas!, entry({ kind: "sale", amountIdr: 77_000n, date: "2026-11-12", description: "Jual pulsa" }))),
  );
  sender.sent = [];
});

describe("summary settings from chat", () => {
  it("sets a daily summary at the owner's time", async () => {
    await say(RINA, { text: "kirim ringkasan tiap hari jam 9 malam" });
    expect(sender.lastText()).toContain("Siap! Ringkasan harian aku kirim tiap hari jam 21.00 WIB");
    expect(await schedule(biz.rina!)).toMatchObject({ frequency: "daily", localTime: "21:00", weekday: null, enabled: true, nextRunAt: new Date("2026-11-12T14:00:00Z") });
  });

  it("sets a weekly one, asks for a missing time, and turns it off", async () => {
    await say(RINA, { text: "ringkasan mingguan dong" });
    expect(sender.lastText()).toContain("Mau dikirim jam berapa?");
    expect(await schedule(biz.rina!)).toBeUndefined();
    await say(RINA, { text: "ringkasan mingguan tiap senin jam 8 pagi" });
    expect(sender.lastText()).toContain("tiap Senin jam 08.00 WIB");
    expect((await schedule(biz.rina!))!.nextRunAt).toEqual(new Date("2026-11-16T01:00:00Z"));
    await say(RINA, { text: "stop ringkasan" });
    expect(sender.lastText()).toContain("dimatikan");
    expect((await schedule(biz.rina!))!.enabled).toBe(false);
  });

  it("sends today's summary right away on request", async () => {
    await say(RINA, { text: "rekap dong" });
    const text = sender.lastText();
    expect(text).toContain("Ringkasan 12 Nov untuk Catering Bu Rina");
    expect(text).toContain("💰 Pemasukan: Rp 1.260.000");
    expect(text).toContain("🧾 Pengeluaran: Rp 878.000");
    expect(text).toContain("📈 Laba/rugi: untung Rp 382.000");
    expect(text).toContain("🏦 Total uang (kas, bank, e-wallet): Rp 2.882.000");
    expect(text).toContain("🔥 Paling laku: Jual nasi box (Rp 900.000), Jual kue lapis (Rp 360.000)");
    expect(text).toContain("⏳ Belum dibayar pelanggan: Rp 300.000 dari 1 pelanggan");
  });
});

describe("runDueSummaries", () => {
  it("sends each due business its own summary as a template, once per period", async () => {
    await say(RINA, { text: "ringkasan harian jam 9 malam" });
    await say(DIMAS, { text: "ringkasan harian jam 9 malam" });
    sender.sent = [];

    now = new Date("2026-11-12T13:59:00Z");
    expect(await runDueSummaries(deps, now)).toEqual({ sent: 0, skipped: 0 });

    now = new Date("2026-11-12T14:01:00Z");
    expect(await runDueSummaries(deps, now)).toEqual({ sent: 2, skipped: 0 });
    const byPhone = Object.fromEntries(sender.sent.map((s) => [s.to, s.msg]));
    const rina = byPhone[`+${RINA}`]!;
    expect(rina.kind).toBe("template");
    expect(rina.kind === "template" && rina.params.slice(0, 5)).toEqual(["12 Nov", "Catering Bu Rina", "Rp 1.260.000", "Rp 878.000", "untung Rp 382.000"]);
    const dimas = byPhone[`+${DIMAS}`]!;
    expect(dimas.kind === "template" && dimas.params.slice(0, 3)).toEqual(["12 Nov", "Toko Dimas", "Rp 77.000"]);
    expect(dimas.kind === "template" && dimas.params[7]).toBe("tidak ada");

    // Logged, and moved to tomorrow.
    const log = await withBusiness(db, biz.rina!, (tx) => tx.select().from(messages).where(eq(messages.templateName, "ringkasan_bisnis")));
    expect(log).toHaveLength(1);
    expect((await schedule(biz.rina!))!).toMatchObject({ nextRunAt: new Date("2026-11-13T14:00:00Z"), lastPeriodKey: "daily:2026-11-12" });

    // A second tick sends nothing.
    expect(await runDueSummaries(deps, new Date("2026-11-12T14:02:00Z"))).toEqual({ sent: 0, skipped: 0 });
    expect(sender.sent).toHaveLength(2);
  });

  it("a morning summary covers yesterday; a weekly one the last seven days", async () => {
    await say(RINA, { text: "ringkasan harian jam 7 pagi" });
    sender.sent = [];
    await runDueSummaries(deps, new Date("2026-11-13T00:00:30Z"));
    const m = sender.sent[0]!.msg;
    expect(m.kind === "template" && m.params.slice(0, 3)).toEqual(["12 Nov", "Catering Bu Rina", "Rp 1.260.000"]);

    await say(RINA, { text: "ringkasan mingguan tiap kamis jam 8 malam" });
    sender.sent = [];
    await runDueSummaries(deps, new Date("2026-11-12T13:00:10Z"));
    const w = sender.sent[0]!.msg;
    // 6-12 Nov: three sales plus the credit sale.
    expect(w.kind === "template" && w.params.slice(0, 3)).toEqual(["6–12 Nov", "Catering Bu Rina", "Rp 2.060.000"]);
  });

  it("skips a summary that is hours late instead of sending it at a strange time", async () => {
    await say(RINA, { text: "ringkasan harian jam 9 malam" });
    sender.sent = [];
    expect(await runDueSummaries(deps, new Date("2026-11-13T02:00:00Z"))).toEqual({ sent: 0, skipped: 1 });
    expect(sender.sent).toHaveLength(0);
    expect((await schedule(biz.rina!))!.nextRunAt).toEqual(new Date("2026-11-13T14:00:00Z"));
  });

  it("ignores disabled schedules", async () => {
    await say(RINA, { text: "ringkasan harian jam 9 malam" });
    await say(RINA, { text: "matikan ringkasan" });
    sender.sent = [];
    expect(await runDueSummaries(deps, new Date("2026-11-12T14:01:00Z"))).toEqual({ sent: 0, skipped: 0 });
  });
});
