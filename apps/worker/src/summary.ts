import { eq } from "drizzle-orm";
import { businesses, decryptPii, dueSummaryBusinesses, messages, summarySchedules, withBusiness, type Tx } from "@bukuwa/db";
import {
  formatRupiah,
  localDateTime,
  nextSummaryRun,
  summaryPeriod,
  type SummaryRequest,
  type SummarySchedule,
} from "@bukuwa/idn";
import { cashPosition, openBalances, profitAndLoss, topSales } from "@bukuwa/ledger";
import { messageLogBody, renderTemplate, SUMMARY_TEMPLATE, type OutboundMessage } from "@bukuwa/wa";
import type { InboundDeps } from "./inbound.js";

/*
 * Daily / weekly summary (F9). The owner sets it in chat; a scheduler tick
 * (every minute) sends it as the approved WhatsApp template, since it usually
 * arrives outside the 24-hour customer-service window. All numbers come from
 * ledger queries.
 */

/** A summary more than this late (worker was down) is skipped rather than sent at an odd hour. */
const MAX_LATE_MS = 6 * 3_600_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const ZONE: Record<string, string> = { "Asia/Jakarta": "WIB", "Asia/Pontianak": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" };

const day = (iso: string) => Number(iso.slice(8, 10));
const month = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1]!;

/** "12 Nov", "6–12 Nov", "28 Okt–3 Nov". */
export function periodLabel(from: string, to: string): string {
  if (from === to) return `${day(to)} ${month(to)}`;
  return month(from) === month(to) ? `${day(from)}–${day(to)} ${month(to)}` : `${day(from)} ${month(from)}–${day(to)} ${month(to)}`;
}

/** The template parameters, in SUMMARY_TEMPLATE order. Caller holds the business scope. */
export async function summaryParams(tx: Tx, businessId: string, businessName: string, period: { from: string; to: string }): Promise<string[]> {
  const pl = await profitAndLoss(tx, businessId, period);
  const cash = await cashPosition(tx, businessId, period.to);
  const top = await topSales(tx, businessId, period, 3);
  const owed = (await openBalances(tx, businessId, { kind: "receivable", asOf: period.to })).filter((b) => b.balanceIdr > 0n);
  const owedTotal = owed.reduce((s, b) => s + b.balanceIdr, 0n);
  return [
    periodLabel(period.from, period.to),
    businessName,
    formatRupiah(pl.incomeIdr),
    formatRupiah(pl.expenseIdr),
    pl.profitIdr >= 0n ? `untung ${formatRupiah(pl.profitIdr)}` : `rugi ${formatRupiah(-pl.profitIdr)}`,
    formatRupiah(cash.totalIdr),
    top.length ? top.map((t) => `${t.description} (${formatRupiah(t.amountIdr)})`).join(", ") : "belum ada penjualan",
    owed.length ? `${formatRupiah(owedTotal)} dari ${owed.length} pelanggan` : "tidak ada",
  ];
}

function describeSchedule(s: SummarySchedule, timezone: string): string {
  const at = `jam ${s.time.replace(":", ".")} ${ZONE[timezone] ?? ""}`.trim();
  return s.frequency === "daily" ? `Ringkasan harian aku kirim tiap hari ${at}` : `Ringkasan mingguan aku kirim tiap ${DAYS[s.weekday!]} ${at}`;
}

/** The owner asked to set, stop, or see a summary. Runs in the inbound transaction. */
export async function handleSummaryRequest(
  tx: Tx,
  ctx: { businessId: string; businessName: string; today: string; timezone: string; now: Date },
  req: SummaryRequest,
): Promise<OutboundMessage[]> {
  if (req.action === "now") {
    const params = await summaryParams(tx, ctx.businessId, ctx.businessName, { from: ctx.today, to: ctx.today });
    // The owner just wrote, so a normal message is allowed; same text as the template.
    return [{ kind: "text", body: renderTemplate({ kind: "template", name: SUMMARY_TEMPLATE.name, language: SUMMARY_TEMPLATE.language, params }) }];
  }
  if (req.action === "off") {
    const updated = await tx.update(summarySchedules).set({ enabled: false, updatedAt: ctx.now }).returning({ b: summarySchedules.businessId });
    return [
      {
        kind: "text",
        body: updated.length
          ? 'Oke, ringkasan otomatis dimatikan. Ketik "ringkasan harian jam 9 malam" kalau mau nyalain lagi.'
          : "Ringkasan otomatis memang belum aktif kok.",
      },
    ];
  }
  if (!req.time) {
    return [
      {
        kind: "text",
        body: 'Mau dikirim jam berapa? Contoh: "ringkasan harian jam 9 malam" atau "ringkasan mingguan tiap senin jam 8 pagi".',
      },
    ];
  }
  const s: SummarySchedule = { frequency: req.frequency, time: req.time, weekday: req.weekday };
  const nextRunAt = nextSummaryRun(s, ctx.timezone, ctx.now);
  const values = { frequency: s.frequency, localTime: s.time, weekday: s.weekday, enabled: true, nextRunAt, updatedAt: ctx.now };
  await tx
    .insert(summarySchedules)
    .values({ businessId: ctx.businessId, ...values })
    .onConflictDoUpdate({ target: summarySchedules.businessId, set: values });
  const first = localDateTime(nextRunAt, ctx.timezone).date;
  return [
    {
      kind: "text",
      body:
        `Siap! ${describeSchedule(s, ctx.timezone)}, mulai ${day(first)} ${month(first)}. ` +
        `Isinya pemasukan, pengeluaran, laba, saldo, produk paling laku dan piutang.\n\n` +
        'Ketik "stop ringkasan" kalau mau berhenti, atau "rekap" untuk lihat ringkasan hari ini sekarang.',
    },
  ];
}

/**
 * One scheduler tick: send every due summary. Each business is handled in its
 * own scope; the schedule row is locked and moved forward before sending, so
 * a summary goes out at most once per period even with overlapping ticks.
 */
export async function runDueSummaries(
  deps: Pick<InboundDeps, "db" | "sender" | "keys" | "log">,
  now: Date,
): Promise<{ sent: number; skipped: number }> {
  const log = deps.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify(e)));
  let sent = 0;
  let skipped = 0;
  for (const businessId of await dueSummaryBusinesses(deps.db, now)) {
    const out = await withBusiness(deps.db, businessId, async (tx) => {
      const [s] = await tx.select().from(summarySchedules).for("update", { skipLocked: true });
      if (!s || !s.enabled || s.nextRunAt > now) return undefined;
      const [b] = await tx.select().from(businesses);
      const schedule: SummarySchedule = { frequency: s.frequency, time: s.localTime, weekday: s.weekday };
      // The period follows the scheduled time, not the (possibly late) tick.
      const at = localDateTime(s.nextRunAt, b!.timezone);
      const period = summaryPeriod(s.frequency, at.date, s.localTime);
      const late = now.getTime() - s.nextRunAt.getTime() > MAX_LATE_MS;
      const repeat = s.lastPeriodKey === period.key;
      await tx
        .update(summarySchedules)
        .set({
          nextRunAt: nextSummaryRun(schedule, b!.timezone, now),
          ...(late || repeat ? {} : { lastPeriodKey: period.key, lastSentAt: now }),
          updatedAt: now,
        })
        .where(eq(summarySchedules.businessId, businessId));
      if (late || repeat) return { skip: late ? "late" : "repeat", period: period.key };

      const msg: OutboundMessage = {
        kind: "template",
        name: SUMMARY_TEMPLATE.name,
        language: SUMMARY_TEMPLATE.language,
        params: await summaryParams(tx, businessId, b!.name, period),
      };
      await tx.insert(messages).values({ businessId, direction: "outbound", type: "template", body: messageLogBody(msg), templateName: msg.name });
      return { msg, phone: decryptPii(deps.keys, b!.ownerPhoneEnc), period: period.key };
    });
    if (!out) continue;
    if ("skip" in out) {
      if (out.skip === "late") skipped++;
      log({ level: "warn", event: `summary.skipped_${out.skip}`, businessId, period: out.period });
      continue;
    }
    try {
      await deps.sender.send(out.phone, out.msg);
      sent++;
      log({ level: "info", event: "summary.sent", businessId, period: out.period });
    } catch (err) {
      log({ level: "error", event: "summary.send_failed", businessId, period: out.period, error: (err as Error).message });
    }
  }
  return { sent, skipped };
}
