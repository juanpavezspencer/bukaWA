import { eq } from "drizzle-orm";
import { businesses, decryptPii, dueTaxNoticeBusinesses, messages, taxNoticeSchedules, withBusiness, type Tx } from "@bukuwa/db";
import { localDateTime, nextMonthlyRun, type TaxRequest } from "@bukuwa/idn";
import {
  dateLabel,
  formatRate,
  generateMonthlyReport,
  monthLabel,
  rp,
  TAX_DISCLAIMER,
  taxEstimateFor,
  type LinkSigner,
  type ReportFormat,
  type TaxEstimateResult,
} from "@bukuwa/reports";
import { monthOf, previousMonth, TaxError } from "@bukuwa/tax";
import { messageLogBody, TAX_NOTICE_TEMPLATE, type OutboundMessage } from "@bukuwa/wa";
import type { InboundDeps } from "./inbound.js";

/*
 * F10 / Flow E in chat: tax estimate replies, monthly report links, and the
 * month-end tax notice. All numbers come from @bukuwa/reports (ledger + tax
 * rules); nothing here does tax arithmetic.
 */

export interface TaxDeps {
  /** Regime for businesses without their own tax profile (config). */
  defaultRegime: string;
  /** Local "HH:MM" on the 1st when the month-end notice goes out (config). */
  noticeLocalTime: string;
  links: LinkSigner;
  /** Shown to the owner so they know when to ask again. */
  reportLinkTtlMinutes: number;
}

/** A notice more than this late (worker down for days) is skipped; the owner can still ask. */
const MAX_LATE_MS = 3 * 86_400_000;

const REPORT_REPLY = /^report:(\d{4}-(?:0[1-9]|1[0-2])):(pdf|xlsx)$/;

/** Button / template quick-reply ids "report:2026-10:pdf". */
export function parseReportReply(id: string | undefined): { month: string; format: ReportFormat } | null {
  const m = id ? REPORT_REPLY.exec(id) : null;
  return m ? { month: m[1]!, format: m[2] as ReportFormat } : null;
}

const reportButtons = (month: string) => [
  { id: `report:${month}:pdf`, title: "Laporan PDF" },
  { id: `report:${month}:xlsx`, title: "Laporan Excel" },
];

/** Unspecified month = last month: the one whose tax is due now. */
export const defaultMonth = (today: string) => previousMonth(monthOf(today));

function exemptLine(t: TaxEstimateResult): string | null {
  if (t.exemptThresholdIdr === 0n) return null;
  if (t.taxIdr === 0n) return `Masih dalam batas bebas pajak ${rp(t.exemptThresholdIdr)} setahun, sisa ${rp(t.exemptRemainingIdr)}.`;
  if (t.exemptUsedThisMonthIdr > 0n) return `Batas bebas pajak ${rp(t.exemptThresholdIdr)} setahun habis di bulan ini, jadi yang kena pajak ${rp(t.taxableTurnoverIdr)}.`;
  return `Batas bebas pajak ${rp(t.exemptThresholdIdr)} setahun sudah terpakai semua.`;
}

const CAP_WARNING = "Omzet tahun ini sudah lewat batas aturan ini, cek ke konsultan pajak aturan mana yang berlaku ya.";

export function estimateReply(t: TaxEstimateResult): OutboundMessage {
  const lines = [
    `Perkiraan pajak *${monthLabel(t.month)}*${t.partial ? ` (s/d ${dateLabel(t.period.to)})` : ""} 🧾`,
    `• Omzet: ${rp(t.turnoverIdr)}`,
    `• Omzet sejak Januari: ${rp(t.ytdTurnoverIdr)}`,
    `• Kena pajak: ${rp(t.taxableTurnoverIdr)} × ${formatRate(t.rateBps)}`,
    `• Pajak: *${rp(t.taxIdr)}*, bayar paling lambat ${dateLabel(t.dueDate)}`,
    exemptLine(t),
    t.partial ? "Bulannya belum selesai, jadi angkanya masih bisa nambah." : null,
    t.overTurnoverCap ? CAP_WARNING : null,
    "",
    `_${TAX_DISCLAIMER}_`,
  ].filter((l): l is string => l !== null);
  return { kind: "buttons", body: lines.join("\n"), buttons: reportButtons(t.month) };
}

/** Params for TAX_NOTICE_TEMPLATE, in order. */
export function noticeParams(t: TaxEstimateResult, businessName: string): string[] {
  const note = [exemptLine(t) ?? `Pajak ${formatRate(t.rateBps)} dari omzet ${rp(t.taxableTurnoverIdr)}.`, t.overTurnoverCap ? CAP_WARNING : null].filter(Boolean).join(" ");
  return [monthLabel(t.month), businessName, rp(t.turnoverIdr), rp(t.ytdTurnoverIdr), rp(t.taxIdr), dateLabel(t.dueDate), note];
}

const NOT_STARTED = (month: string): OutboundMessage => ({ kind: "text", body: `${monthLabel(month)} belum mulai, jadi belum ada yang bisa dihitung 🙂` });

interface Ctx {
  businessId: string;
  userId: string;
  today: string;
  now: Date;
}

export async function reportReply(tx: Tx, ctx: Ctx, tax: TaxDeps, month: string, format: ReportFormat): Promise<OutboundMessage[]> {
  let g;
  try {
    g = await generateMonthlyReport(tx, ctx.businessId, {
      month,
      format,
      today: ctx.today,
      now: ctx.now,
      actor: ctx.userId,
      createdBy: ctx.userId,
      defaultRegime: tax.defaultRegime,
      evidenceUrl: (captureId) => tax.links.evidenceUrl(ctx.businessId, captureId, ctx.now),
    });
  } catch (err) {
    if (err instanceof TaxError && err.code === "INVALID_MONTH") return [NOT_STARTED(month)];
    throw err;
  }
  const url = tax.links.reportUrl(ctx.businessId, g.reportId, ctx.now);
  const label = format === "pdf" ? "PDF" : "Excel";
  return [
    {
      kind: "text",
      body:
        `Laporan ${monthLabel(month)}${g.report.partial ? ` (s/d ${dateLabel(g.report.period.to)})` : ""} versi ${label} sudah siap 📄\n${url}\n\n` +
        `Link berlaku ${tax.reportLinkTtlMinutes} menit. Isinya ringkasan laba rugi, perkiraan pajak, daftar penjualan dengan buktinya, dan piutang/utang.\n` +
        `Kalau link-nya sudah mati, ketik "laporan ${monthLabel(month).toLowerCase()}" lagi ya.`,
    },
  ];
}

export async function handleTaxRequest(tx: Tx, ctx: Ctx & { timezone: string }, tax: TaxDeps, req: TaxRequest): Promise<OutboundMessage[]> {
  if (req.action === "notice") {
    await ensureTaxNoticeSchedule(tx, ctx.businessId, ctx.timezone, ctx.now, tax.noticeLocalTime);
    await tx
      .update(taxNoticeSchedules)
      .set({ enabled: req.enabled, nextRunAt: nextMonthlyRun(ctx.timezone, ctx.now, tax.noticeLocalTime), updatedAt: ctx.now })
      .where(eq(taxNoticeSchedules.businessId, ctx.businessId));
    return [
      {
        kind: "text",
        body: req.enabled
          ? `Siap, tiap tanggal 1 aku kirim perkiraan pajak bulan sebelumnya, jam ${tax.noticeLocalTime.replace(":", ".")}.`
          : 'Oke, pengingat pajak bulanan dimatikan. Kamu tetap bisa tanya kapan aja, misalnya "pajak bulan lalu berapa?"',
      },
    ];
  }
  const month = req.month ?? defaultMonth(ctx.today);
  if (req.action === "report") return reportReply(tx, ctx, tax, month, req.format);
  try {
    return [estimateReply(await taxEstimateFor(tx, ctx.businessId, { month, today: ctx.today, defaultRegime: tax.defaultRegime }))];
  } catch (err) {
    if (err instanceof TaxError && err.code === "INVALID_MONTH") return [NOT_STARTED(month)];
    throw err;
  }
}

/** Every business gets the month-end notice unless the owner turns it off. Idempotent. */
export async function ensureTaxNoticeSchedule(tx: Tx, businessId: string, timezone: string, now: Date, localTime: string): Promise<void> {
  await tx
    .insert(taxNoticeSchedules)
    .values({ businessId, nextRunAt: nextMonthlyRun(timezone, now, localTime) })
    .onConflictDoNothing({ target: taxNoticeSchedules.businessId });
}

/**
 * One scheduler tick: on the 1st, send last month's estimate as the approved
 * template with a "Lihat laporan" button. Same once-per-period locking as the
 * summaries. Months with no turnover and no tax are skipped quietly.
 */
export async function runDueTaxNotices(
  deps: Pick<InboundDeps, "db" | "sender" | "keys" | "log"> & { tax: TaxDeps },
  now: Date,
): Promise<{ sent: number; skipped: number }> {
  const log = deps.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify(e)));
  let sent = 0;
  let skipped = 0;
  for (const businessId of await dueTaxNoticeBusinesses(deps.db, now)) {
    const out = await withBusiness(deps.db, businessId, async (tx) => {
      const [s] = await tx.select().from(taxNoticeSchedules).for("update", { skipLocked: true });
      if (!s || !s.enabled || s.nextRunAt > now) return undefined;
      const [b] = await tx.select().from(businesses);
      // The month follows the scheduled run, not a late tick.
      const runDate = localDateTime(s.nextRunAt, b!.timezone).date;
      const month = previousMonth(monthOf(runDate));
      const late = now.getTime() - s.nextRunAt.getTime() > MAX_LATE_MS;
      const repeat = s.lastPeriod === month;
      const t = late || repeat ? undefined : await taxEstimateFor(tx, businessId, { month, today: localDateTime(now, b!.timezone).date, defaultRegime: deps.tax.defaultRegime });
      const empty = t !== undefined && t.turnoverIdr <= 0n && t.taxIdr === 0n;
      await tx
        .update(taxNoticeSchedules)
        .set({
          nextRunAt: nextMonthlyRun(b!.timezone, now, deps.tax.noticeLocalTime),
          ...(late || repeat ? {} : { lastPeriod: month, ...(empty ? {} : { lastSentAt: now }) }),
          updatedAt: now,
        })
        .where(eq(taxNoticeSchedules.businessId, businessId));
      if (!t || empty) return { skip: late ? "late" : repeat ? "repeat" : "empty", month };

      const msg: OutboundMessage = {
        kind: "template",
        name: TAX_NOTICE_TEMPLATE.name,
        language: TAX_NOTICE_TEMPLATE.language,
        params: noticeParams(t, b!.name),
        buttonPayloads: [`report:${month}:pdf`],
      };
      await tx.insert(messages).values({ businessId, direction: "outbound", type: "template", body: messageLogBody(msg), templateName: msg.name });
      return { msg, phone: decryptPii(deps.keys, b!.ownerPhoneEnc), month };
    });
    if (!out) continue;
    if ("skip" in out) {
      if (out.skip === "late") skipped++;
      log({ level: out.skip === "late" ? "warn" : "info", event: `tax_notice.skipped_${out.skip}`, businessId, month: out.month });
      continue;
    }
    try {
      await deps.sender.send(out.phone, out.msg);
      sent++;
      log({ level: "info", event: "tax_notice.sent", businessId, month: out.month });
    } catch (err) {
      log({ level: "error", event: "tax_notice.send_failed", businessId, month: out.month, error: (err as Error).message });
    }
  }
  return { sent, skipped };
}
