/**
 * Generates the synthetic image eval set: evals/datasets/images/*.svg plus the
 * manifest evals/datasets/images.jsonl. The runner renders each SVG to PNG.
 *
 * SYNTHETIC v0, a smoke test for the photo pipeline. Clean rendered text is far
 * easier than real phone photos (blur, glare, crumpled nota, handwriting), so
 * these scores overstate real accuracy. The spec's target set is 300 real
 * images from consented pilot users (spec 7.5); add them as .jpg/.png files in
 * datasets/images/real/ with manifest lines of the same shape.
 *
 * Layouts are generic on purpose: no bank or wallet logos or brand styling,
 * only the bank/wallet name as plain text, as printed on any receipt.
 *
 *   pnpm --filter @bukuwa/evals generate:images
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ImageCase } from "./types.js";

const TODAY = "2026-11-12";
const BUSINESS = "Catering Bu Rina";
const DIR = fileURLToPath(new URL("../datasets/images/", import.meta.url));

let seed = 1_211_2026;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
const dotted = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const comma = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const amount = (lo: number, hi: number, step: number) => Math.max(step, Math.round((lo + rand() * (hi - lo)) / step) * step);

// --- printed formats ----------------------------------------------------------
function printedAmount(n: number): string {
  return pick([`Rp ${dotted(n)},00`, `Rp${dotted(n)}`, `Rp ${dotted(n)}`, `IDR ${comma(n)}.00`]);
}

const MONTHS_ID = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_BACK = [0, 0, 0, 1, 1, 2, 3, 5];

function pickDate(): { iso: string; printed: string } {
  const back = pick(DAYS_BACK);
  const d = new Date(Date.UTC(2026, 10, 12 - back));
  const iso = d.toISOString().slice(0, 10);
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  const hh = String(8 + Math.floor(rand() * 12)).padStart(2, "0");
  const mm = String(Math.floor(rand() * 60)).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const mo = String(m).padStart(2, "0");
  const printed = pick([
    `${day} ${MONTHS_ID[m - 1]} ${y} ${hh}:${mm} WIB`,
    `${dd}/${mo}/${y} ${hh}:${mm}:${String(Math.floor(rand() * 60)).padStart(2, "0")}`,
    `${y}-${mo}-${dd} ${hh}:${mm}`,
    `${day} ${MONTHS_EN[m - 1]} ${y}, ${hh}:${mm}`,
  ]);
  return { iso, printed };
}

// --- SVG ----------------------------------------------------------------------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Line {
  text: string;
  size?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
  /** Right-aligned value on the same row. */
  value?: string;
  gap?: number;
}

function svg(lines: Line[], opts: { width?: number; font: string; bg: string; ink: string; rotate?: number; accent?: string }): string {
  const width = opts.width ?? 420;
  let y = 36;
  const out: string[] = [];
  for (const l of lines) {
    const size = l.size ?? 16;
    y += l.gap ?? 0;
    const weight = l.bold ? "700" : "400";
    const anchor = l.align === "center" ? "middle" : l.align === "right" ? "end" : "start";
    const x = l.align === "center" ? width / 2 : l.align === "right" ? width - 24 : 24;
    out.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(l.text)}</text>`);
    if (l.value) out.push(`<text x="${width - 24}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="end">${esc(l.value)}</text>`);
    y += size + 10;
  }
  const height = y + 20;
  const rot = opts.rotate ? ` transform="rotate(${opts.rotate} ${width / 2} ${height / 2})"` : "";
  const band = opts.accent ? `<rect width="${width}" height="8" fill="${opts.accent}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#e9e9e9"/>
<g${rot}><rect x="4" y="4" width="${width - 8}" height="${height - 8}" fill="${opts.bg}" rx="6"/>${band}
<g font-family="${opts.font}" fill="${opts.ink}">
${out.join("\n")}
</g></g></svg>
`;
}

/** The text a perfect reader would transcribe: each row, label and value on one line. */
function visible(lines: Line[]): string {
  return lines.map((l) => (l.value ? `${l.text} ${l.value}` : l.text)).filter((t) => t.trim()).join("\n");
}

const SANS = "Helvetica, Arial, sans-serif";
const MONO = "Courier New, Courier, monospace";
const HAND = "Bradley Hand, Chalkboard, Comic Sans MS, cursive";

// --- vocab --------------------------------------------------------------------
const PEOPLE = ["SARI WULANDARI", "BUDI SANTOSO", "DEWI ANGGRAINI", "ANDI PRATAMA", "TINI HARYATI", "RINA MARLINA", "JOKO SUSILO", "ANI SUMARNI"];
const SUPPLIERS = ["UD SUMBER REJEKI", "TOKO MAKMUR JAYA", "CV BERKAH PANGAN", "AGEN TELUR PAK HARUN", "GROSIR PLASTIK SENTOSA"];
const STORES = ["TOKO SINAR ABADI", "MINIMARKET HARAPAN", "TOKO BAHAN KUE LARIS", "PASAR SEGAR MART", "WARUNG BU EDI"];
const BANKS = ["BCA", "BRI", "Mandiri", "BNI"];
const WALLETS = ["GoPay", "OVO", "DANA", "ShopeePay"];
const GROCERIES: Array<[string, number]> = [
  ["MINYAK GORENG 2L", 38_000], ["GULA PASIR 1KG", 18_000], ["TEPUNG TERIGU 1KG", 13_500], ["TELUR AYAM 1KG", 29_000],
  ["BERAS PREMIUM 5KG", 74_000], ["MENTEGA 200G", 12_500], ["KECAP MANIS 520ML", 23_000], ["PLASTIK KLIP", 9_000],
  ["BOX NASI 50PCS", 45_000], ["SANTAN KARA 65ML", 4_500], ["GAS ELPIJI 3KG", 22_000], ["BAWANG MERAH 1/2KG", 21_000],
];

type Built = Omit<ImageCase, "id" | "file" | "today" | "business_name"> & { svg: string };
type OEntry = NonNullable<ImageCase["oracle"]>["entries"][number];

function oracleEntry(o: Partial<OEntry> & Pick<OEntry, "kind" | "description">): OEntry {
  return { amount_text: null, items: [], date_text: null, counterparty: null, payment_text: null, suggested_category: null, ...o } as OEntry;
}

// A customer's own "transfer berhasil" screenshot, forwarded by the owner as proof of payment.
function transferIn(): Built {
  const n = amount(50_000, 3_000_000, 5_000);
  const from = pick(PEOPLE);
  const bank = pick(BANKS);
  const d = pickDate();
  const amt = printedAmount(n);
  const lines: Line[] = [
    { text: "Transfer Berhasil", size: 22, bold: true, align: "center", gap: 6 },
    { text: d.printed, align: "center", size: 14 },
    { text: amt, size: 26, bold: true, align: "center", gap: 10 },
    { text: "Dari", gap: 8, value: from },
    { text: "Bank", value: bank },
    { text: "Ke", value: BUSINESS.toUpperCase() },
    { text: "No. Rekening", value: `xxxx${1000 + Math.floor(rand() * 9000)}` },
    { text: "Berita", value: pick(["nasi box", "pesanan", "dp katering", "lunas ya bu", "-"]) },
    { text: `No. Ref ${Math.floor(rand() * 1e9)}`, size: 12, gap: 8 },
  ];
  const caption = chance(0.3) ? pick(["udah ditransfer", "dp pesanan", "bukti tf"]) : undefined;
  return {
    svg: svg(lines, { font: SANS, bg: "#ffffff", ink: "#1d2a33", accent: "#2f6f9f" }),
    caption,
    expected: { is_document: true, entries: [{ kind: "sale", amount_idr: String(n), date: d.iso, counterparty: from, payment_method: `bank:${bank}` }] },
    oracle: {
      visible_text: visible(lines),
      entries: [oracleEntry({ kind: "sale", description: `Transfer masuk dari ${from}`, amount_text: amt, date_text: d.printed, counterparty: from, payment_text: bank })],
    },
    tags: ["transfer_receipt", "sale"],
  };
}

// The owner paying a supplier from their own m-banking.
function transferOut(): Built {
  const n = amount(100_000, 5_000_000, 10_000);
  const to = pick(SUPPLIERS);
  const bank = pick(BANKS);
  const d = pickDate();
  const amt = printedAmount(n);
  const lines: Line[] = [
    { text: "Bukti Transfer", size: 22, bold: true, align: "center", gap: 6 },
    { text: "Status: BERHASIL", align: "center", size: 14 },
    { text: "Tanggal", gap: 8, value: d.printed },
    { text: "Rekening Sumber", value: `${BUSINESS.toUpperCase()}` },
    { text: "Bank", value: bank },
    { text: "Penerima", value: to },
    { text: "Jumlah", value: amt, bold: true },
    { text: "Biaya Admin", value: "Rp 0" },
    { text: "Keterangan", value: pick(["bayar bahan", "kulakan", "nota 112", "-"]) },
  ];
  return {
    svg: svg(lines, { font: SANS, bg: "#fbfbfb", ink: "#222", accent: "#4a7f3f" }),
    expected: { is_document: true, entries: [{ kind: "expense", amount_idr: String(n), date: d.iso, counterparty: to, payment_method: `bank:${bank}` }] },
    oracle: {
      visible_text: visible(lines),
      entries: [oracleEntry({ kind: "expense", description: `Transfer ke ${to}`, amount_text: amt, date_text: d.printed, counterparty: to, payment_text: bank })],
    },
    tags: ["transfer_receipt", "expense"],
  };
}

function qrisIn(): Built {
  const n = amount(10_000, 600_000, 500);
  const from = pick(PEOPLE);
  const d = pickDate();
  const amt = printedAmount(n);
  const lines: Line[] = [
    { text: "Pembayaran QRIS Diterima", size: 20, bold: true, align: "center", gap: 6 },
    { text: amt, size: 26, bold: true, align: "center", gap: 6 },
    { text: "Merchant", gap: 8, value: BUSINESS.toUpperCase() },
    { text: "Pembayar", value: from },
    { text: "Waktu", value: d.printed },
    { text: "Metode", value: "QRIS" },
    { text: `ID Transaksi ${Math.floor(rand() * 1e10)}`, size: 12, gap: 8 },
  ];
  return {
    svg: svg(lines, { font: SANS, bg: "#ffffff", ink: "#202020", accent: "#b23a48" }),
    expected: { is_document: true, entries: [{ kind: "sale", amount_idr: String(n), date: d.iso, counterparty: from, payment_method: "qris" }] },
    oracle: {
      visible_text: visible(lines),
      entries: [oracleEntry({ kind: "sale", description: `QRIS dari ${from}`, amount_text: amt, date_text: d.printed, counterparty: from, payment_text: "QRIS" })],
    },
    tags: ["qris_receipt", "sale"],
  };
}

function walletOut(): Built {
  const n = amount(15_000, 400_000, 1_000);
  const wallet = pick(WALLETS);
  const to = pick([...SUPPLIERS, ...STORES]);
  const d = pickDate();
  const amt = printedAmount(n);
  const lines: Line[] = [
    { text: `${wallet}`, size: 18, bold: true, gap: 4 },
    { text: "Pembayaran Berhasil", size: 20, bold: true, align: "center", gap: 6 },
    { text: `-${amt}`, size: 24, bold: true, align: "center" },
    { text: "Dibayar ke", gap: 8, value: to },
    { text: "Tanggal", value: d.printed },
    { text: "Sumber dana", value: `Saldo ${wallet}` },
  ];
  return {
    svg: svg(lines, { font: SANS, bg: "#ffffff", ink: "#1b1b1b", accent: "#6b5bd2" }),
    expected: { is_document: true, entries: [{ kind: "expense", amount_idr: String(n), date: d.iso, counterparty: to, payment_method: `ewallet:${wallet}` }] },
    oracle: {
      visible_text: visible(lines),
      entries: [oracleEntry({ kind: "expense", description: `Bayar ke ${to}`, amount_text: amt, date_text: d.printed, counterparty: to, payment_text: wallet })],
    },
    tags: ["ewallet_receipt", "expense"],
  };
}

function storeReceipt(): Built {
  const store = pick(STORES);
  const k = 2 + Math.floor(rand() * 4);
  const chosen = [...GROCERIES].sort(() => rand() - 0.5).slice(0, k);
  const items = chosen.map(([name, price]) => ({ name, qty: 1 + Math.floor(rand() * 3), price }));
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  const cashPaid = Math.ceil(total / 50_000) * 50_000;
  const tunai = chance(0.7);
  const d = pickDate();
  const lines: Line[] = [
    { text: store, bold: true, align: "center", size: 18 },
    { text: "Jl. Raya Pasar No. 12", align: "center", size: 13 },
    { text: d.printed, align: "center", size: 13 },
    { text: "--------------------------------", align: "center", size: 13 },
    ...items.map((i) => ({ text: `${i.name} ${i.qty} x ${dotted(i.price)}`, value: dotted(i.qty * i.price), size: 13 })),
    { text: "--------------------------------", align: "center" as const, size: 13 },
    { text: "TOTAL", value: dotted(total), bold: true, size: 15 },
    ...(tunai
      ? [{ text: "TUNAI", value: dotted(cashPaid), size: 13 }, { text: "KEMBALI", value: dotted(cashPaid - total), size: 13 }]
      : [{ text: "DEBIT BCA", value: dotted(total), size: 13 }]),
    { text: "TERIMA KASIH", align: "center" as const, size: 13, gap: 6 },
  ];
  return {
    svg: svg(lines, { font: MONO, bg: "#fffdf6", ink: "#2a2a2a", width: 380, rotate: chance(0.4) ? pick([-2, -1, 1, 2]) : 0 }),
    expected: {
      is_document: true,
      entries: [{ kind: "expense", amount_idr: String(total), date: d.iso, counterparty: store, payment_method: tunai ? "cash" : "bank:BCA" }],
    },
    oracle: {
      visible_text: visible(lines),
      entries: [
        oracleEntry({
          kind: "expense",
          description: `Belanja di ${store}`,
          amount_text: dotted(total),
          items: items.map((i) => ({ name: i.name, qty_text: String(i.qty), unit: null, unit_price_text: dotted(i.price), line_total_text: dotted(i.qty * i.price) })),
          date_text: d.printed,
          counterparty: store,
          payment_text: tunai ? "TUNAI" : "DEBIT BCA",
          suggested_category: "HPP / Bahan baku",
        }),
      ],
    },
    tags: ["store_receipt", "expense", "multi_item"],
  };
}

// The owner's own handwritten sales nota.
function handNota(): Built {
  const to = pick(["Bu Ani", "Pak Joko", "Mbak Dewi", "Bu Sari", "Bu Tini"]);
  const items = [
    pick([["Nasi box ayam", 20_000], ["Nasi kuning", 15_000], ["Tumpeng mini", 35_000]] as const),
    pick([["Snack box", 12_000], ["Kue lapis", 3_000], ["Es teh", 5_000]] as const),
  ];
  const rows = items.map(([name, price]) => ({ name, qty: pick([10, 15, 20, 25, 30]), price }));
  const total = rows.reduce((s, r) => s + r.qty * r.price, 0);
  const back = pick(DAYS_BACK);
  const dt = new Date(Date.UTC(2026, 10, 12 - back));
  const iso = dt.toISOString().slice(0, 10);
  const printedDate = `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}/26`;
  const lunasCash = chance(0.6);
  const lines: Line[] = [
    { text: "NOTA", bold: true, align: "center", size: 22 },
    { text: `Tgl: ${printedDate}`, size: 17 },
    { text: `Kepada: ${to}`, size: 17 },
    ...rows.map((r) => ({ text: `${r.qty} ${r.name} @${dotted(r.price)}`, value: dotted(r.qty * r.price), size: 17 })),
    { text: "Jumlah", value: `Rp ${dotted(total)}`, bold: true, size: 18, gap: 6 },
    { text: lunasCash ? "LUNAS - cash" : "LUNAS - transfer", size: 17, gap: 4 },
  ];
  return {
    svg: svg(lines, { font: HAND, bg: "#fdf8e4", ink: "#1f3b8a", width: 400, rotate: pick([-3, -2, 2, 3]) }),
    caption: chance(0.5) ? "nota pesanan" : undefined,
    expected: { is_document: true, entries: [{ kind: "sale", amount_idr: String(total), date: iso, counterparty: to, payment_method: lunasCash ? "cash" : "bank:other" }] },
    oracle: {
      visible_text: visible(lines),
      entries: [
        oracleEntry({
          kind: "sale",
          description: `Nota pesanan ${to}`,
          amount_text: `Rp ${dotted(total)}`,
          items: rows.map((r) => ({ name: r.name, qty_text: String(r.qty), unit: null, unit_price_text: dotted(r.price), line_total_text: dotted(r.qty * r.price) })),
          date_text: `Tgl: ${printedDate}`,
          counterparty: to,
          payment_text: lunasCash ? "cash" : "transfer",
          suggested_category: "Penjualan",
        }),
      ],
    },
    tags: ["handwritten_nota", "sale", "multi_item"],
  };
}

function supplierInvoice(): Built {
  const from = pick(SUPPLIERS);
  const rows = [
    { name: pick(["Ayam potong", "Daging sapi", "Beras"]), qty: pick([10, 20, 25]), unit: "kg", price: pick([35_000, 38_000, 14_000]) },
    { name: pick(["Minyak goreng", "Telur", "Gula pasir"]), qty: pick([5, 10]), unit: "kg", price: pick([18_000, 29_000, 17_500]) },
  ];
  const total = rows.reduce((s, r) => s + r.qty * r.price, 0);
  const d = pickDate();
  const amt = `Rp ${dotted(total)}`;
  const lines: Line[] = [
    { text: from, bold: true, size: 18 },
    { text: "INVOICE", bold: true, align: "right", size: 20 },
    { text: `No: INV/${Math.floor(rand() * 900 + 100)}/XI/2026`, size: 13 },
    { text: `Tanggal: ${d.printed}`, size: 13 },
    { text: `Kepada: ${BUSINESS}`, size: 13 },
    ...rows.map((r) => ({ text: `${r.name} ${r.qty} ${r.unit} x ${dotted(r.price)}`, value: dotted(r.qty * r.price), size: 14, gap: 2 })),
    { text: "Total", value: amt, bold: true, size: 16, gap: 6 },
    { text: "Status: LUNAS (transfer)", size: 14 },
  ];
  return {
    svg: svg(lines, { font: SANS, bg: "#ffffff", ink: "#111", width: 460 }),
    expected: { is_document: true, entries: [{ kind: "expense", amount_idr: String(total), date: d.iso, counterparty: from, payment_method: "bank:other" }] },
    oracle: {
      visible_text: visible(lines),
      entries: [
        oracleEntry({
          kind: "expense",
          description: `Invoice ${from}`,
          amount_text: amt,
          items: rows.map((r) => ({ name: r.name, qty_text: String(r.qty), unit: r.unit, unit_price_text: dotted(r.price), line_total_text: dotted(r.qty * r.price) })),
          date_text: d.printed,
          counterparty: from,
          payment_text: "transfer",
          suggested_category: "HPP / Bahan baku",
        }),
      ],
    },
    tags: ["supplier_invoice", "expense", "multi_item"],
  };
}

function notADocument(): Built {
  const kind = pick(["cake", "flyer", "menu"]);
  const body =
    kind === "cake"
      ? `<rect width="100%" height="100%" fill="#f3e6ef"/><ellipse cx="210" cy="250" rx="140" ry="40" fill="#e7b7c8"/><rect x="70" y="150" width="280" height="100" fill="#f7d6e0"/><ellipse cx="210" cy="150" rx="140" ry="40" fill="#fbe9ef"/><rect x="205" y="80" width="10" height="50" fill="#f2c94c"/><text x="210" y="330" font-family="${HAND}" font-size="26" text-anchor="middle" fill="#7a3651">Selamat Ulang Tahun</text>`
      : kind === "flyer"
        ? `<rect width="100%" height="100%" fill="#fff3d6"/><text x="210" y="80" font-family="${SANS}" font-size="30" font-weight="700" text-anchor="middle" fill="#b5541c">PROMO MINGGU INI</text><text x="210" y="140" font-family="${SANS}" font-size="20" text-anchor="middle" fill="#333">Nasi box mulai 15rb</text><text x="210" y="180" font-family="${SANS}" font-size="20" text-anchor="middle" fill="#333">Pesan H-1 ya kak</text><circle cx="210" cy="270" r="50" fill="#f2c94c"/>`
        : `<rect width="100%" height="100%" fill="#ffffff"/><text x="210" y="60" font-family="${SANS}" font-size="26" font-weight="700" text-anchor="middle">MENU</text><text x="40" y="110" font-family="${SANS}" font-size="18">Ayam geprek ........ 15rb</text><text x="40" y="145" font-family="${SANS}" font-size="18">Nasi kuning ......... 12rb</text><text x="40" y="180" font-family="${SANS}" font-size="18">Es teh manis ......... 5rb</text>`;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="360" viewBox="0 0 420 360">${body}</svg>\n`,
    expected: { is_document: false },
    tags: ["not_a_document", kind],
  };
}

const PLAN: Array<[number, () => Built]> = [
  [12, transferIn],
  [8, transferOut],
  [8, qrisIn],
  [5, walletOut],
  [12, storeReceipt],
  [6, handNota],
  [5, supplierInvoice],
  [4, notADocument],
];

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const cases: ImageCase[] = [];
for (const [count, fn] of PLAN) {
  for (let i = 0; i < count; i++) {
    const b = fn();
    const id = `img-${String(cases.length + 1).padStart(3, "0")}`;
    writeFileSync(`${DIR}${id}.svg`, b.svg);
    const { svg: _svg, ...rest } = b;
    cases.push({ id, file: `${id}.svg`, today: TODAY, business_name: BUSINESS, ...rest, tags: ["synthetic", ...rest.tags] });
  }
}
const manifest = fileURLToPath(new URL("../datasets/images.jsonl", import.meta.url));
writeFileSync(manifest, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.log(`wrote ${cases.length} cases (${readdirSync(DIR).length} images) to ${manifest}`);
