/**
 * Generates evals/datasets/text.jsonl: the first text eval set (spec 9.3, M2).
 *
 * SYNTHETIC v0. Built from templates with a fixed seed, plus hand-written
 * cases. No real customer data. Replace and extend with consented pilot
 * messages (spec 7.5) as soon as they exist; synthetic sets overstate accuracy.
 *
 * Expected amounts come from the numbers the generator chose, never from
 * parsing the generated text, so the set checks the parsers independently.
 *
 *   pnpm --filter @bukuwa/evals generate
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HANDWRITTEN } from "./handwritten.js";
import type { TextCase } from "./types.js";

const TODAY = "2026-11-12"; // Thursday
// 300 cases in total (spec 9.3), the rest are hand-written.

// --- deterministic PRNG (mulberry32) ---------------------------------------
let seed = 20261112;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;

// --- amount formatting ------------------------------------------------------
function dotted(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Some spelling of `n` an owner might type. */
function spell(n: number): string {
  const forms: string[] = [];
  if (n === 5_000) forms.push("goceng");
  if (n === 10_000) forms.push("ceban");
  if (n === 1_000) forms.push("seceng");
  if (n === 500_000) forms.push("setengah juta");
  if (n % 1_000_000 === 0) {
    const m = n / 1_000_000;
    forms.push(`${m}jt`, `${m} jt`, `${m} juta`);
  } else if (n > 1_000_000 && n % 100_000 === 0) {
    const m = Math.floor(n / 1_000_000);
    const frac = String((n % 1_000_000) / 100_000);
    forms.push(`${m},${frac}jt`, `${m}.${frac} juta`, `${m}jt ${(n % 1_000_000) / 1000}rb`);
  }
  if (n % 1_000 === 0 && n < 1_000_000) {
    const k = n / 1000;
    forms.push(`${k}rb`, `${k} rb`, `${k}ribu`, `${k} ribu`, `${k}k`, `${k}rebu`);
  }
  forms.push(dotted(n), `Rp ${dotted(n)}`, `${n}`);
  return pick(forms);
}

// --- vocab --------------------------------------------------------------------
const SALE_ITEMS = [
  { name: "nasi box", price: [15_000, 18_000, 20_000, 25_000] },
  { name: "ayam geprek", price: [12_000, 15_000, 18_000] },
  { name: "es teh", price: [3_000, 4_000, 5_000] },
  { name: "kue lapis", price: [2_500, 3_000, 5_000] },
  { name: "risol", price: [2_000, 2_500, 3_000] },
  { name: "nasi kuning", price: [10_000, 12_000, 15_000] },
  { name: "gamis", price: [150_000, 175_000, 225_000] },
  { name: "hijab", price: [35_000, 45_000, 60_000] },
  { name: "kaos", price: [55_000, 75_000, 90_000] },
  { name: "daster", price: [45_000, 65_000] },
  { name: "beras 5kg", price: [68_000, 72_000, 75_000] },
  { name: "telur", price: [28_000, 30_000] },
  { name: "gas elpiji", price: [20_000, 22_000, 25_000] },
] as const;

const EXPENSES = [
  { verb: ["belanja", "beli", "kulakan"], what: ["ayam", "beras", "telur", "minyak goreng", "tepung", "sayur", "bumbu", "plastik kemasan", "box nasi", "kain"], range: [25_000, 900_000] },
  { verb: ["bayar"], what: ["listrik", "air pdam", "wifi", "sewa kios", "sewa lapak"], range: [100_000, 2_500_000] },
  { verb: ["gaji", "bayar gaji"], what: ["karyawan", "mbak yuni", "pegawai"], range: [500_000, 3_000_000] },
  { verb: ["ongkir", "bayar ongkir", "kirim paket"], what: ["jne", "gojek", "grab", "paxel"], range: [10_000, 85_000] },
  { verb: ["iklan", "boost"], what: ["ig", "fb", "tiktok"], range: [50_000, 500_000] },
  { verb: ["isi", "beli"], what: ["bensin", "pertalite"], range: [20_000, 100_000] },
] as const;

const NAMES = ["Bu Sari", "Pak Budi", "Mbak Rina", "Bu Tini", "Mas Andi", "Kak Dewi", "Bu Ani", "Pak Joko"];

const PAYMENTS: Array<{ text: string | null; method: string | null }> = [
  { text: "cash", method: "cash" },
  { text: "tunai", method: "cash" },
  { text: "tf bca", method: "bank:BCA" },
  { text: "transfer BCA", method: "bank:BCA" },
  { text: "trf mandiri", method: "bank:Mandiri" },
  { text: "via BRI", method: "bank:BRI" },
  { text: "tf bni", method: "bank:BNI" },
  { text: "transfer", method: "bank:other" },
  { text: "pake gopay", method: "ewallet:GoPay" },
  { text: "via ovo", method: "ewallet:OVO" },
  { text: "pake dana", method: "ewallet:DANA" },
  { text: "shopeepay", method: "ewallet:ShopeePay" },
  { text: "qris", method: "qris" },
  { text: null, method: null },
  { text: null, method: null },
];

const DATES: Array<{ text: string | null; date: string }> = [
  { text: null, date: TODAY },
  { text: null, date: TODAY },
  { text: null, date: TODAY },
  { text: "tadi", date: TODAY },
  { text: "hari ini", date: TODAY },
  { text: "kemarin", date: "2026-11-11" },
  { text: "kmrn", date: "2026-11-11" },
  { text: "senin", date: "2026-11-09" },
  { text: "tgl 10", date: "2026-11-10" },
  { text: "8/11", date: "2026-11-08" },
];

function roundTo(n: number, step: number) {
  return Math.max(step, Math.round(n / step) * step);
}

function randomAmount(lo: number, hi: number): number {
  const n = lo + rand() * (hi - lo);
  return roundTo(n, n > 1_000_000 ? 100_000 : n > 100_000 ? 5_000 : 1_000);
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function finish(parts: Array<string | null>): string {
  let text = parts.filter(Boolean).join(" ");
  if (chance(0.1)) text = text.toUpperCase();
  else if (chance(0.25)) text = cap(text);
  return text;
}

// --- templates ------------------------------------------------------------------
type Built = Pick<TextCase, "text" | "expected" | "oracle" | "tags">;

function entryExpected(kind: string, amount: number, pay: (typeof PAYMENTS)[number], date: (typeof DATES)[number]) {
  return { kind, amount_idr: String(amount), payment_method: pay.method, date: date.date };
}

function baseOracle(kind: string, description: string, pay: (typeof PAYMENTS)[number], date: (typeof DATES)[number]) {
  return {
    kind: kind as never,
    description,
    amount_text: null as string | null,
    items: [] as Array<{ name: string; qty_text: string | null; unit: string | null; unit_price_text: string | null; line_total_text: string | null }>,
    date_text: date.text,
    counterparty: null as string | null,
    payment_text: pay.text,
    suggested_category: null,
  };
}

function saleQtyPrice(): Built {
  const item = pick(SALE_ITEMS);
  const qty = pick([2, 3, 5, 10, 12, 20, 25, 30, 50]);
  const price = pick(item.price);
  const pay = pick(PAYMENTS);
  const date = pick(DATES);
  const priceText = spell(price);
  const sep = pick([" x ", "x", " @", " @ ", " kali "]);
  const verb = pick(["jual", "laku", "terjual", "order"]);
  const text = finish([verb, item.name, `${qty}${sep}${priceText}`, pay.text, date.text]);
  const o = baseOracle("sale", `Jual ${item.name}`, pay, date);
  o.items = [{ name: item.name, qty_text: String(qty), unit: null, unit_price_text: priceText, line_total_text: null }];
  return { text, expected: { intent: "transaction", entries: [entryExpected("sale", qty * price, pay, date)] }, oracle: { entries: [o], needs_clarification: [] }, tags: ["sale", "qty_x_price"] };
}

function saleTotal(): Built {
  const item = pick(SALE_ITEMS);
  // A plausible order total for this item: unit price x a typical order size.
  const amount = roundTo(pick(item.price) * (2 + Math.floor(rand() * 39)), 1_000);
  const pay = pick(PAYMENTS);
  const date = pick(DATES);
  const name = chance(0.4) ? pick(NAMES) : null;
  const amountText = spell(amount);
  const shape = pick(["jual", "terima", "pesanan"]);
  const text =
    shape === "jual" ? finish(["jual", item.name, amountText, name ? `ke ${name}` : null, pay.text, date.text])
    : shape === "terima" ? finish(["terima", amountText, name ? `dari ${name}` : null, `buat ${item.name}`, pay.text, date.text])
    : finish(["pesanan", item.name, name ? name : null, amountText, pay.text, date.text]);
  const o = baseOracle("sale", `Jual ${item.name}`, pay, date);
  o.amount_text = amountText;
  o.counterparty = name;
  return { text, expected: { intent: "transaction", entries: [entryExpected("sale", amount, pay, date)] }, oracle: { entries: [o], needs_clarification: [] }, tags: ["sale", "total", ...(name ? ["counterparty"] : [])] };
}

function expenseSingle(): Built {
  const e = pick(EXPENSES);
  const verb = pick(e.verb);
  const what = pick(e.what);
  const amount = randomAmount(e.range[0], e.range[1]);
  const pay = pick(PAYMENTS);
  const date = pick(DATES);
  const amountText = spell(amount);
  const dateFirst = chance(0.5);
  const text = finish([dateFirst ? date.text : null, verb, what, amountText, pay.text, dateFirst ? null : date.text]);
  const o = baseOracle("expense", cap(`${verb} ${what}`), pay, date);
  o.amount_text = amountText;
  return { text, expected: { intent: "transaction", entries: [entryExpected("expense", amount, pay, date)] }, oracle: { entries: [o], needs_clarification: [] }, tags: ["expense"] };
}

function expenseMulti(): Built {
  const pool = ["ayam", "beras", "telur", "minyak", "gula", "tepung", "sayur", "cabe", "bawang"];
  const a = pick(pool);
  let b = pick(pool);
  while (b === a) b = pick(pool);
  const n1 = randomAmount(15_000, 300_000);
  const n2 = randomAmount(10_000, 150_000);
  const pay = pick(PAYMENTS.filter((p) => p.text));
  const date = pick(DATES);
  const t1 = spell(n1);
  const t2 = spell(n2);
  const text = finish([date.text, "belanja", `${a} ${t1},`, `${b} ${t2}`, pay.text]);
  const o = baseOracle("expense", "Belanja bahan", pay, date);
  o.items = [
    { name: a, qty_text: null, unit: null, unit_price_text: null, line_total_text: t1 },
    { name: b, qty_text: null, unit: null, unit_price_text: null, line_total_text: t2 },
  ];
  return { text, expected: { intent: "transaction", entries: [entryExpected("expense", n1 + n2, pay, date)] }, oracle: { entries: [o], needs_clarification: [] }, tags: ["expense", "multi_item"] };
}

function owner(): Built {
  const capital = chance(0.5);
  const amount = randomAmount(100_000, 5_000_000);
  const pay = pick(PAYMENTS.filter((p) => p.text));
  const date = pick(DATES);
  const amountText = spell(amount);
  const text = capital
    ? finish([pick(["nambah modal", "tambah modal", "setor modal"]), amountText, pay.text, date.text])
    : finish(["ambil", amountText, pick(["buat pribadi", "buat jajan anak", "buat keperluan rumah", "prive"]), pay.text, date.text]);
  const kind = capital ? "owner_capital" : "owner_drawing";
  const o = baseOracle(kind, capital ? "Tambah modal" : "Ambil pribadi", pay, date);
  o.amount_text = amountText;
  return { text, expected: { intent: "transaction", entries: [entryExpected(kind, amount, pay, date)] }, oracle: { entries: [o], needs_clarification: [] }, tags: [kind] };
}

const TEMPLATES: Array<[number, () => Built]> = [
  [0.25, saleQtyPrice],
  [0.25, saleTotal],
  [0.3, expenseSingle],
  [0.1, expenseMulti],
  [0.1, owner],
];

function generateOne(): Built {
  let r = rand();
  for (const [w, fn] of TEMPLATES) {
    if ((r -= w) <= 0) return fn();
  }
  return TEMPLATES[0]![1]();
}

// --- assemble ----------------------------------------------------------------
const cases: TextCase[] = [];
const seen = new Set<string>();
const TOTAL_GENERATED_TX = 300 - HANDWRITTEN.length;
while (cases.length < TOTAL_GENERATED_TX) {
  const b = generateOne();
  if (seen.has(b.text.toLowerCase())) continue;
  seen.add(b.text.toLowerCase());
  cases.push({ id: `gen-${String(cases.length + 1).padStart(3, "0")}`, today: TODAY, ...b, tags: ["synthetic", ...b.tags] });
}
for (const h of HANDWRITTEN) cases.push({ today: TODAY, ...h, tags: ["handwritten", ...h.tags] });

const out = fileURLToPath(new URL("../datasets/text.jsonl", import.meta.url));
writeFileSync(out, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.log(`wrote ${cases.length} cases to ${out}`);
