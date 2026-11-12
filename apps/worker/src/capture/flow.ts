import { and, desc, eq, gt, sql } from "drizzle-orm";
import { accounts, captures, categoryRules, type Tx } from "@bukuwa/db";
import { categorize, patternsFor, type Account, type NormalizedEntry, type RawExtraction } from "@bukuwa/ai";
import { formatRupiah } from "@bukuwa/idn";
import { buildJournalDraft, daySummary, postJournal } from "@bukuwa/ledger";
import type { OutboundMessage } from "@bukuwa/wa";
import { askAmount, askPayment, captureCard, type CardEntry } from "./card.js";

/*
 * Capture lifecycle (F2, F5, F6):
 *   extracted              -> waiting for a missing amount or payment method
 *   awaiting_confirmation  -> confirm card sent (OK / Ubah / Batal)
 *   confirmed              -> journals posted
 *   cancelled              -> owner cancelled or edited, or superseded
 * Nothing reaches the ledger except through confirmCapture().
 */

const SUPPORTED_KINDS = new Set(["sale", "expense", "owner_capital", "owner_drawing"]);
/** A capture waiting for an answer is only matched to replies within this window. */
const PENDING_WINDOW_MINUTES = 30;

export interface StoredEntry {
  kind: string;
  description: string;
  amountIdr: string | null;
  date: string;
  counterparty: string | null;
  paymentMethod: string | null;
  items: Array<{ name: string; qtyText: string | null; unit: string | null; unitPriceIdr: string | null; lineTotalIdr: string | null }>;
  accountCode: string | null;
  categorySource: "rule" | "model" | "default";
  lowConfidence: NormalizedEntry["lowConfidence"];
  missing: NormalizedEntry["missing"];
}

export interface StoredCapture {
  routerModelVersion: string;
  raw: RawExtraction;
  entries: StoredEntry[];
  notes: string[];
}

type CaptureRow = typeof captures.$inferSelect;

async function loadAccounts(tx: Tx): Promise<Array<Account & { id: string }>> {
  return tx.select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type }).from(accounts);
}

function toStored(e: NormalizedEntry, accountCode: string | undefined, source: StoredEntry["categorySource"]): StoredEntry {
  return {
    kind: e.kind,
    description: e.description,
    amountIdr: e.amountIdr?.toString() ?? null,
    date: e.date,
    counterparty: e.counterparty,
    paymentMethod: e.paymentMethod,
    items: e.items.map((i) => ({ ...i, unitPriceIdr: i.unitPriceIdr?.toString() ?? null, lineTotalIdr: i.lineTotalIdr?.toString() ?? null })),
    accountCode: accountCode ?? null,
    categorySource: source,
    lowConfidence: e.lowConfidence,
    missing: e.missing,
  };
}

function cardEntries(stored: StoredCapture, accts: Account[]): CardEntry[] {
  const nameByCode = new Map(accts.map((a) => [a.code, a.name]));
  return stored.entries.map((e) => ({
    kind: e.kind,
    description: e.description,
    amountIdr: BigInt(e.amountIdr!),
    date: e.date,
    counterparty: e.counterparty,
    paymentMethod: e.paymentMethod!,
    categoryName:
      e.kind === "sale" ? nameByCode.get(e.accountCode ?? "4100") ?? null
      : e.kind === "expense" ? nameByCode.get(e.accountCode ?? "6900") ?? null
      : null,
    items: e.items.map((i) => ({
      ...i,
      unitPriceIdr: i.unitPriceIdr === null ? null : BigInt(i.unitPriceIdr),
      lineTotalIdr: i.lineTotalIdr === null ? null : BigInt(i.lineTotalIdr),
    })),
    lowConfidence: e.lowConfidence,
  }));
}

/** Decide the next status and reply for a capture whose entries are stored. */
async function advance(tx: Tx, captureId: string, stored: StoredCapture): Promise<OutboundMessage[]> {
  let status: CaptureRow["status"];
  let reply: OutboundMessage;
  if (stored.entries.some((e) => e.missing.includes("amount"))) {
    status = "extracted";
    reply = askAmount();
  } else if (stored.entries.some((e) => e.missing.includes("payment_method"))) {
    status = "extracted";
    const e = stored.entries.find((x) => x.missing.includes("payment_method"))!;
    reply = askPayment(captureId, `${e.description} ${formatRupiah(BigInt(e.amountIdr!))}`);
  } else {
    status = "awaiting_confirmation";
    reply = captureCard(captureId, cardEntries(stored, await loadAccounts(tx)), stored.notes);
  }
  await tx
    .update(captures)
    .set({ status, extractionJson: stored, updatedAt: sql`now()` })
    .where(eq(captures.id, captureId));
  return [reply];
}

export interface NewCapture {
  businessId: string;
  waMessageId: string;
  text: string;
  modelVersion: string;
  routerModelVersion: string;
  raw: RawExtraction;
  entries: NormalizedEntry[];
}

export async function createCapture(tx: Tx, c: NewCapture): Promise<OutboundMessage[]> {
  const supported = c.entries.filter((e) => SUPPORTED_KINDS.has(e.kind));
  const notes: string[] = [];
  if (supported.length < c.entries.length) {
    notes.push("Catatan: utang-piutang dan pindah saldo belum bisa aku catat, segera hadir ya.");
  }

  // A new transaction supersedes any capture still waiting for an answer.
  await tx
    .update(captures)
    .set({ status: "cancelled", updatedAt: sql`now()` })
    .where(and(eq(captures.businessId, c.businessId), eq(captures.status, "extracted")));

  const accts = await loadAccounts(tx);
  const codeById = new Map(accts.map((a) => [a.id, a.code]));
  const rules = (await tx.select().from(categoryRules)).map((r) => ({
    pattern: r.pattern,
    kind: r.kind,
    accountCode: codeById.get(r.accountId)!,
  }));

  const stored: StoredCapture = {
    routerModelVersion: c.routerModelVersion,
    raw: c.raw,
    entries: supported.map((e) => {
      const cat = categorize(e, rules, accts);
      return toStored(e, cat.accountCode, cat.source);
    }),
    notes,
  };
  const confidences = c.raw.entries.flatMap((e) => Object.values(e.confidence));

  const [row] = await tx
    .insert(captures)
    .values({
      businessId: c.businessId,
      waMessageId: c.waMessageId,
      source: "text",
      rawText: c.text,
      extractionJson: stored,
      confidence: confidences.length ? Math.min(...confidences) : null,
      status: supported.length ? "extracted" : "failed",
      modelVersion: c.modelVersion,
    })
    .returning({ id: captures.id });

  if (!supported.length) {
    return [
      {
        kind: "text",
        body: c.entries.length
          ? "Utang-piutang dan pindah saldo belum bisa aku catat, segera hadir ya. Untuk sekarang aku bisa catat penjualan, pengeluaran, modal dan prive."
          : "Maaf, aku belum nangkep transaksinya. Coba tulis seperti ini: \"jual nasi box 25 x 18rb tf BCA\" atau \"belanja ayam 175rb cash\".",
      },
    ];
  }
  return advance(tx, row!.id, stored);
}

/** Latest capture still waiting for an answer, if recent. */
export async function findPendingCapture(tx: Tx): Promise<CaptureRow | undefined> {
  const [row] = await tx
    .select()
    .from(captures)
    .where(and(eq(captures.status, "extracted"), gt(captures.updatedAt, sql`now() - make_interval(mins => ${PENDING_WINDOW_MINUTES})`)))
    .orderBy(desc(captures.updatedAt))
    .limit(1);
  return row;
}

async function lockCapture(tx: Tx, captureId: string): Promise<CaptureRow | undefined> {
  const [row] = await tx.select().from(captures).where(eq(captures.id, captureId)).for("update");
  return row;
}

const ALREADY_DONE: OutboundMessage = { kind: "text", body: "Yang itu sudah diproses sebelumnya ya." };

export async function answerAmount(tx: Tx, captureId: string, amount: bigint): Promise<OutboundMessage[]> {
  const row = await lockCapture(tx, captureId);
  if (!row || row.status !== "extracted") return [ALREADY_DONE];
  const stored = row.extractionJson as StoredCapture;
  const target = stored.entries.find((e) => e.missing.includes("amount"));
  if (target) {
    target.amountIdr = amount.toString();
    target.missing = target.missing.filter((m) => m !== "amount");
  }
  return advance(tx, row.id, stored);
}

export async function answerPayment(tx: Tx, captureId: string, method: string): Promise<OutboundMessage[]> {
  const row = await lockCapture(tx, captureId);
  if (!row || row.status !== "extracted") return [ALREADY_DONE];
  const stored = row.extractionJson as StoredCapture;
  for (const e of stored.entries) {
    if (e.missing.includes("payment_method")) {
      e.paymentMethod = method;
      e.missing = e.missing.filter((m) => m !== "payment_method");
    }
  }
  return advance(tx, row.id, stored);
}

export async function cancelCapture(tx: Tx, captureId: string, mode: "edit" | "cancel"): Promise<OutboundMessage[]> {
  const row = await lockCapture(tx, captureId);
  if (!row || (row.status !== "awaiting_confirmation" && row.status !== "extracted")) return [ALREADY_DONE];
  await tx.update(captures).set({ status: "cancelled", updatedAt: sql`now()` }).where(eq(captures.id, row.id));
  return [
    {
      kind: "text",
      body:
        mode === "edit"
          ? "Oke, kirim lagi versi yang benar ya. Contoh: jual nasi box 25 x 18rb tf BCA"
          : "Oke, dibatalkan. Nggak ada yang dicatat.",
    },
  ];
}

/** The owner pressed OK: post balanced journals, learn categories, reply with today's totals. */
export async function confirmCapture(
  tx: Tx,
  ctx: { businessId: string; userId: string; today: string },
  captureId: string,
): Promise<OutboundMessage[]> {
  const row = await lockCapture(tx, captureId);
  if (!row || row.status !== "awaiting_confirmation") return [ALREADY_DONE];
  const stored = row.extractionJson as StoredCapture;

  let firstJournalId: string | undefined;
  for (const [i, e] of stored.entries.entries()) {
    const draft = buildJournalDraft(ctx.businessId, {
      kind: e.kind as Parameters<typeof buildJournalDraft>[1]["kind"],
      amountIdr: BigInt(e.amountIdr!),
      date: e.date,
      description: e.description,
      source: "text",
      paymentMethod: e.paymentMethod,
      accountCode: e.accountCode ?? undefined,
      counterparty: e.counterparty,
      idempotencyKey: `capture:${row.id}:${i}`,
      createdBy: ctx.userId,
    });
    const posted = await postJournal(tx, draft);
    firstJournalId ??= posted.id;
  }

  // Learn categories the owner just confirmed.
  const accts = await loadAccounts(tx);
  const idByCode = new Map(accts.map((a) => [a.code, a.id]));
  for (const e of stored.entries) {
    if ((e.kind !== "sale" && e.kind !== "expense") || !e.accountCode) continue;
    for (const pattern of patternsFor({ items: e.items.map((it) => ({ ...it, unitPriceIdr: null, lineTotalIdr: null })), description: e.description })) {
      await tx
        .insert(categoryRules)
        .values({ businessId: ctx.businessId, pattern, kind: e.kind, accountId: idByCode.get(e.accountCode)! })
        .onConflictDoUpdate({
          target: [categoryRules.businessId, categoryRules.pattern, categoryRules.kind],
          set: { accountId: idByCode.get(e.accountCode)!, hits: sql`${categoryRules.hits} + 1`, updatedAt: sql`now()` },
        });
    }
  }

  await tx
    .update(captures)
    .set({ status: "confirmed", journalId: firstJournalId, updatedAt: sql`now()` })
    .where(eq(captures.id, row.id));

  const today = await daySummary(tx, ctx.businessId, ctx.today);
  return [
    {
      kind: "text",
      body:
        `Sip, tercatat ✅\n\nHari ini: pemasukan ${formatRupiah(today.incomeIdr)}, ` +
        `pengeluaran ${formatRupiah(today.expenseIdr)}.`,
    },
  ];
}
