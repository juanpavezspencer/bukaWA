import { and, desc, eq, gt, sql } from "drizzle-orm";
import { accounts, captures, categoryRules, rows, type Tx } from "@bukuwa/db";
import { categorize, categorizeItems, normalizePattern, patternsFor, type Account, type NormalizedEntry, type RawExtraction } from "@bukuwa/ai";
import { formatRupiah } from "@bukuwa/idn";
import { buildJournalDraft, daySummary, findOrCreateContact, postJournal, type OpenItemKind } from "@bukuwa/ledger";
import type { OutboundMessage } from "@bukuwa/wa";
import { askAmount, askCounterparty, askPayment, askSettles, captureCard, settleOfferCard, type CardEntry } from "./card.js";
import { balanceAfter, contactKindFor, DEBT_KINDS, debtNotes, resolveDebt, type DebtFields, type Missing } from "./debts.js";
import { confirmCorrection, type StoredCorrection } from "./correction.js";

/*
 * Capture lifecycle (F2, F5, F6, F8):
 *   extracted              -> waiting for a missing amount, name, debt side or payment method
 *   awaiting_confirmation  -> confirm card sent (OK / Ubah / Batal)
 *   confirmed              -> journals posted
 *   cancelled              -> owner cancelled or edited, or superseded
 * Nothing reaches the ledger except through confirmCapture().
 */

const SUPPORTED_KINDS = new Set(["sale", "expense", "owner_capital", "owner_drawing", "receivable", "payable", "settlement"]);
/** A capture waiting for an answer is only matched to replies within this window. */
const PENDING_WINDOW_MINUTES = 30;

export interface StoredEntry extends DebtFields {
  kind: string;
  description: string;
  amountIdr: string | null;
  date: string;
  counterparty: string | null;
  paymentMethod: string | null;
  items: Array<{
    name: string;
    qtyText: string | null;
    unit: string | null;
    unitPriceIdr: string | null;
    lineTotalIdr: string | null;
    /** Set only when the entry is split across categories. */
    accountCode?: string | null;
  }>;
  accountCode: string | null;
  categorySource: "rule" | "model" | "default";
  lowConfidence: NormalizedEntry["lowConfidence"];
  missing: Missing[];
}

export interface StoredCapture {
  /** Text router version; null for photos (no routing). */
  routerModelVersion: string | null;
  /** Photos: what the vision model read (masked). */
  documentType?: string;
  visibleText?: string;
  raw: RawExtraction;
  entries: StoredEntry[];
  notes: string[];
}

type CaptureRow = typeof captures.$inferSelect;

async function loadAccounts(tx: Tx): Promise<Array<Account & { id: string }>> {
  return tx.select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type }).from(accounts);
}

const DEFAULT_CATEGORY: Record<string, string> = { sale: "4100", expense: "6900", receivable: "4100", payable: "6900" };
/** Credit sales and purchases are categorized like the sale or expense they are. */
const CATEGORY_KIND: Record<string, string> = { receivable: "sale", payable: "expense" };

function toStored(
  e: NormalizedEntry,
  accountCode: string | undefined,
  source: StoredEntry["categorySource"],
  itemCodes: string[] | null,
): StoredEntry {
  return {
    kind: e.kind,
    description: e.description,
    amountIdr: e.amountIdr?.toString() ?? null,
    date: e.date,
    counterparty: e.counterparty,
    paymentMethod: e.paymentMethod,
    items: e.items.map((i, n) => ({
      ...i,
      unitPriceIdr: i.unitPriceIdr?.toString() ?? null,
      lineTotalIdr: i.lineTotalIdr?.toString() ?? null,
      ...(itemCodes ? { accountCode: itemCodes[n]! } : {}),
    })),
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
    counterparty: e.contactName ?? e.counterparty,
    paymentMethod: e.paymentMethod,
    settles: e.settles ?? null,
    categoryName: DEFAULT_CATEGORY[e.kind] ? nameByCode.get(e.accountCode ?? DEFAULT_CATEGORY[e.kind]!) ?? null : null,
    notes: debtNotes(e),
    items: e.items.map((i) => ({
      name: i.name,
      qtyText: i.qtyText,
      unit: i.unit,
      unitPriceIdr: i.unitPriceIdr === null ? null : BigInt(i.unitPriceIdr),
      lineTotalIdr: i.lineTotalIdr === null ? null : BigInt(i.lineTotalIdr),
      categoryName: splitsFor(e) && i.accountCode ? nameByCode.get(i.accountCode) ?? null : null,
    })),
    lowConfidence: e.lowConfidence,
  }));
}

/** Category splits for posting, only if still exact (the owner may have typed a different amount). */
function splitsFor(e: StoredEntry): Array<{ accountCode: string; amountIdr: bigint }> | undefined {
  if (e.amountIdr === null || e.items.length < 2 || !e.items.every((i) => i.accountCode && i.lineTotalIdr !== null)) return undefined;
  const splits = e.items.map((i) => ({ accountCode: i.accountCode!, amountIdr: BigInt(i.lineTotalIdr!) }));
  return splits.reduce((s, x) => s + x.amountIdr, 0n) === BigInt(e.amountIdr) ? splits : undefined;
}

async function currentBusinessId(tx: Tx): Promise<string> {
  return rows<{ id: string }>(await tx.execute(sql`select app_current_business_id()::text as id`))[0]!.id;
}

/** Decide the next status and reply for a capture whose entries are stored. */
async function advance(tx: Tx, captureId: string, stored: StoredCapture): Promise<OutboundMessage[]> {
  const businessId = await currentBusinessId(tx);
  for (const e of stored.entries) await resolveDebt(tx, businessId, e);
  const first = (m: Missing) => stored.entries.find((e) => e.missing.includes(m));

  let status: CaptureRow["status"] = "extracted";
  let reply: OutboundMessage;
  if (first("amount")) {
    reply = askAmount();
  } else if (first("counterparty")) {
    const e = first("counterparty")!;
    reply = askCounterparty(e.kind, formatRupiah(BigInt(e.amountIdr!)));
  } else if (first("settles")) {
    const e = first("settles")!;
    reply = askSettles(captureId, e.counterparty!, formatRupiah(BigInt(e.amountIdr!)));
  } else if (first("payment_method")) {
    const e = first("payment_method")!;
    reply = askPayment(captureId, `${e.description} ${formatRupiah(BigInt(e.amountIdr!))}`);
  } else {
    status = "awaiting_confirmation";
    const cards = cardEntries(stored, await loadAccounts(tx));
    const only = stored.entries.length === 1 ? stored.entries[0]! : undefined;
    reply = only?.offer
      ? settleOfferCard(captureId, cards[0]!, { ...only.offer, name: only.contactName! })
      : captureCard(captureId, cards, stored.notes);
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
  source: "text" | "photo" | "voice";
  /** Typed text, or the photo caption. */
  text: string | null;
  mediaUrl?: string;
  /** Voice: the (masked) transcript. */
  transcript?: string;
  /** Photos: document type and masked transcription, kept for review and evals. */
  document?: { type: string; visibleText: string };
  modelVersion: string;
  routerModelVersion: string | null;
  raw: RawExtraction;
  entries: NormalizedEntry[];
}

export async function createCapture(tx: Tx, c: NewCapture): Promise<OutboundMessage[]> {
  const supported = c.entries.filter((e) => SUPPORTED_KINDS.has(e.kind));
  const notes: string[] = [];
  if (supported.length < c.entries.length) {
    notes.push("Catatan: pindah saldo antar rekening belum bisa aku catat, segera hadir ya.");
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
    ...(c.document ? { documentType: c.document.type, visibleText: c.document.visibleText } : {}),
    raw: c.raw,
    entries: supported.map((e) => {
      if (e.kind === "settlement") return toStored(e, undefined, "default", null);
      if (CATEGORY_KIND[e.kind]) {
        // No item splits on credit: one category for the whole debt.
        const cat = categorize({ ...e, kind: CATEGORY_KIND[e.kind] as NormalizedEntry["kind"] }, rules, accts);
        return toStored(e, cat.accountCode, cat.source, null);
      }
      const cat = categorize(e, rules, accts);
      // Items without their own rule take the model's suggestion (or the default),
      // not a rule that matched some other item on the same receipt.
      const fallback = categorize(e, [], accts).accountCode ?? DEFAULT_CATEGORY[e.kind];
      const itemCodes = fallback ? categorizeItems(e, fallback, rules, accts) : null;
      return toStored(e, cat.accountCode, cat.source, itemCodes);
    }),
    notes,
  };
  const confidences = c.raw.entries.flatMap((e) => Object.values(e.confidence));

  const [row] = await tx
    .insert(captures)
    .values({
      businessId: c.businessId,
      waMessageId: c.waMessageId,
      source: c.source,
      rawText: c.text,
      mediaUrl: c.mediaUrl ?? null,
      transcript: c.transcript ?? null,
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
          ? "Pindah saldo antar rekening belum bisa aku catat, segera hadir ya. Untuk sekarang aku bisa catat penjualan, pengeluaran, utang-piutang, modal dan prive."
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

export async function answerCounterparty(tx: Tx, captureId: string, name: string): Promise<OutboundMessage[]> {
  const row = await lockCapture(tx, captureId);
  if (!row || row.status !== "extracted") return [ALREADY_DONE];
  const stored = row.extractionJson as StoredCapture;
  for (const e of stored.entries) if (e.missing.includes("counterparty")) e.counterparty = name;
  return advance(tx, row.id, stored);
}

export async function answerSettles(tx: Tx, captureId: string, settles: OpenItemKind): Promise<OutboundMessage[]> {
  const row = await lockCapture(tx, captureId);
  if (!row || row.status !== "extracted") return [ALREADY_DONE];
  const stored = row.extractionJson as StoredCapture;
  for (const e of stored.entries) if (e.missing.includes("settles")) e.settles = settles;
  return advance(tx, row.id, stored);
}

/**
 * "Ya, pelunasan" on a sale/expense from a contact with an open debt: the card
 * showed the amount, the contact and the debt, so this is the owner's
 * confirmation of the entry as that debt's payment.
 */
export async function confirmAsSettlement(
  tx: Tx,
  ctx: { businessId: string; userId: string; today: string },
  captureId: string,
): Promise<OutboundMessage[]> {
  const row = await lockCapture(tx, captureId);
  if (!row || row.status !== "awaiting_confirmation") return [ALREADY_DONE];
  const stored = row.extractionJson as StoredCapture;
  const e = stored.entries[0];
  if (stored.entries.length !== 1 || !e?.offer) return [ALREADY_DONE];
  Object.assign(e, {
    kind: "settlement",
    settles: e.offer.settles,
    counterparty: e.contactName ?? e.counterparty,
    accountCode: null,
    items: e.items.map((i) => ({ ...i, accountCode: null })),
    offer: null,
  });
  await tx.update(captures).set({ extractionJson: stored }).where(eq(captures.id, row.id));
  return confirmCapture(tx, ctx, captureId);
}

export async function cancelCapture(tx: Tx, captureId: string, mode: "edit" | "cancel"): Promise<OutboundMessage[]> {
  const row = await lockCapture(tx, captureId);
  if (!row || (row.status !== "awaiting_confirmation" && row.status !== "extracted")) return [ALREADY_DONE];
  await tx.update(captures).set({ status: "cancelled", updatedAt: sql`now()` }).where(eq(captures.id, row.id));
  if ((row.extractionJson as { type?: string }).type === "correction") {
    return [{ kind: "text", body: "Oke, nggak jadi. Catatannya tetap seperti semula." }];
  }
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
  if ((row.extractionJson as { type?: string }).type === "correction") {
    return confirmCorrection(tx, ctx, row.id, row.extractionJson as StoredCorrection);
  }
  const stored = row.extractionJson as StoredCapture;

  let firstJournalId: string | undefined;
  const balanceLines: string[] = [];
  for (const [i, e] of stored.entries.entries()) {
    const contactId = e.counterparty?.trim()
      ? await findOrCreateContact(tx, ctx.businessId, e.counterparty, contactKindFor(e.kind, e.settles))
      : undefined;
    const draft = buildJournalDraft(ctx.businessId, {
      kind: e.kind as Parameters<typeof buildJournalDraft>[1]["kind"],
      contactId,
      settles: e.settles ?? undefined,
      amountIdr: BigInt(e.amountIdr!),
      date: e.date,
      description: e.description,
      source: row.source,
      paymentMethod: e.paymentMethod,
      accountCode: e.accountCode ?? undefined,
      splits: splitsFor(e),
      counterparty: e.counterparty,
      idempotencyKey: `capture:${row.id}:${i}`,
      createdBy: ctx.userId,
    });
    const posted = await postJournal(tx, draft);
    firstJournalId ??= posted.id;
    const debtKind = e.kind === "settlement" ? e.settles : e.kind === "receivable" || e.kind === "payable" ? e.kind : null;
    if (contactId && debtKind) balanceLines.push(await balanceAfter(tx, ctx.businessId, contactId, debtKind, e.contactName ?? e.counterparty!));
  }

  // Learn categories the owner just confirmed.
  const accts = await loadAccounts(tx);
  const idByCode = new Map(accts.map((a) => [a.code, a.id]));
  for (const e of stored.entries) {
    if (e.kind !== "sale" && e.kind !== "expense") continue;
    const split = splitsFor(e) !== undefined;
    // Learn from split items individually; otherwise only an explicit entry category is worth a rule.
    const learn: Array<{ text: string; code: string }> = split
      ? e.items.map((i) => ({ text: i.name, code: i.accountCode! }))
      : e.accountCode
        ? patternsFor({ items: e.items.map((it) => ({ ...it, unitPriceIdr: null, lineTotalIdr: null })), description: e.description }).map(
            (p) => ({ text: p, code: e.accountCode! }),
          )
        : [];
    for (const { text, code } of learn) {
      const pattern = split ? normalizePattern(text) : text;
      const accountId = idByCode.get(code);
      if (!pattern || !accountId) continue;
      await tx
        .insert(categoryRules)
        .values({ businessId: ctx.businessId, pattern, kind: e.kind, accountId })
        .onConflictDoUpdate({
          target: [categoryRules.businessId, categoryRules.pattern, categoryRules.kind],
          set: { accountId, hits: sql`${categoryRules.hits} + 1`, updatedAt: sql`now()` },
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
        `Sip, tercatat ✅\n\n${balanceLines.map((l) => `${l}\n`).join("")}` +
        `Hari ini: pemasukan ${formatRupiah(today.incomeIdr)}, pengeluaran ${formatRupiah(today.expenseIdr)}.`,
    },
  ];
}
