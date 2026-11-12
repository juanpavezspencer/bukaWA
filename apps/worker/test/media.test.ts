import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { businesses, captures, hashPii, journalLines, journals, piiKeysFromBase64, waInbound, withBusiness, accounts, type Db } from "@bukuwa/db";
import { createTestDb } from "@bukuwa/db/testing";
import { masked, type SpeechToText } from "@bukuwa/ai";
import { trialBalance } from "@bukuwa/ledger";
import { MediaTooLargeError, type MediaFetcher, type OutboundMessage, type WaSender } from "@bukuwa/wa";
import { processInbound, type InboundDeps } from "../src/inbound.js";
import { memoryMediaStore } from "../src/media/store.js";
import { aiConfig, ScriptedModel } from "./fake-model.js";

const keys = piiKeysFromBase64(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"));
const RINA = "6281234567890";
const NOW = new Date("2026-11-12T03:00:00Z"); // 10:00 WIB, 12 Nov

class FakeSender implements WaSender {
  sent: OutboundMessage[] = [];
  async send(_to: string, msg: OutboundMessage) {
    this.sent.push(msg);
    return undefined;
  }
  bodies() {
    return this.sent.map((m) => m.body);
  }
  button(title: string): string {
    const m = this.sent.at(-1)!;
    const hit = (m.kind === "buttons" ? m.buttons : []).find((o) => o.title === title);
    if (!hit) throw new Error(`no "${title}" in: ${m.body}`);
    return hit.id;
  }
}

class FakeFetcher implements MediaFetcher {
  calls: string[] = [];
  files = new Map<string, { bytes: Uint8Array; mimeType: string } | Error>();
  async fetch(id: string) {
    this.calls.push(id);
    const f = this.files.get(id);
    if (!f) throw new Error(`no media ${id}`);
    if (f instanceof Error) throw f;
    return f;
  }
}

/** Transcribes by looking the audio bytes up as text. */
const fakeStt: SpeechToText = masked({
  async transcribe(audio) {
    return { text: new TextDecoder().decode(audio.bytes), model: "fake-stt/v1" };
  },
});

let db: Db;
let sender: FakeSender;
let model: ScriptedModel;
let fetcher: FakeFetcher;
let store: ReturnType<typeof memoryMediaStore>;
let deps: InboundDeps;
let bizId: string;
let seq = 0;

type Input = { text?: string; replyId?: string; image?: { caption?: string }; voice?: true; sticker?: true; mediaId?: string };

async function say(input: Input): Promise<string> {
  const id = `wamid.media.${++seq}`;
  const mediaId = input.mediaId ?? "m1";
  const payload =
    input.image ? { id, from: RINA, type: "image", image: { id: mediaId, mime_type: "image/jpeg", caption: input.image.caption } }
    : input.voice ? { id, from: RINA, type: "audio", audio: { id: mediaId, mime_type: "audio/ogg; codecs=opus", voice: true } }
    : input.sticker ? { id, from: RINA, type: "sticker", sticker: { id: mediaId } }
    : input.replyId ? { id, from: RINA, type: "interactive", interactive: { button_reply: { id: input.replyId, title: "x" } } }
    : { id, from: RINA, type: "text", text: { body: input.text } };
  await db.insert(waInbound).values({ waMessageId: id, fromPhone: RINA, type: payload.type, payload });
  await processInbound(deps, id);
  return id;
}

async function latestCapture() {
  return withBusiness(db, bizId, async (tx) => (await tx.select().from(captures).orderBy(sql`created_at desc`).limit(1))[0]);
}

beforeEach(async () => {
  ({ db } = await createTestDb());
  sender = new FakeSender();
  model = new ScriptedModel();
  fetcher = new FakeFetcher();
  store = memoryMediaStore();
  deps = {
    db,
    sender,
    keys,
    ai: { model, config: aiConfig, stt: fakeStt },
    media: { fetcher, store },
    config: { privacyPolicyUrl: "https://bukuwa.id/privasi", consentVersion: "v1", trialDays: 14, timezone: "Asia/Jakarta" },
    now: () => NOW,
    log: () => {},
  };
  await say({ text: "halo" });
  await say({ replyId: "consent_yes" });
  await say({ text: "Catering Bu Rina" });
  await say({ replyId: "type_fnb" });
  await say({ text: "0" });
  await say({ replyId: "confirm_ok" });
  const [b] = await db.select().from(businesses).where(eq(businesses.ownerPhoneHash, hashPii(keys, `+${RINA}`)));
  bizId = b!.id;
  sender.sent = [];
});

const RECEIPT = [
  "Transfer Masuk",
  "12 Nov 2026 14:03 WIB",
  "Dari: SARI W",
  "Bank BCA",
  "Nominal Rp 450.000,00",
  "NIK 3174012345678901",
].join("\n");

describe("photo capture (F3, Flow A)", () => {
  beforeEach(() => {
    fetcher.files.set("m1", { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg" });
    model.vision = {
      document_type: "transfer_receipt",
      visible_text: RECEIPT,
      entries: [
        {
          kind: "sale",
          description: "Transfer masuk dari Sari W",
          amount_text: "Rp 450.000,00",
          date_text: "12 Nov 2026 14:03",
          counterparty: "SARI W",
          payment_text: "BCA",
          suggested_category: "Penjualan",
        },
      ],
    };
  });

  it("acknowledges fast, stores the original, reads it, and posts only after OK", async () => {
    await say({ image: { caption: "dp nasi box" } });

    expect(sender.bodies()[0]).toMatch(/lagi dibaca/);
    expect([...store.objects.keys()]).toEqual([`${bizId}/wamid.media.7.jpg`]);
    expect(model.calls.at(-1)!.attachments).toBe(1);
    expect(sender.sent.at(-1)!.body).toContain("Pemasukan Rp 450.000 dari SARI W (transfer BCA), 12 Nov");
    expect((await withBusiness(db, bizId, (tx) => tx.select().from(journals))).length).toBe(0);

    const cap = await latestCapture();
    expect(cap).toMatchObject({ source: "photo", status: "awaiting_confirmation", rawText: "dp nasi box", mediaUrl: `mem://${bizId}/wamid.media.7.jpg` });
    expect(cap!.modelVersion).toBe("claude-sonnet-5-5/vision-v1");
    const stored = cap!.extractionJson as { documentType: string; visibleText: string };
    expect(stored.documentType).toBe("transfer_receipt");
    expect(stored.visibleText).not.toContain("3174012345678901");

    await say({ replyId: sender.button("OK") });
    const [j] = await withBusiness(db, bizId, (tx) => tx.select().from(journals));
    expect(j).toMatchObject({ source: "photo", date: "2026-11-12" });
    const tb = await withBusiness(db, bizId, (tx) => trialBalance(tx, bizId));
    expect(tb.balanced).toBe(true);
    expect(Object.fromEntries(tb.rows.map((r) => [r.code, r.balance]))).toMatchObject({ "1110": 450_000n, "4100": -450_000n });
  });

  it("does not trust an amount that isn't on the photo; asks instead", async () => {
    model.vision!.entries[0]!.amount_text = "Rp 540.000";
    await say({ image: {} });
    expect(sender.sent.at(-1)!.body).toMatch(/Nominalnya berapa/);
  });

  it("says so when the picture isn't a financial document", async () => {
    model.vision = { document_type: "not_a_document", visible_text: "", entries: [] };
    await say({ image: {} });
    expect(sender.sent.at(-1)!.body).toMatch(/nggak nemu transaksi/);
    expect(await latestCapture()).toBeUndefined();
    expect(store.objects.size).toBe(1); // the original is still kept
  });

  it("refuses files over the size limit", async () => {
    fetcher.files.set("m1", new MediaTooLargeError(50_000_000));
    await say({ image: {} });
    expect(sender.sent.at(-1)!.body).toMatch(/kegedean/);
  });

  it("processes a redelivered photo once", async () => {
    const id = await say({ image: {} });
    const sent = sender.sent.length;
    await processInbound(deps, id);
    expect(sender.sent.length).toBe(sent);
    expect(fetcher.calls).toHaveLength(1);
  });
});

describe("voice capture (F4, Flow B)", () => {
  const NOTE = "tadi belanja ayam 5 kilo seratus tujuh puluh lima ribu, token listrik seratus ribu, cash";

  it("transcribes, extracts several lines, and splits categories it has learned", async () => {
    // Teach a rule first: token listrik -> Listrik & air.
    model.set("beli token listrik 50rb cash", {
      intent: "transaction",
      entries: [{ kind: "expense", description: "Beli token listrik", amount_text: "50rb", payment_text: "cash", suggested_category: "Listrik & air" }],
    });
    await say({ text: "beli token listrik 50rb cash" });
    await say({ replyId: sender.button("OK") });

    fetcher.files.set("v1", { bytes: new TextEncoder().encode(NOTE), mimeType: "audio/ogg" });
    model.set(NOTE, {
      intent: "transaction",
      entries: [
        {
          kind: "expense",
          description: "Belanja ayam dan token listrik",
          items: [
            { name: "ayam", qty_text: "5", unit: "kilo", unit_price_text: null, line_total_text: "seratus tujuh puluh lima ribu" },
            { name: "token listrik", qty_text: null, unit: null, unit_price_text: null, line_total_text: "seratus ribu" },
          ],
          date_text: "tadi",
          payment_text: "cash",
          suggested_category: "HPP / Bahan baku",
        },
      ],
    });
    sender.sent = [];
    await say({ voice: true, mediaId: "v1" });

    expect(sender.bodies()[0]).toMatch(/didengerin/);
    const card = sender.sent.at(-1)!.body;
    expect(card).toContain("Pengeluaran Rp 275.000 (cash), 12 Nov");
    expect(card).toContain("• ayam 5 kilo Rp 175.000 (HPP / Bahan baku)");
    expect(card).toContain("• token listrik Rp 100.000 (Listrik & air)");

    const cap = await latestCapture();
    expect(cap).toMatchObject({ source: "voice", transcript: NOTE, rawText: null });
    expect(cap!.modelVersion).toBe("fake-stt/v1+claude-haiku-5-5/extractor-v1");

    await say({ replyId: sender.button("OK") });
    const lines = await withBusiness(db, bizId, (tx) =>
      tx
        .select({ code: accounts.code, debit: journalLines.debit, credit: journalLines.credit })
        .from(journalLines)
        .innerJoin(journals, eq(journals.id, journalLines.journalId))
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(eq(journals.source, "voice")),
    );
    expect(lines.sort((a, b) => a.code.localeCompare(b.code))).toEqual([
      { code: "1100", debit: 0n, credit: 275_000n },
      { code: "5100", debit: 175_000n, credit: 0n },
      { code: "6300", debit: 100_000n, credit: 0n },
    ]);
  });

  it("routes a spoken question like a typed one", async () => {
    fetcher.files.set("v2", { bytes: new TextEncoder().encode("untung minggu ini berapa"), mimeType: "audio/ogg" });
    model.set("untung minggu ini berapa", { intent: "question" });
    await say({ voice: true, mediaId: "v2" });
    expect(sender.sent.at(-1)!.body).toMatch(/tanya laporan/);
  });

  it("replies 'not yet' without downloading when no speech-to-text is configured", async () => {
    deps.ai.stt = undefined;
    await say({ voice: true, mediaId: "v1" });
    expect(sender.sent.at(-1)!.body).toMatch(/Voice note belum bisa/);
    expect(fetcher.calls).toEqual([]);
  });
});

describe("other inbound types", () => {
  it("explains what it can read", async () => {
    await say({ sticker: true });
    expect(sender.sent.at(-1)!.body).toMatch(/Yang ini belum bisa/);
  });

  it("without media storage configured, keeps the old 'not yet' reply", async () => {
    deps.media = undefined;
    await say({ image: {} });
    expect(sender.sent.at(-1)!.body).toMatch(/segera bisa aku baca/);
  });
});
