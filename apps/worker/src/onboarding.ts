import { formatRupiah, parseRupiah } from "@bukuwa/idn";
import type { InboundInput, OutboundMessage } from "@bukuwa/wa";

/*
 * F1 WhatsApp onboarding as a pure state machine: (state, input) -> (state, replies).
 * Order: consent first (UU PDP: no personal data is kept before the owner agrees),
 * then business name, type, opening cash, and a confirm card. Nothing is created
 * until the owner confirms the summary.
 */

export type BusinessType = "fnb" | "fashion" | "retail" | "other";

export interface OnboardingState {
  step: "new" | "awaiting_consent" | "declined" | "awaiting_name" | "awaiting_type" | "awaiting_cash" | "awaiting_confirm" | "done";
  consentAt?: string;
  name?: string;
  type?: BusinessType;
  /** Integer rupiah as a decimal string (state is stored as JSON). */
  openingCash?: string;
}

export interface OnboardingResult {
  state: OnboardingState;
  replies: OutboundMessage[];
  /** Present once the owner confirmed: the caller creates the business. */
  complete?: { name: string; type: BusinessType; openingCash: bigint; consentAt: string };
}

export interface OnboardingOptions {
  privacyPolicyUrl: string;
  now?: () => Date;
}

const TYPES: Array<{ id: BusinessType; title: string; keywords: RegExp }> = [
  { id: "fnb", title: "Makanan & minuman", keywords: /makan|minum|kuliner|catering|katering|f&b|fnb|kue|nasi|kopi/ },
  { id: "fashion", title: "Fashion", keywords: /fashion|baju|pakaian|hijab|jilbab|sepatu|tas/ },
  { id: "retail", title: "Toko / warung", keywords: /toko|warung|kelontong|sembako|retail/ },
  { id: "other", title: "Lainnya", keywords: /lain|jasa|other/ },
];

const MAX_NAME = 80;

const YES = /^(ya|iya|iyaa|y|yes|ok|oke|okay|setuju|boleh|siap|lanjut)\b/i;
const NO = /^(tidak|nggak|ngga|gak|ga|enggak|no|tolak|batal)\b/i;

function consentCard(opts: OnboardingOptions, greet: boolean): OutboundMessage {
  const intro = greet
    ? "Halo! 👋 Aku BukuWA, asisten pembukuan usaha kamu di WhatsApp. Kirim nota, foto transfer, voice note, atau chat biasa, nanti aku yang catat.\n\n"
    : "";
  return {
    kind: "buttons",
    body:
      intro +
      "Sebelum mulai, aku perlu izin kamu untuk menyimpan dan memproses data usaha kamu (nomor WA, transaksi, foto nota). " +
      `Data disimpan di Indonesia dan tidak dijual ke siapa pun. Kebijakan privasi lengkap: ${opts.privacyPolicyUrl}\n\n` +
      "Kamu setuju?",
    buttons: [
      { id: "consent_yes", title: "Setuju" },
      { id: "consent_no", title: "Tidak" },
    ],
  };
}

const askName: OutboundMessage = { kind: "text", body: "Sip, makasih! 🙏 Nama usaha kamu apa?" };
const askNameAgain: OutboundMessage = {
  kind: "text",
  body: `Tulis nama usahanya ya (maksimal ${MAX_NAME} huruf). Contoh: Catering Bu Rina`,
};

const askType = (name: string): OutboundMessage => ({
  kind: "list",
  body: `${name}, mantap! Usahanya di bidang apa?`,
  buttonText: "Pilih jenis usaha",
  rows: TYPES.map((t) => ({ id: `type_${t.id}`, title: t.title })),
});

const askCash: OutboundMessage = {
  kind: "text",
  body: "Oke! Terakhir: berapa uang kas usaha kamu sekarang? Ini jadi saldo awal pembukuan. Contoh: 500rb, 2jt, atau 0 kalau belum ada.",
};
const askCashAgain: OutboundMessage = {
  kind: "text",
  body: "Maaf, aku belum nangkep jumlahnya. Tulis angkanya aja ya, contoh: 500rb, 1,5jt, atau 750000.",
};

function typeTitle(t: BusinessType): string {
  return TYPES.find((x) => x.id === t)!.title;
}

function confirmCard(s: OnboardingState): OutboundMessage {
  return {
    kind: "buttons",
    body:
      "Cek dulu ya:\n" +
      `• Nama usaha: ${s.name}\n` +
      `• Jenis: ${typeTitle(s.type!)}\n` +
      `• Kas awal: ${formatRupiah(BigInt(s.openingCash!))}\n\n` +
      "Sudah benar?",
    buttons: [
      { id: "confirm_ok", title: "OK, benar" },
      { id: "confirm_edit", title: "Ubah" },
    ],
  };
}

function welcome(name: string, cash: bigint): OutboundMessage {
  const cashLine = cash > 0n ? ` Saldo kas awal ${formatRupiah(cash)} sudah aku catat.` : "";
  return {
    kind: "text",
    body:
      `Selesai! 🎉 Pembukuan ${name} sudah aktif.${cashLine}\n\n` +
      "Mulai sekarang tinggal kirim transaksi, misalnya:\n" +
      "• jual nasi box 25 x 18rb transfer BCA\n" +
      "• belanja ayam 175rb cash\n" +
      "• foto nota atau bukti transfer\n\n" +
      "Aku selalu tanya konfirmasi dulu sebelum mencatat.",
  };
}

function parseType(input: InboundInput): BusinessType | undefined {
  if (input.replyId?.startsWith("type_")) {
    const id = input.replyId.slice(5);
    return TYPES.find((t) => t.id === id)?.id;
  }
  const text = input.text?.trim().toLowerCase() ?? "";
  if (!text) return undefined;
  const n = Number(text);
  if (Number.isInteger(n) && n >= 1 && n <= TYPES.length) return TYPES[n - 1]!.id;
  return TYPES.find((t) => t.keywords.test(text))?.id;
}

export function onboardingStep(state: OnboardingState, input: InboundInput, opts: OnboardingOptions): OnboardingResult {
  const now = opts.now ?? (() => new Date());
  const text = input.text?.trim() ?? "";

  switch (state.step) {
    case "new":
    case "declined":
    case "done":
      return { state: { step: "awaiting_consent" }, replies: [consentCard(opts, true)] };

    case "awaiting_consent": {
      const yes = input.replyId === "consent_yes" || (!input.replyId && YES.test(text));
      const no = input.replyId === "consent_no" || (!input.replyId && NO.test(text));
      if (yes) {
        return { state: { step: "awaiting_name", consentAt: now().toISOString() }, replies: [askName] };
      }
      if (no) {
        return {
          state: { step: "declined" },
          replies: [
            {
              kind: "text",
              body: "Oke, nggak apa-apa. Tanpa izin itu aku belum bisa bantu mencatat. Kalau berubah pikiran, kirim pesan apa aja ya. 🙏",
            },
          ],
        };
      }
      return { state, replies: [consentCard(opts, false)] };
    }

    case "awaiting_name": {
      const name = text.replace(/\s+/g, " ");
      if (input.replyId || name.length < 2 || name.length > MAX_NAME) return { state, replies: [askNameAgain] };
      return { state: { ...state, step: "awaiting_type", name }, replies: [askType(name)] };
    }

    case "awaiting_type": {
      const type = parseType(input);
      if (!type) return { state, replies: [askType(state.name!)] };
      return { state: { ...state, step: "awaiting_cash", type }, replies: [askCash] };
    }

    case "awaiting_cash": {
      const cash = input.replyId ? null : parseRupiah(text);
      if (cash === null) return { state, replies: [askCashAgain] };
      const next: OnboardingState = { ...state, step: "awaiting_confirm", openingCash: cash.toString() };
      return { state: next, replies: [confirmCard(next)] };
    }

    case "awaiting_confirm": {
      const ok = input.replyId === "confirm_ok" || (!input.replyId && /^(ok|oke|ya|iya|benar|betul|sip|lanjut)\b/i.test(text));
      const edit = input.replyId === "confirm_edit" || (!input.replyId && /^(ubah|ganti|salah|edit)\b/i.test(text));
      if (ok) {
        const cash = BigInt(state.openingCash!);
        return {
          state: { ...state, step: "done" },
          replies: [welcome(state.name!, cash)],
          complete: { name: state.name!, type: state.type!, openingCash: cash, consentAt: state.consentAt! },
        };
      }
      if (edit) {
        return { state: { step: "awaiting_name", consentAt: state.consentAt }, replies: [{ kind: "text", body: "Oke, kita ulang ya. Nama usaha kamu apa?" }] };
      }
      return { state, replies: [confirmCard(state)] };
    }
  }
}
