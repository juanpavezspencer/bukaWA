import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, businesses, captures, hashPii, messages, piiKeysFromBase64, reports, taxNoticeSchedules, waInbound, withBusiness, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { buildJournalDraft, postJournal, type PostableEntry } from "@bukuwa/ledger";
import { linkSigner, verifyLink } from "@bukuwa/reports";
import { renderTemplate, type OutboundMessage, type WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { runDueTaxNotices, type TaxDeps } from "../src/tax.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";
import { call, ScriptedChat, say as agentSays } from "./fake-chat.js";

/* F10 / Flow E: tax estimate, report links and the month-end notice, end to end through processInbound. */

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const linkKey = randomBytes(32);
const RINA = "6281234567890";
const DIMAS = "6289876543210";

class FakeSender implements WaSender {
  sent: Array<{ to: string; msg: OutboundMessage }> = [];
  async send(to: string, msg: OutboundMessage) {
    this.sent.push({ to, msg });
    return undefined;
  }
  last() {
    return this.sent.at(-1)!.msg;
  }
  text() {
    const m = this.last();
    return m.kind === "template" ? renderTemplate(m) : m.body;
  }
}

let db: Db;
let sender: FakeSender;
let model: ScriptedModel;
let chat: ScriptedChat;
let now: Date;
let deps: InboundDeps;
let tax: TaxDeps;
let seq = 0;
const biz: Record<string, string> = {};

async function say(from: string, input: { text?: string; replyId?: string; templateButton?: string }) {
  const id = `wamid.tax.${++seq}`;
  const payload = input.templateButton
    ? { id, from, type: "button", button: { payload: input.templateButton, text: "Lihat laporan" } }
    : input.replyId
      ? { id, from, type: "interactive", interactive: { button_reply: { id: input.replyId, title: "x" } } }
      : { id, from, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: from, type: payload.type, payload });
  await processInbound(deps, id);
}

async function onboard(phone: string, name: string) {
  for (const s of [{ text: "halo" }, { replyId: "consent_yes" }, { text: name }, { replyId: "type_fnb" }, { text: "0" }, { replyId: "confirm_ok" }]) await say(phone, s);
  const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${phone}`)));
  return b!.id;
}

const entry = (e: Partial<PostableEntry> & Pick<PostableEntry, "kind" | "amountIdr" | "date">): PostableEntry => ({
  description: "Penjualan",
  source: "text",
  paymentMethod: "bank:BCA",
  ...e,
});

const schedule = (b: string) => withBusiness(db, b, async (tx) => (await tx.select().from(taxNoticeSchedules))[0]);

beforeEach(async () => {
  ({ db } = await createTestDb());
  sender = new FakeSender();
  model = new ScriptedModel();
  chat = new ScriptedChat();
  now = new Date("2026-11-13T03:00:00Z"); // Friday 13 Nov, 10:00 WIB
  tax = {
    defaultRegime: "umkm_final_individual",
    noticeLocalTime: "08:00",
    reportLinkTtlMinutes: 15,
    links: linkSigner({ key: linkKey, baseUrl: "https://api.bukuwa.test", reportTtlMinutes: 15, evidenceTtlHours: 168 }),
  };
  deps = {
    db,
    sender,
    keys,
    ai: { model, chat, config: aiConfig },
    tax,
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "v1", trialDays: 14, timezone: "Asia/Jakarta" },
    now: () => now,
    log: () => {},
  };
  biz.rina = await onboard(RINA, "Catering Bu Rina");
  biz.dimas = await onboard(DIMAS, "Toko Dimas");
  await withBusiness(db, biz.rina, async (tx) => {
    const post = (e: PostableEntry) => postJournal(tx, buildJournalDraft(biz.rina!, e));
    for (let m = 1; m <= 9; m++) await post(entry({ kind: "sale", amountIdr: m === 9 ? 80_000_000n : 50_000_000n, date: `2026-0${m}-10` }));
    await post(entry({ kind: "sale", amountIdr: 50_000_000n, date: "2026-10-10", description: "Catering nikahan" }));
    await post(entry({ kind: "sale", amountIdr: 4_000_000n, date: "2026-11-05", description: "Catering arisan" }));
  });
  sender.sent = [];
});

const lastButtons = () => {
  const m = sender.last();
  return m.kind === "buttons" ? m.buttons : [];
};

describe("tax estimate from chat", () => {
  it("answers last month's tax by default, with the allowance crossed and report buttons", async () => {
    await say(RINA, { text: "pajakku berapa?" });
    const body = sender.text();
    expect(body).toContain("Perkiraan pajak *Oktober 2026*");
    expect(body).toContain("• Omzet: Rp 50.000.000");
    expect(body).toContain("• Omzet sejak Januari: Rp 530.000.000");
    expect(body).toContain("• Kena pajak: Rp 30.000.000 × 0,5%");
    expect(body).toContain("• Pajak: *Rp 150.000*, bayar paling lambat 16 Nov 2026");
    expect(body).toContain("bukan nasihat pajak");
    expect(lastButtons().map((b) => b.id)).toEqual(["report:2026-10:pdf", "report:2026-10:xlsx"]);
    expect(model.calls).toHaveLength(0); // parsed by code, no model call
  });

  it("estimates the running month up to today", async () => {
    await say(RINA, { text: "pajak bulan ini berapa" });
    expect(sender.text()).toContain("Perkiraan pajak *November 2026* (s/d 13 Nov 2026)");
    expect(sender.text()).toContain("masih bisa nambah");
  });

  it("is zero, with the allowance left, for a business under the threshold", async () => {
    await say(DIMAS, { text: "pajak bulan lalu" });
    expect(sender.text()).toContain("• Pajak: *Rp 0*");
    expect(sender.text()).toContain("sisa Rp 500.000.000");
  });

  it("refuses a month that hasn't started", async () => {
    await say(RINA, { text: "pajak desember 2026" });
    expect(sender.text()).toContain("Desember 2026 belum mulai");
  });

  it("still records 'bayar pajak 150rb' as a transaction", async () => {
    model.set("bayar pajak 150rb tf bca", { intent: "transaction", entries: [{ kind: "expense", description: "Bayar pajak", amount_text: "150rb", payment_text: "tf bca", suggested_category: "Beban pajak" }] });
    await say(RINA, { text: "bayar pajak 150rb tf bca" });
    const [c] = await withBusiness(db, biz.rina!, (tx) => tx.select().from(captures));
    expect(c?.status).toBe("awaiting_confirmation");
  });

  it("says 'coming soon' when tax isn't configured", async () => {
    deps.tax = undefined;
    await say(RINA, { text: "pajak bulan lalu" });
    expect(sender.text()).toContain("segera hadir");
  });
});

describe("report links", () => {
  it("generates the report on a button tap and replies with a signed link that opens it", async () => {
    await say(RINA, { replyId: "report:2026-10:pdf" });
    const body = sender.text();
    expect(body).toContain("Laporan Oktober 2026 versi PDF sudah siap");
    expect(body).toContain("Link berlaku 15 menit");
    const url = /https:\/\/api\.bukuwa\.test\/r\/(\S+)/.exec(body)!;
    const v = verifyLink(linkKey, url[1]!, now);
    expect(v.ok && v.claims).toMatchObject({ kind: "report", businessId: biz.rina });
    const [r] = await withBusiness(db, biz.rina!, (tx) => tx.select().from(reports));
    expect(v.ok && v.claims.id).toBe(r!.id);
    expect(r).toMatchObject({ format: "pdf", periodFrom: "2026-10-01", periodTo: "2026-10-31" });
    const audit = await withBusiness(db, biz.rina!, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "report.export")));
    expect(audit).toHaveLength(1);
  });

  it("understands typed requests, Excel included", async () => {
    await say(RINA, { text: "kirim laporan oktober excel ya" });
    expect(sender.text()).toContain("versi Excel");
    const [r] = await withBusiness(db, biz.rina!, (tx) => tx.select().from(reports));
    expect(r!.format).toBe("xlsx");
  });

  it("answers the month-end template's 'Lihat laporan' button", async () => {
    await say(RINA, { templateButton: "report:2026-10:pdf" });
    expect(sender.text()).toContain("Laporan Oktober 2026 versi PDF sudah siap");
  });

  it("keeps each business's reports to itself", async () => {
    await say(RINA, { replyId: "report:2026-10:pdf" });
    expect(await withBusiness(db, biz.dimas!, (tx) => tx.select().from(reports))).toEqual([]);
  });
});

describe("agent tools", () => {
  it("explains the tax from get_tax_estimate's numbers", async () => {
    model.set("kenapa pajak oktober segitu?", { intent: "question" });
    chat.steps = [
      call("get_tax_estimate", { period: { preset: null, month: "2026-10" } }),
      agentSays((r) => `Omzet ${r.turnover}, yang kena pajak ${r.taxable_turnover}, pajaknya *${r.tax}*. ${r.disclaimer}`),
    ];
    await say(RINA, { text: "kenapa pajak oktober segitu?" });
    expect(sender.text()).toBe("Omzet Rp 50.000.000, yang kena pajak Rp 30.000.000, pajaknya *Rp 150.000*. Ini perkiraan, bukan nasihat pajak. Cek lagi dengan konsultan pajak sebelum bayar dan lapor.");
  });

  it("turns create_report_link into a generated report and link", async () => {
    model.set("tolong buatin laporan bulan lalu buat akuntanku", { intent: "question" });
    chat.steps = [call("create_report_link", { period: { preset: "last_month", month: null }, format: "xlsx" })];
    await say(RINA, { text: "tolong buatin laporan bulan lalu buat akuntanku" });
    expect(sender.text()).toContain("Laporan Oktober 2026 versi Excel sudah siap");
  });

  it("rejects a future month in the tool without generating anything", async () => {
    model.set("laporan tahun depan dong", { intent: "question" });
    chat.steps = [call("create_report_link", { period: { preset: null, month: "2027-01" }, format: "pdf" }), agentSays("Bulan itu belum mulai, kak.")];
    await say(RINA, { text: "laporan tahun depan dong" });
    expect(sender.text()).toBe("Bulan itu belum mulai, kak.");
    expect(await withBusiness(db, biz.rina!, (tx) => tx.select().from(reports))).toEqual([]);
  });
});

describe("month-end tax notice (Flow E)", () => {
  it("is scheduled at onboarding for 08:00 on the 1st", async () => {
    expect(await schedule(biz.rina!)).toMatchObject({ enabled: true, nextRunAt: new Date("2026-12-01T01:00:00Z") });
  });

  it("sends last month's estimate as the template with a report button, once", async () => {
    // Push both schedules to 1 Nov so October is reported.
    for (const b of [biz.rina!, biz.dimas!]) {
      await withBusiness(db, b, (tx) => tx.update(taxNoticeSchedules).set({ nextRunAt: new Date("2026-11-01T01:00:00Z") }));
    }
    now = new Date("2026-11-01T01:05:00Z");
    // Dimas has no turnover: skipped quietly, but the schedule still moves on.
    expect(await runDueTaxNotices({ ...deps, tax }, now)).toEqual({ sent: 1, skipped: 0 });
    const m = sender.last();
    expect(m.kind).toBe("template");
    expect(m.kind === "template" && m).toMatchObject({
      name: "pajak_bulanan",
      params: ["Oktober 2026", "Catering Bu Rina", "Rp 50.000.000", "Rp 530.000.000", "Rp 150.000", "16 Nov 2026", expect.stringContaining("Batas bebas pajak Rp 500.000.000")],
      buttonPayloads: ["report:2026-10:pdf"],
    });
    expect(sender.sent[0]!.to).toBe(`+${RINA}`);
    expect(await schedule(biz.rina!)).toMatchObject({ lastPeriod: "2026-10", nextRunAt: new Date("2026-12-01T01:00:00Z") });
    expect(await schedule(biz.dimas!)).toMatchObject({ lastPeriod: "2026-10", lastSentAt: null, nextRunAt: new Date("2026-12-01T01:00:00Z") });
    const log = await withBusiness(db, biz.rina!, (tx) => tx.select().from(messages).where(eq(messages.templateName, "pajak_bulanan")));
    expect(log).toHaveLength(1);
    expect(await runDueTaxNotices({ ...deps, tax }, new Date("2026-11-01T01:15:00Z"))).toEqual({ sent: 0, skipped: 0 });
  });

  it("can be turned off and on from chat", async () => {
    await say(RINA, { text: "stop pengingat pajak" });
    expect(sender.text()).toContain("dimatikan");
    expect((await schedule(biz.rina!))!.enabled).toBe(false);
    await withBusiness(db, biz.rina!, (tx) => tx.update(taxNoticeSchedules).set({ nextRunAt: new Date("2026-11-01T01:00:00Z") }));
    expect(await runDueTaxNotices({ ...deps, tax }, new Date("2026-11-01T01:05:00Z"))).toEqual({ sent: 0, skipped: 0 });
    await say(RINA, { text: "nyalakan pengingat pajak" });
    expect((await schedule(biz.rina!))!).toMatchObject({ enabled: true, nextRunAt: new Date("2026-12-01T01:00:00Z") });
  });

  it("skips a notice that is days late instead of sending it at an odd time", async () => {
    await withBusiness(db, biz.rina!, (tx) => tx.update(taxNoticeSchedules).set({ nextRunAt: new Date("2026-11-01T01:00:00Z") }));
    expect(await runDueTaxNotices({ ...deps, tax }, new Date("2026-11-05T01:00:00Z"))).toMatchObject({ sent: 0, skipped: 1 });
  });
});
