import { createElement as h, type ReactElement } from "react";
import { Document, Link, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ContactBalance } from "@bukuwa/ledger";
import { dateLabel, EVIDENCE_LABEL, formatRate, monthLabel, rp, TAX_DISCLAIMER } from "./format.js";
import type { MonthlyReport, ReportLine } from "./monthly.js";

/* Monthly report as PDF (react-pdf, spec 5). Layout only: every number comes from MonthlyReport. */

const s = StyleSheet.create({
  page: { padding: 36, fontSize: 9, fontFamily: "Helvetica", color: "#1f2933" },
  title: { fontSize: 16, fontFamily: "Helvetica-Bold" },
  sub: { color: "#52606d", marginTop: 2 },
  h2: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 16, marginBottom: 6 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#d9e2ec", paddingVertical: 3 },
  head: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#9fb3c8", paddingVertical: 3, fontFamily: "Helvetica-Bold" },
  kv: { flexDirection: "row", paddingVertical: 2 },
  k: { width: 220, color: "#52606d" },
  v: { flex: 1, textAlign: "right", fontFamily: "Helvetica-Bold" },
  num: { textAlign: "right" },
  note: { marginTop: 6, color: "#52606d", fontSize: 8 },
  warn: { marginTop: 6, color: "#b44d12" },
  box: { borderWidth: 1, borderColor: "#9fb3c8", borderRadius: 4, padding: 10, marginTop: 8 },
  link: { color: "#0b69a3", textDecoration: "none" },
  footer: { position: "absolute", bottom: 20, left: 36, right: 36, fontSize: 7, color: "#829ab1", flexDirection: "row", justifyContent: "space-between" },
});

const kv = (k: string, v: string) => h(View, { style: s.kv }, h(Text, { style: s.k }, k), h(Text, { style: s.v }, v));

type Col = { title: string; width: number | "flex"; right?: boolean; cell: (l: ReportLine) => ReactElement | string };
const colStyle = (c: Col) => (c.width === "flex" ? { flex: 1, paddingRight: 4 } : { width: c.width, paddingRight: 4, ...(c.right ? s.num : {}) });

function table(lines: ReportLine[], cols: Col[], empty: string, total?: bigint) {
  if (!lines.length) return h(Text, { style: s.note }, empty);
  return h(
    View,
    null,
    h(View, { style: s.head, fixed: true }, ...cols.map((c) => h(Text, { style: colStyle(c) }, c.title))),
    ...lines.map((l) =>
      h(View, { style: s.row, wrap: false }, ...cols.map((c) => {
        const v = c.cell(l);
        return typeof v === "string" ? h(Text, { style: colStyle(c) }, v) : h(View, { style: colStyle(c) }, v);
      })),
    ),
    total === undefined ? null : h(View, { style: s.head }, h(Text, { style: { flex: 1 } }, "Total"), h(Text, { style: { width: 90, ...s.num } }, rp(total))),
  );
}

const evidenceCell = (l: ReportLine): ReactElement | string => {
  if (!l.evidence) return "-";
  const label = EVIDENCE_LABEL[l.evidence.source];
  return l.evidence.url ? h(Link, { src: l.evidence.url, style: s.link }, label) : label;
};

const entryCols = (): Col[] => [
  { title: "Tanggal", width: 62, cell: (l) => dateLabel(l.date) },
  { title: "Keterangan", width: "flex", cell: (l) => [l.description, l.counterparty].filter(Boolean).join(" · ") },
  { title: "Kategori", width: 95, cell: (l) => l.category ?? "-" },
  { title: "Dibayar", width: 70, cell: (l) => l.paidWith ?? "-" },
  { title: "Bukti", width: 58, cell: evidenceCell },
  { title: "Jumlah", width: 90, right: true, cell: (l) => rp(l.amountIdr) },
];

function balances(list: ContactBalance[], empty: string) {
  if (!list.length) return h(Text, { style: s.note }, empty);
  return h(
    View,
    null,
    h(View, { style: s.head }, h(Text, { style: { flex: 1 } }, "Nama"), h(Text, { style: { width: 90 } }, "Sejak"), h(Text, { style: { width: 90, ...s.num } }, "Sisa")),
    ...list.map((c) =>
      h(View, { style: s.row, wrap: false }, h(Text, { style: { flex: 1 } }, c.name), h(Text, { style: { width: 90 } }, c.oldestOpenDate ? dateLabel(c.oldestOpenDate) : "-"), h(Text, { style: { width: 90, ...s.num } }, rp(c.balanceIdr))),
    ),
  );
}

export function reportDocument(r: MonthlyReport): ReactElement {
  const t = r.tax;
  const sum = (ls: ReportLine[]) => ls.reduce((a, l) => a + l.amountIdr, 0n);
  const periodText = `${dateLabel(r.period.from)} – ${dateLabel(r.period.to)}${r.partial ? " (bulan berjalan)" : ""}`;
  return h(
    Document,
    { title: `Laporan ${monthLabel(r.month)} - ${r.businessName}`, author: "BukuWA", language: "id" },
    h(
      Page,
      { size: "A4", style: s.page },
      h(Text, { style: s.title }, `Laporan Bulanan ${monthLabel(r.month)}`),
      h(Text, { style: s.sub }, `${r.businessName} · ${periodText}`),

      h(Text, { style: s.h2 }, "Ringkasan"),
      kv("Pemasukan", rp(r.pl.incomeIdr)),
      kv("Pengeluaran", rp(r.pl.expenseIdr)),
      kv(r.pl.profitIdr >= 0n ? "Laba" : "Rugi", rp(r.pl.profitIdr < 0n ? -r.pl.profitIdr : r.pl.profitIdr)),
      kv(`Uang di kas, bank & e-wallet per ${dateLabel(r.cash.asOf)}`, rp(r.cash.totalIdr)),
      ...r.cash.accounts.map((a) => kv(`   ${a.name}`, rp(a.balanceIdr))),

      h(Text, { style: s.h2 }, "Perkiraan pajak"),
      h(
        View,
        { style: s.box },
        kv("Aturan", t.profileName),
        kv("Omzet bulan ini", rp(t.turnoverIdr)),
        kv("Omzet sejak Januari", rp(t.ytdTurnoverIdr)),
        ...(t.exemptThresholdIdr > 0n
          ? [kv("Omzet bebas pajak terpakai bulan ini", rp(t.exemptUsedThisMonthIdr)), kv(`Sisa batas bebas pajak (${rp(t.exemptThresholdIdr)}/tahun)`, rp(t.exemptRemainingIdr))]
          : []),
        kv("Omzet kena pajak", rp(t.taxableTurnoverIdr)),
        kv(`Perkiraan pajak (${formatRate(t.rateBps)})`, rp(t.taxIdr)),
        kv("Batas bayar", dateLabel(t.dueDate)),
        t.partial ? h(Text, { style: s.warn }, "Bulan belum selesai: angka ini masih bisa bertambah.") : null,
        t.overTurnoverCap ? h(Text, { style: s.warn }, "Omzet tahun ini sudah melewati batas aturan ini. Tanyakan ke konsultan pajak aturan mana yang berlaku.") : null,
        h(Text, { style: s.note }, TAX_DISCLAIMER),
      ),

      h(Text, { style: s.h2 }, "Pemasukan per kategori"),
      ...(r.pl.income.length ? r.pl.income.map((a) => kv(a.name, rp(a.amountIdr))) : [h(Text, { style: s.note }, "Belum ada pemasukan.")]),
      h(Text, { style: s.h2 }, "Pengeluaran per kategori"),
      ...(r.pl.expenses.length ? r.pl.expenses.map((a) => kv(a.name, rp(a.amountIdr))) : [h(Text, { style: s.note }, "Belum ada pengeluaran.")]),

      h(Text, { style: s.h2, break: true }, "Daftar penjualan (bukti omzet)"),
      table(r.sales, entryCols(), "Belum ada penjualan di periode ini.", sum(r.sales)),
      h(Text, { style: s.note }, "Link bukti membuka foto/voice asli yang dikirim lewat WhatsApp; link punya masa berlaku."),

      h(Text, { style: s.h2 }, "Daftar pengeluaran"),
      table(r.expenses, entryCols(), "Belum ada pengeluaran di periode ini.", sum(r.expenses)),

      h(Text, { style: s.h2 }, "Pembayaran pajak yang dicatat bulan ini"),
      table(r.taxPayments, entryCols(), "Belum ada pembayaran pajak yang dicatat. Kirim foto bukti bayarnya ke BukuWA ya."),

      h(Text, { style: s.h2 }, `Piutang per ${dateLabel(r.period.to)} (pelanggan belum bayar)`),
      balances(r.receivables, "Tidak ada piutang."),
      h(Text, { style: s.h2 }, `Utang per ${dateLabel(r.period.to)} (belum dibayar ke supplier)`),
      balances(r.payables, "Tidak ada utang."),

      h(
        View,
        { style: s.footer, fixed: true },
        h(Text, null, `Dibuat BukuWA ${r.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC. ${TAX_DISCLAIMER}`),
        h(Text, { render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `${pageNumber}/${totalPages}` }),
      ),
    ),
  );
}

export async function renderReportPdf(r: MonthlyReport): Promise<Uint8Array> {
  // renderToBuffer is typed for <Document> elements; ours is one.
  return new Uint8Array(await renderToBuffer(reportDocument(r) as Parameters<typeof renderToBuffer>[0]));
}
