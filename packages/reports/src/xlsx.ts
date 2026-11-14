import ExcelJS from "exceljs";
import type { ContactBalance } from "@bukuwa/ledger";
import { dateLabel, EVIDENCE_LABEL, formatRate, monthLabel, TAX_DISCLAIMER } from "./format.js";
import type { MonthlyReport, ReportLine } from "./monthly.js";

/*
 * Monthly report as Excel (exceljs, spec 5). Amounts are whole-rupiah numbers
 * so owners and accountants can sum them; every one is an exact integer
 * (checked), never a fraction.
 */

const RUPIAH = '"Rp" #,##0;[Red]-"Rp" #,##0';

function idr(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`amount too large for a spreadsheet cell: ${n}`);
  return Number(n);
}

/** Calendar date as an Excel date (midnight UTC, shown without time). */
const excelDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

function entriesSheet(wb: ExcelJS.Workbook, name: string, lines: ReportLine[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Tanggal", key: "date", width: 12, style: { numFmt: "dd/mm/yyyy" } },
    { header: "Keterangan", key: "description", width: 36 },
    { header: "Pelanggan / supplier", key: "counterparty", width: 22 },
    { header: "Kategori", key: "category", width: 24 },
    { header: "Dibayar", key: "paidWith", width: 14 },
    { header: "Jumlah", key: "amount", width: 16, style: { numFmt: RUPIAH } },
    { header: "Bukti", key: "evidence", width: 14 },
    { header: "Ref", key: "ref", width: 38 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const l of lines) {
    const row = ws.addRow({
      date: excelDate(l.date),
      description: l.description,
      counterparty: l.counterparty ?? "",
      category: l.category ?? "",
      paidWith: l.paidWith ?? "",
      amount: idr(l.amountIdr),
      evidence: l.evidence ? EVIDENCE_LABEL[l.evidence.source] : "",
      ref: l.journalId,
    });
    if (l.evidence?.url) {
      row.getCell("evidence").value = { text: EVIDENCE_LABEL[l.evidence.source], hyperlink: l.evidence.url };
      row.getCell("evidence").font = { color: { argb: "FF0B69A3" }, underline: true };
    }
  }
  const total = ws.addRow({ description: "Total", amount: idr(lines.reduce((s, l) => s + l.amountIdr, 0n)) });
  total.font = { bold: true };
  return ws;
}

function balancesSheet(wb: ExcelJS.Workbook, receivables: ContactBalance[], payables: ContactBalance[], asOf: string) {
  const ws = wb.addWorksheet("Piutang & Utang");
  ws.columns = [
    { header: "Jenis", key: "kind", width: 26 },
    { header: "Nama", key: "name", width: 28 },
    { header: "Belum lunas sejak", key: "since", width: 18, style: { numFmt: "dd/mm/yyyy" } },
    { header: `Sisa per ${dateLabel(asOf)}`, key: "balance", width: 18, style: { numFmt: RUPIAH } },
  ];
  ws.getRow(1).font = { bold: true };
  for (const [label, list] of [["Piutang (pelanggan)", receivables], ["Utang (ke supplier)", payables]] as const) {
    for (const c of list) ws.addRow({ kind: label, name: c.name, since: c.oldestOpenDate ? excelDate(c.oldestOpenDate) : "", balance: idr(c.balanceIdr) });
  }
}

export async function renderReportXlsx(r: MonthlyReport): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "BukuWA";
  wb.created = r.generatedAt;

  const sum = wb.addWorksheet("Ringkasan");
  sum.columns = [
    { key: "k", width: 44 },
    { key: "v", width: 22, style: { numFmt: RUPIAH } },
  ];
  const t = r.tax;
  const rows: Array<[string, number | string | null]> = [
    [`Laporan Bulanan ${monthLabel(r.month)}`, null],
    [r.businessName, null],
    [`Periode ${dateLabel(r.period.from)} – ${dateLabel(r.period.to)}${r.partial ? " (bulan berjalan)" : ""}`, null],
    ["", null],
    ["Pemasukan", idr(r.pl.incomeIdr)],
    ["Pengeluaran", idr(r.pl.expenseIdr)],
    ["Laba (rugi jika minus)", idr(r.pl.profitIdr)],
    [`Uang di kas, bank & e-wallet per ${dateLabel(r.cash.asOf)}`, idr(r.cash.totalIdr)],
    ...r.cash.accounts.map((a): [string, number] => [`   ${a.name}`, idr(a.balanceIdr)]),
    ["", null],
    ["Perkiraan pajak", null],
    ["Aturan", t.profileName],
    ["Omzet bulan ini", idr(t.turnoverIdr)],
    ["Omzet sejak Januari", idr(t.ytdTurnoverIdr)],
    ...(t.exemptThresholdIdr > 0n
      ? ([
          ["Omzet bebas pajak terpakai bulan ini", idr(t.exemptUsedThisMonthIdr)],
          ["Sisa batas bebas pajak tahun ini", idr(t.exemptRemainingIdr)],
        ] as Array<[string, number]>)
      : []),
    ["Omzet kena pajak", idr(t.taxableTurnoverIdr)],
    [`Perkiraan pajak (${formatRate(t.rateBps)})`, idr(t.taxIdr)],
    ["Batas bayar", dateLabel(t.dueDate)],
    ...(t.partial ? ([["Bulan belum selesai: angka masih bisa bertambah.", null]] as Array<[string, null]>) : []),
    ...(t.overTurnoverCap ? ([["Omzet tahun ini melewati batas aturan ini: tanyakan ke konsultan pajak.", null]] as Array<[string, null]>) : []),
    [TAX_DISCLAIMER, null],
  ];
  for (const [k, v] of rows) sum.addRow({ k, v: v ?? "" });
  sum.getRow(1).font = { bold: true, size: 14 };
  sum.getCell("A11").font = { bold: true };

  entriesSheet(wb, "Penjualan", r.sales);
  entriesSheet(wb, "Pengeluaran", r.expenses);
  entriesSheet(wb, "Pembayaran pajak", r.taxPayments);
  balancesSheet(wb, r.receivables, r.payables, r.period.to);

  return new Uint8Array(await wb.xlsx.writeBuffer());
}
