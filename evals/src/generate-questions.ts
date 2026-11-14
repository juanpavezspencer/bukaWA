/**
 * Generates evals/datasets/questions.jsonl: 100 owner questions and
 * corrections about the fixture books (books-fixture.ts), with expected
 * answers (spec 7.5: "100 questions with expected answers").
 *
 * Expected amounts are computed here with plain arithmetic over the fixture
 * entries, independently of the ledger's report queries, so the set checks
 * those queries too.
 *
 * SYNTHETIC v0: replace with real owner questions as the pilot runs.
 *
 *   pnpm --filter @bukuwa/evals generate:questions
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolvePeriod, type PeriodPreset } from "@bukuwa/idn";
import { buildFixture, CATEGORY_BY_CODE, FIXTURE_TODAY, type FixtureEntry } from "./books-fixture.js";
import type { QuestionCase } from "./types.js";

const entries = buildFixture();
const active = entries.filter((e) => !e.cancelled);
const rp = (n: number) => `Rp ${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

function inPeriod(e: FixtureEntry, p: PeriodPreset) {
  const r = resolvePeriod(p, FIXTURE_TODAY);
  return e.date >= r.from && e.date <= r.to;
}
const sum = (xs: FixtureEntry[]) => xs.reduce((s, e) => s + e.amountIdr, 0);
// Accrual: credit sales and purchases count when made, not when paid.
const isIncome = (e: FixtureEntry) => e.kind === "sale" || e.kind === "receivable";
const isExpense = (e: FixtureEntry) => e.kind === "expense" || e.kind === "payable";
const income = (p: PeriodPreset) => sum(active.filter((e) => isIncome(e) && inPeriod(e, p)));
const expense = (p: PeriodPreset) => sum(active.filter((e) => isExpense(e) && inPeriod(e, p)));
const byCategory = (p: PeriodPreset, code: string) => sum(active.filter((e) => e.accountCode === code && isExpense(e) && inPeriod(e, p)));

const P = (preset: PeriodPreset) => ({ preset, from: null, to: null });

const cases: QuestionCase[] = [];
let n = 0;
function add(c: Omit<QuestionCase, "id" | "today">) {
  cases.push({ id: `q-${String(++n).padStart(3, "0")}`, today: FIXTURE_TODAY, ...c });
}

// --- profit / income / expenses per period ------------------------------------
const PERIODS: Array<[PeriodPreset, string[]]> = [
  ["today", ["hari ini"]],
  ["yesterday", ["kemarin", "kmrn"]],
  ["this_week", ["minggu ini", "pekan ini"]],
  ["last_week", ["minggu lalu", "minggu kemarin"]],
  ["this_month", ["bulan ini"]],
  ["last_month", ["bulan lalu", "bulan kemarin"]],
  ["last_7_days", ["7 hari terakhir", "seminggu terakhir"]],
  ["last_30_days", ["30 hari terakhir", "sebulan terakhir"]],
  ["this_year", ["tahun ini"]],
];
const METRICS: Array<["profit" | "income" | "expense", string[]]> = [
  ["profit", ["untung", "laba", "keuntungan"]],
  ["income", ["omzet", "pemasukan", "penjualan"]],
  ["expense", ["pengeluaran", "biaya keluar"]],
];
const SHAPES = [
  (m: string, p: string) => `${m} ${p} berapa?`,
  (m: string, p: string) => `berapa ${m} ${p}?`,
  (m: string, p: string) => `cek ${m} ${p} dong`,
  (m: string, p: string) => `${p} ${m}nya dapet berapa ya kak`,
  (m: string, p: string) => `${m.toUpperCase()} ${p.toUpperCase()}?`,
];
let shape = 0;
for (const [preset, pwords] of PERIODS) {
  for (const [metric, mwords] of METRICS) {
    const value = metric === "profit" ? income(preset) - expense(preset) : metric === "income" ? income(preset) : expense(preset);
    for (const pw of pwords.slice(0, 2)) {
      const mw = mwords[shape % mwords.length]!;
      add({
        text: SHAPES[shape++ % SHAPES.length]!(mw, pw),
        expected: { intent: "question", kind: "answer", must_include: [rp(value)] },
        oracle: [{ tool: "get_profit_and_loss", input: { period: P(preset), compare_to: null } }],
        tags: ["profit_and_loss", metric, preset],
      });
    }
  }
}

// --- comparisons ------------------------------------------------------------------
const COMPARE: Array<[PeriodPreset, PeriodPreset, string, "profit" | "income"]> = [
  ["this_month", "last_month", "untung bulan ini dibanding bulan lalu gimana?", "profit"],
  ["this_month", "last_month", "omzet bulan ini naik ga dibanding bulan lalu?", "income"],
  ["this_week", "last_week", "minggu ini lebih untung dari minggu lalu nggak?", "profit"],
  ["this_week", "last_week", "bandingin penjualan minggu ini sama minggu lalu", "income"],
  ["yesterday", "today", "penjualan hari ini vs kemarin?", "income"],
  ["last_month", "this_month", "laba bulan lalu sama bulan ini beda berapa?", "profit"],
];
for (const [a, b, text, metric] of COMPARE) {
  const va = metric === "profit" ? income(a) - expense(a) : income(a);
  const vb = metric === "profit" ? income(b) - expense(b) : income(b);
  add({
    text,
    expected: { intent: "question", kind: "answer", must_include: [rp(va), rp(vb)] },
    oracle: [{ tool: "get_profit_and_loss", input: { period: P(a), compare_to: P(b) } }],
    tags: ["compare", metric],
  });
}

// --- cash position ------------------------------------------------------------------
const money = { Kas: 0, Bank: 0, "E-wallet": 0 } as Record<string, number>;
for (const e of active) {
  if (!e.paymentMethod) continue; // on credit: no money moved
  const acct = e.paymentMethod === "cash" ? "Kas" : e.paymentMethod.startsWith("ewallet:") ? "E-wallet" : "Bank";
  const moneyIn = e.kind === "sale" || e.kind === "owner_capital" || (e.kind === "settlement" && e.settles === "receivable");
  money[acct]! += moneyIn ? e.amountIdr : -e.amountIdr;
}
const total = money.Kas! + money.Bank! + money["E-wallet"]!;
for (const [text, value] of [
  ["saldo kas berapa sekarang?", money.Kas!],
  ["uang tunai di laci harusnya ada berapa?", money.Kas!],
  ["uang di bank ada berapa?", money.Bank!],
  ["saldo rekening bca berapa ya", money.Bank!],
  ["saldo gopay sisa berapa?", money["E-wallet"]!],
  ["total uang usaha sekarang ada berapa?", total],
  ["posisi kas hari ini gimana?", money.Kas!],
  ["duitku semua ada berapa sih", total],
] as const) {
  add({
    text,
    expected: { intent: "question", kind: "answer", must_include: [rp(value)] },
    oracle: [{ tool: "get_cash_position", input: {} }],
    tags: ["cash_position"],
  });
}

// --- spending per category -------------------------------------------------------------
const CATS: Array<[string, PeriodPreset, string]> = [
  ["5100", "this_month", "bulan ini habis berapa buat bahan baku?"],
  ["5100", "last_month", "belanja bahan bulan lalu total berapa?"],
  ["5100", "this_week", "minggu ini belanja bahan berapa?"],
  ["6300", "this_month", "bayar listrik bulan ini berapa?"],
  ["6300", "last_month", "listrik bulan lalu berapa ya?"],
  ["6100", "this_month", "gaji karyawan bulan ini total berapa?"],
  ["6100", "last_month", "bulan lalu bayar gaji berapa?"],
  ["6400", "this_month", "ongkir bulan ini habis berapa?"],
  ["6400", "last_7_days", "biaya ongkir seminggu terakhir?"],
  ["6500", "last_month", "iklan bulan lalu keluar berapa?"],
  ["6500", "this_month", "budget iklan bulan ini kepake berapa?"],
  ["6200", "this_month", "sewa bulan ini udah bayar berapa?"],
];
for (const [code, preset, text] of CATS) {
  add({
    text,
    expected: { intent: "question", kind: "answer", must_include: [rp(byCategory(preset, code))] },
    oracle: [
      {
        tool: "list_transactions",
        input: { period: P(preset), text: null, category: CATEGORY_BY_CODE[code], type: null, include_cancelled: false, limit: null },
      },
    ],
    tags: ["category", code],
  });
}

// --- biggest cost driver -------------------------------------------------------------
for (const [preset, text] of [
  ["this_month", "pengeluaran paling gede bulan ini buat apa?"],
  ["last_month", "bulan lalu biaya terbesar apa?"],
  ["this_week", "minggu ini duit paling banyak keluar buat apa?"],
] as const) {
  const totals = Object.keys(CATEGORY_BY_CODE)
    .filter((c) => c !== "4100")
    .map((c) => [c, byCategory(preset, c)] as const)
    .sort((a, b) => b[1] - a[1]);
  add({
    text,
    expected: { intent: "question", kind: "answer", must_include: [rp(totals[0]![1])] },
    oracle: [{ tool: "get_profit_and_loss", input: { period: P(preset), compare_to: null } }],
    tags: ["top_category"],
  });
}

// --- counts and customers ------------------------------------------------------------------
for (const [preset, text] of [
  ["yesterday", "kemarin ada berapa penjualan? totalnya?"],
  ["today", "hari ini udah laku berapa kali, total berapa?"],
  ["this_week", "total penjualan minggu ini dari berapa transaksi?"],
] as const) {
  add({
    text,
    expected: { intent: "question", kind: "answer", must_include: [rp(income(preset))] },
    oracle: [{ tool: "list_transactions", input: { period: P(preset), text: null, category: null, type: "sale", include_cancelled: false, limit: null } }],
    tags: ["count"],
  });
}
for (const [who, preset, text] of [
  ["Bu Sari", "this_month", "Bu Sari bulan ini pesan total berapa?"],
  ["Pak Budi", "last_month", "pak budi bulan lalu belanja berapa di kita?"],
  ["Mbak Dewi", "this_month", "orderan mbak dewi bulan ini berapa?"],
  ["Bu Ani", "last_month", "bu ani bulan lalu total berapa?"],
  ["Pasar Kosambi", "this_month", "bulan ini belanja di pasar kosambi berapa?"],
] as const) {
  const value = sum(active.filter((e) => e.counterparty === who && inPeriod(e, preset)));
  add({
    text,
    expected: { intent: "question", kind: "answer", must_include: [rp(value)] },
    oracle: [{ tool: "list_transactions", input: { period: P(preset), text: who, category: null, type: null, include_cancelled: false, limit: null } }],
    tags: ["counterparty"],
  });
}

// --- owner drawings and specific items ------------------------------------------------------
const listCase = (text: string, preset: PeriodPreset, value: number, input: { text?: string; type?: string }, tag: string) =>
  add({
    text,
    expected: { intent: "question", kind: "answer", must_include: [rp(value)] },
    oracle: [
      {
        tool: "list_transactions",
        input: { period: P(preset), text: input.text ?? null, category: null, type: input.type ?? null, include_cancelled: false, limit: null },
      },
    ],
    tags: [tag],
  });
const drawings = (p: PeriodPreset) => sum(active.filter((e) => e.kind === "owner_drawing" && inPeriod(e, p)));
const item = (p: PeriodPreset, word: string) => sum(active.filter((e) => e.description.toLowerCase().includes(word) && inPeriod(e, p)));
listCase("bulan ini aku udah ambil uang pribadi berapa?", "this_month", drawings("this_month"), { type: "owner_drawing" }, "drawings");
listCase("prive bulan lalu total berapa?", "last_month", drawings("last_month"), { type: "owner_drawing" }, "drawings");
listCase("bulan ini beli ayam habis berapa?", "this_month", item("this_month", "ayam"), { text: "ayam" }, "item");
listCase("jualan tumpeng bulan lalu dapet berapa?", "last_month", item("last_month", "tumpeng"), { text: "tumpeng" }, "item");

// --- receivables and payables (F8) ----------------------------------------------------------
// Open balance per contact: debts up, settlements down. Independent of the ledger's FIFO matching.
const owedBy = new Map<string, { kind: "receivable" | "payable"; amount: number }>();
for (const e of active) {
  const kind = e.kind === "receivable" || e.kind === "payable" ? e.kind : e.kind === "settlement" ? e.settles! : null;
  if (!kind) continue;
  const cur = owedBy.get(e.counterparty!) ?? { kind, amount: 0 };
  cur.amount += e.kind === "settlement" ? -e.amountIdr : e.amountIdr;
  owedBy.set(e.counterparty!, cur);
}
const owing = (kind: "receivable" | "payable") => [...owedBy].filter(([, v]) => v.kind === kind && v.amount > 0);
const owed = (who: string) => owedBy.get(who)!.amount;
const totalOwed = (kind: "receivable" | "payable") => owing(kind).reduce((s, [, v]) => s + v.amount, 0);
const openCase = (text: string, kind: "receivable" | "payable" | null, contact: string | null, amounts: number[], tag: string) =>
  add({
    text,
    expected: { intent: "question", kind: "answer", must_include: amounts.map(rp) },
    oracle: [{ tool: "get_open_items", input: { kind, contact } }],
    tags: ["open_items", tag],
  });
openCase("siapa aja yang belum bayar?", "receivable", null, [totalOwed("receivable"), ...owing("receivable").map(([, v]) => v.amount)], "who_owes");
openCase("total piutang semua berapa", "receivable", null, [totalOwed("receivable")], "total");
openCase("piutang bu rahma masih berapa?", null, "bu rahma", [owed("Bu Rahma")], "contact");
openCase("pak hendra masih utang berapa ya?", null, "pak hendra", [owed("Pak Hendra")], "contact");
openCase("utang ke supplier totalnya berapa?", "payable", null, [totalOwed("payable")], "total");
openCase("utangku ke toko sumber rejeki sisa berapa?", null, "toko sumber rejeki", [owed("Toko Sumber Rejeki")], "contact");
for (const [text, who] of [
  ["tagih bu rahma dong", "Bu Rahma"],
  ["buatin pesan tagihan buat pak hendra", "Pak Hendra"],
] as const) {
  add({
    text,
    expected: { intent: "question", kind: "reminder", reminder_contact: who, must_include: [rp(owed(who))] },
    oracle: [{ tool: "draft_reminder", input: { contact: who.toLowerCase() } }],
    tags: ["reminder"],
  });
}

// --- tax and reports (F10) ------------------------------------------------------------------
// These two were "not available yet" before milestone 6; they keep their ids (q-095, q-096).
// The fixture's turnover stays under the yearly allowance, so the tax is Rp 0: the answer must
// quote the turnover it came from.
const month = (p: PeriodPreset) => resolvePeriod(p, FIXTURE_TODAY).from.slice(0, 7);
const taxCase = (text: string, preset: "this_month" | "last_month", amounts: number[]) =>
  add({
    text,
    expected: { intent: "question", kind: "answer", must_include: amounts.map(rp) },
    oracle: [{ tool: "get_tax_estimate", input: { period: { preset, month: null } } }],
    tags: ["tax"],
  });
const reportCase = (text: string, preset: "this_month" | "last_month", format: "pdf" | "xlsx") =>
  add({
    text,
    expected: { intent: "question", kind: "report", report: { month: month(preset), format } },
    oracle: [{ tool: "create_report_link", input: { period: { preset, month: null }, format } }],
    tags: ["report"],
  });
taxCase("pajak bulan ini harus bayar berapa?", "this_month", [income("this_month")]);
reportCase("kirimin laporan pdf bulan lalu dong", "last_month", "pdf");

// --- not available yet ---------------------------------------------------------------------
for (const text of [
  "stok ayam tinggal berapa kilo?",
  "bikinin invoice buat bu sari bisa?",
]) {
  add({ text, expected: { intent: "question", kind: "unsupported" }, tags: ["unsupported"] });
}

// --- corrections -----------------------------------------------------------------------------
const latest = (pred: (e: FixtureEntry) => boolean) => [...active].reverse().find(pred)!;
const last = active.at(-1)!;
const listrikNov = latest((e) => e.description === "Bayar listrik" && e.date.startsWith("2026-11"));
const sewaNov = latest((e) => e.description === "Bayar sewa dapur" && e.date.startsWith("2026-11"));
const gajiSat = latest((e) => e.description.startsWith("Gaji") && e.date === "2026-11-07");
const iklan = latest((e) => e.description === "Iklan instagram");
const ongkir = latest((e) => e.description === "Ongkir gojek");
const CORRECTIONS: Array<[string, FixtureEntry, "change" | "cancel", Partial<NonNullable<QuestionCase["expected"]["correction"]>>]> = [
  ["yang tadi salah, harusnya 45rb bukan 450rb", last, "change", { amount_idr: "45000" }],
  ["belanja daging tadi harusnya 405rb", last, "change", { amount_idr: "405000" }],
  ["yang barusan bayarnya transfer bukan cash", last, "change", { payment_code: "1110" }],
  ["hapus yang terakhir", last, "cancel", {}],
  ["yang terakhir batalin aja, salah catat", last, "cancel", {}],
  ["listrik bulan ini salah input, harusnya 350rb", listrikNov, "change", { amount_idr: "350000" }],
  ["sewa bulan ini hapus aja, belum bayar ternyata", sewaNov, "cancel", {}],
  ["gaji mbak yuni sabtu kemarin harusnya 750rb", gajiSat, "change", { amount_idr: "750000" }],
  ["iklan instagram yang terakhir salah, harusnya 100rb", iklan, "change", { amount_idr: "100000" }],
  ["ongkir terakhir hapus ya", ongkir, "cancel", {}],
];
for (const [text, target, action, extra] of CORRECTIONS) {
  add({
    text,
    expected: { intent: "correction", kind: "correction", correction: { entry_key: target.key, action, ...extra } },
    tags: ["correction", action],
  });
}

// Added in milestone 6, after the original cases so earlier ids stay stable.
taxCase("omzet bulan lalu kena pajak berapa?", "last_month", [income("last_month")]);
taxCase("kenapa pajakku bulan ini nol? omzetnya kan ada", "this_month", [income("this_month")]);
reportCase("minta laporan bulan ini versi excel buat akuntanku", "this_month", "xlsx");
reportCase("export laporan keuangan bulan kemarin ke pdf", "last_month", "pdf");

const out = fileURLToPath(new URL("../datasets/questions.jsonl", import.meta.url));
writeFileSync(out, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.log(`wrote ${cases.length} cases to ${out}`);
