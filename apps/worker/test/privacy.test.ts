import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import {
  auditLog,
  businesses,
  captures,
  erasureRequests,
  hashPii,
  memoryMediaStore,
  piiKeysFromBase64,
  reports,
  rows,
  TENANT_TABLES,
  waInbound,
  withBusiness,
  type Db,
} from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { postJournal } from "@bukuwa/ledger";
import { linkSigner, verifyLink } from "@bukuwa/reports";
import { messageText, type OutboundMessage, type WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { ERASE_NO, ERASE_YES, parsePrivacyRequest, runDueErasures } from "../src/privacy.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const linkKey = randomBytes(32);
const RINA = "6281234567890";
const DIMAS = "6281398765432";
const NOW = new Date("2026-11-12T05:00:00Z");

class FakeSender implements WaSender {
  sent: Array<{ to: string; msg: OutboundMessage }> = [];
  async send(to: string, msg: OutboundMessage) {
    this.sent.push({ to, msg });
    return "wamid.out";
  }
  last(): OutboundMessage {
    return this.sent.at(-1)!.msg;
  }
}

let db: Db;
let sender: FakeSender;
let deps: InboundDeps;
let media: ReturnType<typeof memoryMediaStore>;
let seq = 0;

async function say(from: string, input: { text?: string; replyId?: string }) {
  const id = `wamid.p.${++seq}`;
  const payload = input.replyId
    ? { id, from, type: "interactive", interactive: { type: "button_reply", button_reply: { id: input.replyId, title: "x" } } }
    : { id, from, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: from, type: payload.type, payload });
  await processInbound(deps, id);
}

async function onboard(phone: string, name: string): Promise<string> {
  for (const m of [{ text: "halo" }, { replyId: "consent_yes" }, { text: name }, { replyId: "type_fnb" }, { text: "500rb" }, { replyId: "confirm_ok" }]) await say(phone, m);
  const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${phone}`)));
  return b!.id;
}

const linkIn = (msg: OutboundMessage) => /https:\/\/api\.bukuwa\.test\/r\/(\S+)/.exec(messageText(msg))?.[1];

beforeEach(async () => {
  ({ db } = await createTestDb());
  sender = new FakeSender();
  media = memoryMediaStore();
  deps = {
    db,
    sender,
    keys,
    ai: { model: new ScriptedModel(), config: aiConfig },
    media: { fetcher: { fetch: async () => ({ bytes: new Uint8Array(), mimeType: "image/jpeg" }) }, store: media },
    privacy: {
      links: linkSigner({ key: linkKey, baseUrl: "https://api.bukuwa.test", reportTtlMinutes: 15, evidenceTtlHours: 24 }),
      reportLinkTtlMinutes: 15,
      graceDays: 7,
    },
    limits: { dailyInbound: 3 },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "2026-11-v2", trialDays: 14, timezone: "Asia/Jakarta" },
    now: () => NOW,
    log: () => {},
  };
});

describe("parsePrivacyRequest", () => {
  it("understands the usual ways owners ask", () => {
    expect(parsePrivacyRequest("ekspor data")).toBe("export");
    expect(parsePrivacyRequest("Download data saya")).toBe("export");
    expect(parsePrivacyRequest("hapus data")).toBe("erase");
    expect(parsePrivacyRequest("hapus semua data saya!")).toBe("erase");
    expect(parsePrivacyRequest("hapus akun")).toBe("erase");
    expect(parsePrivacyRequest("batal hapus")).toBe("cancel_erase");
    expect(parsePrivacyRequest("jangan jadi hapus data")).toBe("cancel_erase");
    // Corrections are not erasure requests.
    expect(parsePrivacyRequest("hapus transaksi tadi")).toBeNull();
    expect(parsePrivacyRequest("hapus data penjualan kemarin")).toBeNull();
  });
});

describe("ekspor data", () => {
  it("sends a signed link to an Excel file with the whole ledger, contacts and chat, and audits it", async () => {
    const biz = await onboard(RINA, "Catering Bu Rina");
    await say(RINA, { text: "ekspor data" });
    const token = linkIn(sender.last());
    expect(token).toBeDefined();
    const claims = verifyLink(linkKey, token!, NOW);
    expect(claims).toMatchObject({ ok: true, claims: { kind: "report", businessId: biz } });

    const file = await withBusiness(db, biz, async (tx) => (await tx.select().from(reports).where(eq(reports.kind, "data_export")))[0]!);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.content as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Info", "Jurnal", "Kontak", "Pesan", "Catatan dari chat", "Riwayat"]);
    expect(wb.getWorksheet("Info")!.getRow(4).getCell(2).value).toBe(`+${RINA}`);
    const ledger = wb.getWorksheet("Jurnal")!;
    expect(ledger.rowCount).toBe(3); // header + opening balance (2 lines)
    expect(ledger.getRow(2).getCell("G").value).toBe(500_000);
    expect(wb.getWorksheet("Pesan")!.rowCount).toBeGreaterThan(1);

    const audit = await withBusiness(db, biz, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "privacy.export")));
    expect(audit).toHaveLength(1);
  });

  it("still works over the daily message cap", async () => {
    await onboard(RINA, "Catering Bu Rina");
    for (let i = 0; i < 4; i++) await say(RINA, { text: "ekspor data" });
    expect(linkIn(sender.last())).toBeDefined();
  });
});

describe("hapus data", () => {
  it("asks first, then schedules erasure with an export link, and can be cancelled", async () => {
    const biz = await onboard(RINA, "Catering Bu Rina");
    await say(RINA, { text: "hapus data" });
    const ask = sender.last();
    expect(ask.kind).toBe("buttons");
    expect(messageText(ask)).toMatch(/dihapus permanen 7 hari lagi/);
    expect(await withBusiness(db, biz, (tx) => tx.select().from(erasureRequests))).toHaveLength(0);

    await say(RINA, { replyId: ERASE_NO });
    expect(await withBusiness(db, biz, (tx) => tx.select().from(erasureRequests))).toHaveLength(0);

    await say(RINA, { replyId: ERASE_YES });
    expect(messageText(sender.last())).toMatch(/19 November 2026/);
    expect(linkIn(sender.last())).toBeDefined();
    const [req] = await withBusiness(db, biz, (tx) => tx.select().from(erasureRequests));
    expect(req!.scheduledFor.toISOString()).toBe("2026-11-19T05:00:00.000Z");

    await say(RINA, { text: "hapus data" });
    expect(messageText(sender.last())).toMatch(/sudah tercatat/);

    await say(RINA, { text: "batal hapus" });
    expect(messageText(sender.last())).toMatch(/dibatalkan/);
    const [after] = await withBusiness(db, biz, (tx) => tx.select().from(erasureRequests));
    expect(after!.cancelledAt).not.toBeNull();
    const actions = await withBusiness(db, biz, (tx) => tx.select({ a: auditLog.action }).from(auditLog));
    expect(actions.map((x) => x.a)).toEqual(expect.arrayContaining(["privacy.erasure_requested", "privacy.erasure_cancelled"]));
  });

  it("renews a cancelled request with fresh dates", async () => {
    const biz = await onboard(RINA, "Catering Bu Rina");
    await say(RINA, { replyId: ERASE_YES });
    await say(RINA, { text: "batal hapus" });
    deps.now = () => new Date("2026-11-20T05:00:00Z");
    await say(RINA, { replyId: ERASE_YES });
    const [req] = await withBusiness(db, biz, (tx) => tx.select().from(erasureRequests));
    expect(req).toMatchObject({ cancelledAt: null });
    expect(req!.scheduledFor.toISOString()).toBe("2026-11-27T05:00:00.000Z");
  });
});

describe("erasure tick", () => {
  it("removes the business's rows and media after the grace period, and nobody else's", async () => {
    const rina = await onboard(RINA, "Catering Bu Rina");
    const dimas = await onboard(DIMAS, "Toko Dimas");
    await media.put(`${rina}/wamid.x.jpg`, new Uint8Array([1]), "image/jpeg");
    await media.put(`${dimas}/wamid.y.jpg`, new Uint8Array([2]), "image/jpeg");
    await withBusiness(db, rina, async (tx) => {
      const j = await postJournal(tx, { businessId: rina, date: "2026-11-12", description: "Jual nasi box", source: "photo", lines: [{ accountCode: "1100", debit: 450_000n }, { accountCode: "4100", credit: 450_000n }] });
      await tx.insert(captures).values({ businessId: rina, source: "photo", mediaUrl: `mem://${rina}/wamid.x.jpg`, status: "confirmed", journalId: j.id });
    });
    await say(RINA, { replyId: ERASE_YES });

    expect((await runDueErasures({ ...deps, media: { store: media } }, new Date("2026-11-18T00:00:00Z"))).erased).toBe(0);
    expect((await runDueErasures({ ...deps, media: { store: media } }, new Date("2026-11-19T06:00:00Z"))).erased).toBe(1);

    for (const t of TENANT_TABLES) {
      const col = sql.identifier(t === "businesses" ? "id" : "business_id");
      const [r] = rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from ${sql.identifier(t)} where ${col} = ${rina}`));
      expect(r!.n, t).toBe(0);
    }
    const inbox = rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from wa_inbound where from_phone = ${RINA}`));
    expect(inbox[0]!.n).toBe(0);
    expect([...media.objects.keys()]).toEqual([`${dimas}/wamid.y.jpg`]);
    expect(await withBusiness(db, dimas, (tx) => tx.select().from(businesses))).toHaveLength(1);

    // The number can start over as a brand-new business.
    sender.sent = [];
    await say(RINA, { text: "halo" });
    expect(messageText(sender.last())).toMatch(/izin kamu/);
  });
});
