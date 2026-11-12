import type { TextCase } from "./types.js";

/*
 * Hand-written cases: harder phrasing than the templates (Javanese/Sundanese
 * words, "@" and "/meter" prices, two transactions in one message, payment
 * methods the bot must ask about) plus non-transaction messages for the router.
 * All names are invented.
 */

type Item = { name: string; qty_text?: string; unit?: string; unit_price_text?: string; line_total_text?: string };
interface E {
  kind: string;
  amount: number;
  pay: string | null;
  date?: string;
  // oracle spans
  description: string;
  amount_text?: string;
  items?: Item[];
  date_text?: string;
  counterparty?: string;
  payment_text?: string;
}

const TODAY = "2026-11-12";

function tx(id: string, text: string, entries: E[], tags: string[] = []): Omit<TextCase, "today"> {
  return {
    id,
    text,
    expected: {
      intent: "transaction",
      entries: entries.map((e) => ({ kind: e.kind, amount_idr: String(e.amount), payment_method: e.pay, date: e.date ?? TODAY })),
    },
    oracle: {
      entries: entries.map((e) => ({
        kind: e.kind as never,
        description: e.description,
        amount_text: e.amount_text ?? null,
        items: (e.items ?? []).map((i) => ({
          name: i.name,
          qty_text: i.qty_text ?? null,
          unit: i.unit ?? null,
          unit_price_text: i.unit_price_text ?? null,
          line_total_text: i.line_total_text ?? null,
        })),
        date_text: e.date_text ?? null,
        counterparty: e.counterparty ?? null,
        payment_text: e.payment_text ?? null,
        suggested_category: null,
      })),
      needs_clarification: [],
    },
    tags,
  };
}

function other(id: string, text: string, intent: string): Omit<TextCase, "today"> {
  return { id, text, expected: { intent }, tags: [intent] };
}

export const HANDWRITTEN: Array<Omit<TextCase, "today">> = [
  tx("hw-001", "jual nasi box 25 x 18rb transfer BCA", [
    { kind: "sale", amount: 450_000, pay: "bank:BCA", description: "Jual nasi box", items: [{ name: "nasi box", qty_text: "25", unit_price_text: "18rb" }], payment_text: "transfer BCA" },
  ], ["spec_example"]),
  tx("hw-002", "tadi belanja ayam 5 kilo 175 ribu, minyak 2 liter 38 ribu, cash", [
    { kind: "expense", amount: 213_000, pay: "cash", description: "Belanja bahan", items: [{ name: "ayam", qty_text: "5", unit: "kilo", line_total_text: "175 ribu" }, { name: "minyak", qty_text: "2", unit: "liter", line_total_text: "38 ribu" }], date_text: "tadi", payment_text: "cash" },
  ], ["spec_example", "multi_item"]),
  tx("hw-003", "Bu Sari bayar pesanan tumpeng 450rb lewat tf bca", [
    { kind: "sale", amount: 450_000, pay: "bank:BCA", description: "Pesanan tumpeng", amount_text: "450rb", counterparty: "Bu Sari", payment_text: "tf bca" },
  ], ["counterparty"]),
  tx("hw-004", "dodol sego 10 bungkus @12rb tunai", [
    { kind: "sale", amount: 120_000, pay: "cash", description: "Jual nasi", items: [{ name: "sego", qty_text: "10", unit: "bungkus", unit_price_text: "12rb" }], payment_text: "tunai" },
  ], ["javanese"]),
  tx("hw-005", "tuku endog 2 kilo 56rb cash", [
    { kind: "expense", amount: 56_000, pay: "cash", description: "Beli telur", items: [{ name: "endog", qty_text: "2", unit: "kilo", line_total_text: "56rb" }], payment_text: "cash" },
  ], ["javanese"]),
  tx("hw-006", "meuli beas 25rb kontan", [
    { kind: "expense", amount: 25_000, pay: "cash", description: "Beli beras", amount_text: "25rb", payment_text: "kontan" },
  ], ["sundanese"]),
  tx("hw-007", "orderan gamis 3 pcs total 525rb via shopeepay", [
    { kind: "sale", amount: 525_000, pay: "ewallet:ShopeePay", description: "Jual gamis", amount_text: "525rb", items: [{ name: "gamis", qty_text: "3", unit: "pcs" }], payment_text: "via shopeepay" },
  ]),
  tx("hw-008", "bayar gaji mbak yuni 1,5jt tf", [
    { kind: "expense", amount: 1_500_000, pay: "bank:other", description: "Gaji", amount_text: "1,5jt", counterparty: "mbak yuni", payment_text: "tf" },
  ]),
  tx("hw-009", "isi gas 3 tabung 66rb cash", [
    { kind: "expense", amount: 66_000, pay: "cash", description: "Isi gas", items: [{ name: "gas", qty_text: "3", unit: "tabung", line_total_text: "66rb" }], payment_text: "cash" },
  ]),
  tx("hw-010", "kemaren laku es teh 40 gelas x 4rb qris", [
    { kind: "sale", amount: 160_000, pay: "qris", date: "2026-11-11", description: "Jual es teh", items: [{ name: "es teh", qty_text: "40", unit: "gelas", unit_price_text: "4rb" }], date_text: "kemaren", payment_text: "qris" },
  ]),
  tx("hw-011", "ongkir jne 2 paket 36rb pake dana", [
    { kind: "expense", amount: 36_000, pay: "ewallet:DANA", description: "Ongkir JNE", items: [{ name: "paket", qty_text: "2", line_total_text: "36rb" }], payment_text: "pake dana" },
  ]),
  tx("hw-012", "terima DP catering 2jt dari Bu Ani transfer mandiri", [
    { kind: "sale", amount: 2_000_000, pay: "bank:Mandiri", description: "DP catering", amount_text: "2jt", counterparty: "Bu Ani", payment_text: "transfer mandiri" },
  ], ["counterparty"]),
  tx("hw-013", "bayar sewa kios bulan ini 1.200.000 tf bri", [
    { kind: "expense", amount: 1_200_000, pay: "bank:BRI", description: "Sewa kios", amount_text: "1.200.000", payment_text: "tf bri" },
  ]),
  tx("hw-014", "beli kain 3 meter 45rb/meter cash", [
    { kind: "expense", amount: 135_000, pay: "cash", description: "Beli kain", items: [{ name: "kain", qty_text: "3", unit: "meter", unit_price_text: "45rb" }], payment_text: "cash" },
  ]),
  tx("hw-015", "listrik token 200k gopay", [
    { kind: "expense", amount: 200_000, pay: "ewallet:GoPay", description: "Token listrik", amount_text: "200k", payment_text: "gopay" },
  ]),
  tx("hw-016", "nambah modal 5 jt dari tabungan, setor ke bca", [
    { kind: "owner_capital", amount: 5_000_000, pay: "bank:BCA", description: "Tambah modal", amount_text: "5 jt", payment_text: "setor ke bca" },
  ]),
  tx("hw-017", "ambil goceng buat parkir pribadi cash", [
    { kind: "owner_drawing", amount: 5_000, pay: "cash", description: "Ambil pribadi", amount_text: "goceng", payment_text: "cash" },
  ], ["slang"]),
  tx("hw-018", "senin jual kue lapis 100 pcs x 2.500 cash", [
    { kind: "sale", amount: 250_000, pay: "cash", date: "2026-11-09", description: "Jual kue lapis", items: [{ name: "kue lapis", qty_text: "100", unit: "pcs", unit_price_text: "2.500" }], date_text: "senin", payment_text: "cash" },
  ]),
  tx("hw-019", "jual hijab 2 @45rb + kaos 1 75rb tf bca", [
    { kind: "sale", amount: 165_000, pay: "bank:BCA", description: "Jual hijab dan kaos", items: [{ name: "hijab", qty_text: "2", unit_price_text: "45rb" }, { name: "kaos", qty_text: "1", line_total_text: "75rb" }], payment_text: "tf bca" },
  ], ["multi_item"]),
  tx("hw-020", "iklan ig 150rb pake kartu", [
    { kind: "expense", amount: 150_000, pay: null, description: "Iklan IG", amount_text: "150rb", payment_text: "pake kartu" },
  ], ["ask_payment"]),
  tx("hw-021", "beli plastik kemasan seceng 20 biji", [
    { kind: "expense", amount: 20_000, pay: null, description: "Beli plastik kemasan", items: [{ name: "plastik kemasan", qty_text: "20", unit: "biji", unit_price_text: "seceng" }] },
  ], ["slang", "ask_payment"]),
  tx("hw-022", "terima pembayaran dari Pak Joko 750.000", [
    { kind: "sale", amount: 750_000, pay: null, description: "Terima pembayaran", amount_text: "750.000", counterparty: "Pak Joko" },
  ], ["ask_payment", "counterparty"]),
  tx("hw-023", "tgl 3 bayar wifi 330rb tf bni", [
    { kind: "expense", amount: 330_000, pay: "bank:BNI", date: "2026-11-03", description: "Bayar wifi", amount_text: "330rb", date_text: "tgl 3", payment_text: "tf bni" },
  ]),
  tx("hw-024", "12/11 jual daster 4 x 65rb cash", [
    { kind: "sale", amount: 260_000, pay: "cash", description: "Jual daster", items: [{ name: "daster", qty_text: "4", unit_price_text: "65rb" }], date_text: "12/11", payment_text: "cash" },
  ]),
  tx("hw-025", "belanja pasar 350rb cash", [
    { kind: "expense", amount: 350_000, pay: "cash", description: "Belanja pasar", amount_text: "350rb", payment_text: "cash" },
  ]),
  tx("hw-026", "dapat orderan 30 box nasi kuning @15rb, dibayar tf bca", [
    { kind: "sale", amount: 450_000, pay: "bank:BCA", description: "Jual nasi kuning", items: [{ name: "nasi kuning", qty_text: "30", unit: "box", unit_price_text: "15rb" }], payment_text: "tf bca" },
  ]),
  tx("hw-027", "gajian 2 karyawan masing2 1jt cash", [
    { kind: "expense", amount: 2_000_000, pay: "cash", description: "Gaji karyawan", items: [{ name: "karyawan", qty_text: "2", unit_price_text: "1jt" }], payment_text: "cash" },
  ]),
  tx("hw-028", "beli bensin 30rb", [
    { kind: "expense", amount: 30_000, pay: null, description: "Beli bensin", amount_text: "30rb" },
  ], ["ask_payment"]),
  tx("hw-029", "ambil 300 ribu buat bayar sekolah anak, dari rek bca", [
    { kind: "owner_drawing", amount: 300_000, pay: "bank:BCA", description: "Ambil pribadi", amount_text: "300 ribu", payment_text: "dari rek bca" },
  ]),
  tx("hw-030", "jual beras 5kg 2 karung @72rb kes", [
    { kind: "sale", amount: 144_000, pay: "cash", description: "Jual beras 5kg", items: [{ name: "beras 5kg", qty_text: "2", unit: "karung", unit_price_text: "72rb" }], payment_text: "kes" },
  ], ["slang"]),
  tx("hw-031", "sumbangan 17an 100rb cash", [
    { kind: "expense", amount: 100_000, pay: "cash", description: "Sumbangan", amount_text: "100rb", payment_text: "cash" },
  ]),
  tx("hw-032", "admin shopee 12.500 potong saldo", [
    { kind: "expense", amount: 12_500, pay: null, description: "Admin Shopee", amount_text: "12.500", payment_text: "potong saldo" },
  ], ["ask_payment"]),
  tx("hw-033", "JUAL AYAM GEPREK 15 PORSI X 15RB CASH", [
    { kind: "sale", amount: 225_000, pay: "cash", description: "Jual ayam geprek", items: [{ name: "ayam geprek", qty_text: "15", unit: "PORSI", unit_price_text: "15RB" }], payment_text: "CASH" },
  ], ["caps"]),
  tx("hw-034", "pesanan tumpeng setengah juta tf bca", [
    { kind: "sale", amount: 500_000, pay: "bank:BCA", description: "Pesanan tumpeng", amount_text: "setengah juta", payment_text: "tf bca" },
  ], ["slang"]),
  tx("hw-035", "td jual 2 gamis 175rb an, cash", [
    { kind: "sale", amount: 350_000, pay: "cash", description: "Jual gamis", items: [{ name: "gamis", qty_text: "2", unit_price_text: "175rb" }], date_text: "td", payment_text: "cash" },
  ]),
  tx("hw-036", "jual kue 200rb cash, beli gula 50rb cash", [
    { kind: "sale", amount: 200_000, pay: "cash", description: "Jual kue", amount_text: "200rb", payment_text: "cash" },
    { kind: "expense", amount: 50_000, pay: "cash", description: "Beli gula", amount_text: "50rb", payment_text: "cash" },
  ], ["two_entries"]),
  tx("hw-037", "modal awal 2jt cash terus belanja bahan 500rb cash", [
    { kind: "owner_capital", amount: 2_000_000, pay: "cash", description: "Modal awal", amount_text: "2jt", payment_text: "cash" },
    { kind: "expense", amount: 500_000, pay: "cash", description: "Belanja bahan", amount_text: "500rb", payment_text: "cash" },
  ], ["two_entries"]),
  tx("hw-038", "bayar utang ke supplier 500rb tf", [
    { kind: "settlement", amount: 500_000, pay: "bank:other", description: "Bayar utang supplier", amount_text: "500rb", counterparty: "supplier", payment_text: "tf" },
  ], ["later_milestone"]),

  other("hw-q01", "untung minggu ini berapa?", "question"),
  other("hw-q02", "bulan ini untung berapa? dibanding bulan lalu?", "question"),
  other("hw-q03", "siapa yg belum bayar?", "question"),
  other("hw-q04", "pengeluaran terbesar bulan ini apa", "question"),
  other("hw-q05", "total penjualan kemarin brp", "question"),
  other("hw-q06", "saldo kas sekarang berapa", "question"),
  other("hw-q07", "pajak bulan ini berapa ya", "question"),
  other("hw-q08", "omzet oktober berapa?", "question"),
  other("hw-q09", "ada piutang yg jatuh tempo?", "question"),
  other("hw-q10", "berapa kali beli ayam bulan ini?", "question"),
  other("hw-c01", "yang tadi salah, harusnya 45rb bukan 450rb", "correction"),
  other("hw-c02", "hapus yg terakhir", "correction"),
  other("hw-c03", "eh tadi salah input", "correction"),
  other("hw-c04", "batalin transaksi td pagi", "correction"),
  other("hw-c05", "yg kemarin jual 300rb itu dobel, hapus satu", "correction"),
  other("hw-m01", "bantuan", "command"),
  other("hw-m02", "menu", "command"),
  other("hw-m03", "kirim laporan bulan ini", "command"),
  other("hw-m04", "ganti jam ringkasan jadi jam 9 malam", "command"),
  other("hw-m05", "help", "command"),
  other("hw-m06", "minta link dashboard", "command"),
  other("hw-m07", "export excel", "command"),
  other("hw-t01", "makasih kak", "chitchat"),
  other("hw-t02", "halo", "chitchat"),
  other("hw-t03", "pagi min", "chitchat"),
  other("hw-t04", "oke siap", "chitchat"),
  other("hw-t05", "wkwk", "chitchat"),
  other("hw-t06", "mantap", "chitchat"),
  other("hw-t07", "terima kasih banyak ya", "chitchat"),
  other("hw-t08", "assalamualaikum", "chitchat"),
  other("hw-t09", "lagi sepi nih", "chitchat"),
  other("hw-u01", "kak bisa buatin logo?", "unsupported"),
  other("hw-u02", "resep rendang gimana", "unsupported"),
  other("hw-u03", "berapa harga emas hari ini", "unsupported"),
  other("hw-u04", "tolong cariin supplier hijab murah", "unsupported"),
  other("hw-u05", "bisa transfer uang ke saya?", "unsupported"),
  other("hw-u06", "cuaca jakarta besok", "unsupported"),
];
