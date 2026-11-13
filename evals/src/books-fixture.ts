/**
 * A deterministic ten weeks of books for one small catering business, used by
 * the question eval set. Both the generator (expected answers) and the runner
 * (posting into an in-memory database) build it from the same seed.
 */
import type { EntryKind } from "@bukuwa/ledger";

export const FIXTURE_TODAY = "2026-11-12"; // Thursday
export const FIXTURE_BUSINESS = "Catering Bu Rina";
const START = "2026-09-01";

export interface FixtureEntry {
  key: string;
  kind: Extract<EntryKind, "sale" | "expense" | "owner_capital" | "owner_drawing" | "receivable" | "payable" | "settlement">;
  amountIdr: number;
  date: string;
  description: string;
  /** Category for sales and expenses (and credit sales and purchases). */
  accountCode?: string;
  /** Settlement only. */
  settles?: "receivable" | "payable";
  /** null for debts on credit. */
  paymentMethod: string | null;
  counterparty?: string;
  /** Posted, then cancelled with a reversal. */
  cancelled?: boolean;
}

export const CATEGORY_BY_CODE: Record<string, string> = {
  "4100": "Penjualan",
  "5100": "HPP / Bahan baku",
  "6100": "Gaji",
  "6200": "Sewa",
  "6300": "Listrik & air",
  "6400": "Transport & ongkir",
  "6500": "Iklan & marketing",
};

export function buildFixture(): FixtureEntry[] {
  let seed = 7_771_112;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const between = (lo: number, hi: number, step: number) => Math.round((lo + rand() * (hi - lo)) / step) * step;

  const out: FixtureEntry[] = [];
  let n = 0;
  const add = (e: Omit<FixtureEntry, "key">) => out.push({ key: `e${String(++n).padStart(3, "0")}`, ...e });

  add({ kind: "owner_capital", amountIdr: 5_000_000, date: START, description: "Modal awal", paymentMethod: "bank:BCA" });

  const day0 = Date.UTC(2026, 8, 1);
  const end = Date.UTC(2026, 10, 12);
  for (let t = day0; t <= end; t += 86_400_000) {
    const d = new Date(t);
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const dom = d.getUTCDate();

    if (dom === 1) add({ kind: "expense", amountIdr: 1_500_000, date, description: "Bayar sewa dapur", accountCode: "6200", paymentMethod: "bank:BCA" });
    if (dom === 5) add({ kind: "expense", amountIdr: between(280_000, 420_000, 5_000), date, description: "Bayar listrik", accountCode: "6300", paymentMethod: "bank:BCA" });

    const sales = dow === 0 ? 1 : 2 + Math.floor(rand() * 3);
    for (let i = 0; i < sales; i++) {
      const item = pick([
        { name: "nasi box", price: [18_000, 20_000, 25_000], qty: [10, 20, 25, 30, 50] },
        { name: "kue lapis", price: [3_000, 5_000], qty: [20, 30, 50] },
        { name: "tumpeng mini", price: [150_000, 250_000], qty: [1, 2] },
      ]);
      const counterparty = rand() < 0.4 ? pick(["Bu Sari", "Pak Budi", "Mbak Dewi", "Bu Ani", "Pak Joko"]) : undefined;
      add({
        kind: "sale",
        amountIdr: pick(item.price) * pick(item.qty),
        date,
        description: `Jual ${item.name}`,
        accountCode: "4100",
        paymentMethod: pick(["cash", "cash", "bank:BCA", "qris", "ewallet:GoPay"]),
        counterparty,
      });
    }
    if (dow !== 0) {
      const what = pick(["ayam", "beras", "sayur", "telur", "minyak goreng", "bumbu"]);
      add({ kind: "expense", amountIdr: between(80_000, 450_000, 1_000), date, description: `Belanja ${what}`, accountCode: "5100", paymentMethod: "cash", counterparty: rand() < 0.3 ? "Pasar Kosambi" : undefined });
    }
    if (rand() < 0.3) add({ kind: "expense", amountIdr: between(15_000, 60_000, 1_000), date, description: "Ongkir gojek", accountCode: "6400", paymentMethod: "ewallet:GoPay" });
    if (dow === 6) add({ kind: "expense", amountIdr: 700_000, date, description: "Gaji mingguan Mbak Yuni", accountCode: "6100", paymentMethod: "cash" });
    if (dow === 3 && rand() < 0.5) add({ kind: "expense", amountIdr: between(50_000, 200_000, 10_000), date, description: "Iklan instagram", accountCode: "6500", paymentMethod: "bank:BCA" });
    if (dow === 5) add({ kind: "owner_drawing", amountIdr: between(200_000, 600_000, 50_000), date, description: "Ambil buat keperluan rumah", paymentMethod: "cash" });
  }

  // Receivables and payables (F8), kept off the customers other questions ask
  // about and out of yesterday/today/this week, so those answers stay simple.
  add({ kind: "receivable", amountIdr: 600_000, date: "2026-10-14", description: "Nasi box pengajian", accountCode: "4100", paymentMethod: null, counterparty: "Bu Rahma" });
  add({ kind: "settlement", settles: "receivable", amountIdr: 250_000, date: "2026-10-21", description: "Cicilan Bu Rahma", paymentMethod: "cash", counterparty: "Bu Rahma" });
  add({ kind: "receivable", amountIdr: 450_000, date: "2026-11-03", description: "Tumpeng ulang tahun", accountCode: "4100", paymentMethod: null, counterparty: "Bu Rahma" });
  add({ kind: "receivable", amountIdr: 1_200_000, date: "2026-10-28", description: "Snack rapat", accountCode: "4100", paymentMethod: null, counterparty: "Kantor Kelurahan" });
  add({ kind: "settlement", settles: "receivable", amountIdr: 1_200_000, date: "2026-11-04", description: "Pelunasan kelurahan", paymentMethod: "bank:BCA", counterparty: "Kantor Kelurahan" });
  add({ kind: "receivable", amountIdr: 375_000, date: "2026-11-05", description: "Nasi box arisan", accountCode: "4100", paymentMethod: null, counterparty: "Pak Hendra" });
  add({ kind: "payable", amountIdr: 1_500_000, date: "2026-10-20", description: "Beras 5 karung", accountCode: "5100", paymentMethod: null, counterparty: "Toko Sumber Rejeki" });
  add({ kind: "settlement", settles: "payable", amountIdr: 500_000, date: "2026-10-27", description: "Cicil utang beras", paymentMethod: "bank:BCA", counterparty: "Toko Sumber Rejeki" });
  add({ kind: "payable", amountIdr: 320_000, date: "2026-11-02", description: "Gas elpiji", accountCode: "5100", paymentMethod: null, counterparty: "Agen Gas Pak Tono" });

  // A mistake the owner already cancelled this month: must not count anywhere.
  add({ kind: "expense", amountIdr: 4_500_000, date: "2026-11-06", description: "Belanja ayam (salah input)", accountCode: "5100", paymentMethod: "cash", cancelled: true });
  // Today's last entries, the targets of "yang tadi salah" corrections.
  add({ kind: "expense", amountIdr: 450_000, date: FIXTURE_TODAY, description: "Belanja daging", accountCode: "5100", paymentMethod: "cash", counterparty: "Pak Harun" });
  return out;
}
