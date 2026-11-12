import { eq, sql } from "drizzle-orm";
import { accounts, captures, type Tx } from "@bukuwa/db";
import { formatRupiah } from "@bukuwa/idn";
import { correctedDraft, daySummary, getJournalSummary, LedgerError, postJournal, reverseJournal, type JournalSummary } from "@bukuwa/ledger";
import type { OutboundMessage } from "@bukuwa/wa";
import type { CorrectionProposal } from "../agent/tools.js";
import { shortDate } from "./card.js";

/*
 * Flow D: a correction is a capture of its own. The card shows before and
 * after; on OK the original is reversed (never edited) and, for a change, a
 * corrected copy is posted. Both use idempotency keys tied to the capture.
 */

export interface StoredCorrection {
  type: "correction";
  proposal: CorrectionProposal;
}

const KIND: Record<string, string> = { sale: "Pemasukan", expense: "Pengeluaran", owner_capital: "Tambah modal", owner_drawing: "Prive" };

function line(s: Pick<JournalSummary, "kind" | "amountIdr" | "description" | "date" | "paymentAccount">): string {
  const pay = s.paymentAccount ? ` (${s.paymentAccount})` : "";
  return `${KIND[s.kind] ?? "Transaksi"} ${formatRupiah(s.amountIdr)} · ${s.description} · ${shortDate(s.date)}${pay}`;
}

async function accountName(tx: Tx, code: string | undefined): Promise<string | undefined> {
  if (!code) return undefined;
  const [a] = await tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.code, code));
  return a?.name;
}

export async function createCorrection(
  tx: Tx,
  c: { businessId: string; waMessageId: string; text: string; proposal: CorrectionProposal; summary: JournalSummary; modelVersion: string },
): Promise<OutboundMessage[]> {
  const [row] = await tx
    .insert(captures)
    .values({
      businessId: c.businessId,
      waMessageId: c.waMessageId,
      source: "text",
      rawText: c.text,
      extractionJson: { type: "correction", proposal: c.proposal } satisfies StoredCorrection,
      status: "awaiting_confirmation",
      modelVersion: c.modelVersion,
    })
    .returning({ id: captures.id });

  const p = c.proposal;
  let body: string;
  if (p.action === "cancel") {
    body = `Batalkan transaksi ini?\n${line(c.summary)}\n\nNanti dicatat pembatalannya, catatan lama tetap tersimpan.`;
  } else {
    const changes: string[] = [];
    if (p.amountIdr) changes.push(`nominal jadi *${formatRupiah(BigInt(p.amountIdr))}*`);
    if (p.date) changes.push(`tanggal jadi ${shortDate(p.date)}`);
    if (p.paymentCode) changes.push(`dibayar pakai ${(await accountName(tx, p.paymentCode)) ?? p.paymentCode}`);
    if (p.categoryCode) changes.push(`kategori jadi ${(await accountName(tx, p.categoryCode)) ?? p.categoryCode}`);
    body = `Koreksi transaksi:\n${line(c.summary)}\n➡️ ${changes.join(", ")}\n\nYang lama dibatalkan lalu diganti yang benar.`;
  }
  return [
    {
      kind: "buttons",
      body: `${body}\n\nSudah benar?`,
      buttons: [
        { id: `cap:ok:${row!.id}`, title: "OK" },
        { id: `cap:cancel:${row!.id}`, title: "Batal" },
      ],
    },
  ];
}

/** Post the reversal (and the corrected copy). Caller holds the capture row lock. */
export async function confirmCorrection(
  tx: Tx,
  ctx: { businessId: string; userId: string; today: string },
  captureId: string,
  stored: StoredCorrection,
): Promise<OutboundMessage[]> {
  const p = stored.proposal;
  const original = await getJournalSummary(tx, ctx.businessId, p.journalId);
  if (!original || original.reversed) {
    await tx.update(captures).set({ status: "cancelled", updatedAt: sql`now()` }).where(eq(captures.id, captureId));
    return [{ kind: "text", body: "Transaksi itu sudah dibatalkan sebelumnya, jadi nggak ada yang diubah." }];
  }

  let corrected;
  try {
    corrected =
      p.action === "change"
        ? correctedDraft(ctx.businessId, original, {
            amountIdr: p.amountIdr ? BigInt(p.amountIdr) : undefined,
            date: p.date,
            paymentCode: p.paymentCode,
            categoryCode: p.categoryCode,
          })
        : undefined;
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
    await tx.update(captures).set({ status: "failed", updatedAt: sql`now()` }).where(eq(captures.id, captureId));
    return [{ kind: "text", body: "Koreksi ini nggak bisa aku proses. Batalkan transaksinya lalu catat ulang ya." }];
  }

  const reversal = await reverseJournal(tx, {
    businessId: ctx.businessId,
    journalId: original.id,
    createdBy: ctx.userId,
    idempotencyKey: `capture:${captureId}:rev`,
  });
  const posted = corrected
    ? await postJournal(tx, { ...corrected, idempotencyKey: `capture:${captureId}:0`, createdBy: ctx.userId })
    : undefined;

  await tx
    .update(captures)
    .set({ status: "confirmed", journalId: posted?.id ?? reversal.id, updatedAt: sql`now()` })
    .where(eq(captures.id, captureId));

  const today = await daySummary(tx, ctx.businessId, ctx.today);
  return [
    {
      kind: "text",
      body:
        `${p.action === "cancel" ? "Sip, sudah dibatalkan" : "Sip, sudah dikoreksi"} ✅\n\n` +
        `Hari ini: pemasukan ${formatRupiah(today.incomeIdr)}, pengeluaran ${formatRupiah(today.expenseIdr)}.`,
    },
  ];
}
