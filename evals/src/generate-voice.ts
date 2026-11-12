/**
 * Generates evals/datasets/voice.jsonl: 100 voice-note transcripts (spec 7.5).
 *
 * SYNTHETIC v0. These are transcripts as a speech-to-text engine would return
 * them (numbers spelled out, fillers, no abbreviations, Javanese/Sundanese
 * mixing), scored through the same router -> extractor -> normalizer path as
 * text. They measure everything after speech-to-text; the STT step itself is
 * measured on real audio by stt-bench.ts. Replace with transcripts of
 * consented pilot voice notes as soon as they exist.
 *
 * Expected amounts come from the numbers the generator chose.
 *
 *   pnpm --filter @bukuwa/evals generate:voice
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { terbilang, terbilangJawa } from "./terbilang.js";
import type { TextCase } from "./types.js";

const TODAY = "2026-11-12"; // Thursday
const TOTAL = 100;

let seed = 4_20_2611;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;

/** How STT might write an amount: mostly words, sometimes digits. */
function say(n: number, javanese = false): string {
  if (javanese) {
    const jw = terbilangJawa(n);
    if (jw) return jw;
  }
  if (chance(0.25)) return n < 1_000_000 ? `${n / 1000} ribu` : n % 1_000_000 === 0 ? `${n / 1_000_000} juta` : terbilang(n);
  if (chance(0.1)) return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return terbilang(n);
}

function amount(lo: number, hi: number, step = 1000): number {
  return Math.max(step, Math.round((lo + rand() * (hi - lo)) / step) * step);
}

const FILLER = ["", "", "", "eh ", "ee ", "jadi ", "oke ", "catat ya ", "mau nyatet "];
const LINK = [" terus ", " sama ", ", ", " abis itu "];

const PAYMENTS: Array<{ text: string | null; spoken: string; method: string | null }> = [
  { text: "cash", spoken: "bayarnya cash", method: "cash" },
  { text: "tunai", spoken: "tunai", method: "cash" },
  { text: "transfer bca", spoken: "lewat transfer bca", method: "bank:BCA" },
  { text: "bri", spoken: "ditransfer ke bri", method: "bank:BRI" },
  { text: "mandiri", spoken: "pakai mandiri", method: "bank:Mandiri" },
  { text: "gopay", spoken: "pakai gopay", method: "ewallet:GoPay" },
  { text: "qris", spoken: "lewat qris", method: "qris" },
  { text: "transfer", spoken: "transfer", method: "bank:other" },
  { text: null, spoken: "", method: null },
];

const DATES: Array<{ text: string | null; date: string }> = [
  { text: null, date: TODAY },
  { text: null, date: TODAY },
  { text: "tadi", date: TODAY },
  { text: "barusan", date: TODAY },
  { text: "kemarin", date: "2026-11-11" },
  { text: "senin", date: "2026-11-09" },
  { text: "tanggal sepuluh", date: "" }, // spoken day numbers: not supported by the parser, skipped below
];

type Built = Pick<TextCase, "text" | "expected" | "oracle" | "tags">;
type OEntry = NonNullable<TextCase["oracle"]>["entries"][number];

function payPart(p: (typeof PAYMENTS)[number]): string {
  if (!p.text) return "";
  // The spoken phrase must contain the payment span the oracle copies.
  return p.spoken.includes(p.text) ? p.spoken : p.text;
}

function datePick() {
  return pick(DATES.filter((d) => d.date));
}

function oracleEntry(o: Partial<OEntry> & Pick<OEntry, "kind" | "description">): OEntry {
  return { amount_text: null, items: [], date_text: null, counterparty: null, payment_text: null, suggested_category: null, ...o } as OEntry;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}

// Flow B: several items bought together, line totals spelled out.
function expenseMulti(): Built {
  const pool = [
    { name: "ayam", unit: "kilo", qty: [2, 3, 5], per: [32_000, 35_000, 38_000] },
    { name: "minyak", unit: "liter", qty: [2, 4], per: [18_000, 19_000] },
    { name: "telur", unit: "kilo", qty: [2, 3], per: [28_000, 30_000] },
    { name: "beras", unit: "karung", qty: [1, 2], per: [70_000, 75_000] },
    { name: "gula", unit: "kilo", qty: [2, 5], per: [17_000, 18_000] },
    { name: "plastik", unit: "pak", qty: [2, 3], per: [12_000, 15_000] },
  ];
  const a = pick(pool);
  let b = pick(pool);
  while (b === a) b = pick(pool);
  const qa = pick(a.qty);
  const qb = pick(b.qty);
  const ta = qa * pick(a.per);
  const tb = qb * pick(b.per);
  const sa = say(ta);
  const sb = say(tb);
  const p = pick(PAYMENTS.filter((x) => x.text));
  const d = datePick();
  const qaText = terbilang(qa);
  const qbText = terbilang(qb);
  const text = clean(
    `${pick(FILLER)}${d.text ?? ""} belanja ${a.name} ${qaText} ${a.unit} ${sa}${pick(LINK)}${b.name} ${qbText} ${b.unit} ${sb} ${payPart(p)}`,
  );
  return {
    text,
    expected: { intent: "transaction", entries: [{ kind: "expense", amount_idr: String(ta + tb), payment_method: p.method, date: d.date }] },
    oracle: {
      entries: [
        oracleEntry({
          kind: "expense",
          description: "Belanja bahan",
          items: [
            { name: a.name, qty_text: qaText, unit: a.unit, unit_price_text: null, line_total_text: sa },
            { name: b.name, qty_text: qbText, unit: b.unit, unit_price_text: null, line_total_text: sb },
          ],
          date_text: d.text,
          payment_text: p.text,
        }),
      ],
      needs_clarification: [],
    },
    tags: ["expense", "multi_item"],
  };
}

function saleQtyPrice(): Built {
  const item = pick([
    { name: "nasi box", price: [15_000, 18_000, 20_000] },
    { name: "ayam geprek", price: [12_000, 15_000] },
    { name: "kue lapis", price: [3_000, 5_000] },
    { name: "gamis", price: [150_000, 175_000] },
    { name: "hijab", price: [35_000, 45_000] },
  ]);
  const qty = pick([5, 10, 12, 20, 25, 30, 40]);
  const price = pick(item.price);
  const qtyText = terbilang(qty);
  const priceText = say(price);
  const p = pick(PAYMENTS);
  const d = datePick();
  const text = clean(
    `${pick(FILLER)}${d.text ?? ""} ${pick(["jual", "laku", "ada pesanan"])} ${item.name} ${qtyText}, ${pick(["harganya", "satunya", "per biji"])} ${priceText} ${payPart(p)}`,
  );
  return {
    text,
    expected: { intent: "transaction", entries: [{ kind: "sale", amount_idr: String(qty * price), payment_method: p.method, date: d.date }] },
    oracle: {
      entries: [
        oracleEntry({
          kind: "sale",
          description: `Jual ${item.name}`,
          items: [{ name: item.name, qty_text: qtyText, unit: null, unit_price_text: priceText, line_total_text: null }],
          date_text: d.text,
          payment_text: p.text,
        }),
      ],
      needs_clarification: [],
    },
    tags: ["sale", "qty_x_price"],
  };
}

function saleTotal(): Built {
  const n = amount(150_000, 2_500_000, 50_000);
  const name = pick(["bu sari", "pak budi", "mbak rina", "bu tini", "mas andi"]);
  const what = pick(["pesanan katering", "nasi box", "kue", "baju", "arisan"]);
  const s = say(n);
  const p = pick(PAYMENTS.filter((x) => x.text));
  const d = datePick();
  const text = clean(`${pick(FILLER)}${d.text ?? ""} ${name} bayar ${what} ${s} ${payPart(p)}`);
  return {
    text,
    expected: { intent: "transaction", entries: [{ kind: "sale", amount_idr: String(n), payment_method: p.method, date: d.date }] },
    oracle: {
      entries: [oracleEntry({ kind: "sale", description: `Bayar ${what}`, amount_text: s, counterparty: name, date_text: d.text, payment_text: p.text })],
      needs_clarification: [],
    },
    tags: ["sale", "total", "counterparty"],
  };
}

function expenseSingle(): Built {
  const e = pick([
    { phrase: "bayar listrik", lo: 150_000, hi: 900_000 },
    { phrase: "bayar sewa kios", lo: 500_000, hi: 2_500_000 },
    { phrase: "gaji mbak yuni", lo: 800_000, hi: 2_500_000 },
    { phrase: "ongkir gojek", lo: 15_000, hi: 60_000 },
    { phrase: "beli gas", lo: 20_000, hi: 25_000 },
    { phrase: "iklan instagram", lo: 50_000, hi: 300_000 },
  ]);
  const n = amount(e.lo, e.hi, e.hi > 500_000 ? 50_000 : 1000);
  const s = say(n);
  const p = pick(PAYMENTS.filter((x) => x.text));
  const d = datePick();
  const text = clean(`${pick(FILLER)}${d.text ?? ""} ${e.phrase} ${s} ${payPart(p)}`);
  return {
    text,
    expected: { intent: "transaction", entries: [{ kind: "expense", amount_idr: String(n), payment_method: p.method, date: d.date }] },
    oracle: {
      entries: [oracleEntry({ kind: "expense", description: e.phrase, amount_text: s, date_text: d.text, payment_text: p.text })],
      needs_clarification: [],
    },
    tags: ["expense"],
  };
}

// Javanese / Sundanese mixing.
function regional(): Built {
  const jv = chance(0.7);
  const n = amount(10_000, 600_000, jv ? 5_000 : 1_000);
  const words = jv ? terbilangJawa(n) ?? terbilang(n) : terbilang(n).replace(/ribu/g, "rebu");
  const sale = chance(0.5);
  const p = pick(PAYMENTS.filter((x) => x.text === "cash" || x.text === "tunai" || x.text === "transfer"));
  const date = jv ? pick([{ text: "wingi", date: "2026-11-11" }, { text: null, date: TODAY }]) : pick([{ text: "kamari", date: "2026-11-11" }, { text: null, date: TODAY }]);
  const verb = jv ? (sale ? pick(["dodolan", "payu"]) : pick(["tuku", "blanja"])) : sale ? "ngajual" : "meuli";
  const what = sale ? pick(["sego kotak", "jajanan", "klambi"]) : pick(["beras", "gas", "lombok", "endhog"]);
  const text = clean(`${date.text ?? ""} ${verb} ${what} ${words} ${p.text}`);
  return {
    text,
    expected: { intent: "transaction", entries: [{ kind: sale ? "sale" : "expense", amount_idr: String(n), payment_method: p.method, date: date.date }] },
    oracle: {
      entries: [oracleEntry({ kind: sale ? "sale" : "expense", description: `${verb} ${what}`, amount_text: words, date_text: date.text, payment_text: p.text })],
      needs_clarification: [],
    },
    tags: [jv ? "javanese" : "sundanese", sale ? "sale" : "expense"],
  };
}

function ownerDrawing(): Built {
  const n = amount(100_000, 1_500_000, 50_000);
  const s = say(n);
  const p = pick(PAYMENTS.filter((x) => x.text));
  const text = clean(`${pick(FILLER)}ambil duit ${s} buat ${pick(["keperluan rumah", "jajan anak", "pribadi"])} ${payPart(p)}`);
  return {
    text,
    expected: { intent: "transaction", entries: [{ kind: "owner_drawing", amount_idr: String(n), payment_method: p.method, date: TODAY }] },
    oracle: { entries: [oracleEntry({ kind: "owner_drawing", description: "Ambil pribadi", amount_text: s, payment_text: p.text })], needs_clarification: [] },
    tags: ["owner_drawing"],
  };
}

const NON_TX: Array<[string, string]> = [
  ["untung minggu ini berapa ya", "question"],
  ["eh coba cek pengeluaran bulan ini udah berapa", "question"],
  ["siapa aja yang belum bayar", "question"],
  ["kemarin pemasukannya berapa", "question"],
  ["yang tadi salah harusnya empat puluh lima ribu bukan empat ratus lima puluh ribu", "correction"],
  ["hapus yang terakhir ya salah catat", "correction"],
  ["makasih ya", "chitchat"],
  ["halo selamat pagi", "chitchat"],
  ["oke siap", "chitchat"],
  ["kirim laporan bulan ini dong", "command"],
  ["cara pakainya gimana ya", "command"],
  ["tes tes satu dua tiga", "unsupported"],
];

const TEMPLATES: Array<[number, () => Built]> = [
  [0.25, expenseMulti],
  [0.2, saleQtyPrice],
  [0.15, saleTotal],
  [0.2, expenseSingle],
  [0.12, regional],
  [0.08, ownerDrawing],
];

function one(): Built {
  let r = rand();
  for (const [w, fn] of TEMPLATES) if ((r -= w) <= 0) return fn();
  return TEMPLATES[0]![1]();
}

const cases: TextCase[] = [];
const seen = new Set<string>();
while (cases.length < TOTAL - NON_TX.length) {
  const b = one();
  if (seen.has(b.text)) continue;
  seen.add(b.text);
  cases.push({ id: `voice-${String(cases.length + 1).padStart(3, "0")}`, today: TODAY, ...b, tags: ["synthetic", "voice", ...b.tags] });
}
NON_TX.forEach(([text, intent], i) =>
  cases.push({ id: `voice-nt-${String(i + 1).padStart(2, "0")}`, today: TODAY, text, expected: { intent }, tags: ["synthetic", "voice", intent] }),
);

const out = fileURLToPath(new URL("../datasets/voice.jsonl", import.meta.url));
writeFileSync(out, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.log(`wrote ${cases.length} cases to ${out}`);
