/**
 * Payment method from free text, in the extraction schema's format:
 * "cash" | "bank:<Name>" | "ewallet:<Name>" | "qris". Returns null when the
 * text doesn't say, so the caller can ask instead of guessing.
 */

const BANKS: Array<[RegExp, string]> = [
  [/\bbca\b/, "BCA"],
  [/\bbri\b/, "BRI"],
  [/\bbni\b/, "BNI"],
  [/\bmandiri\b/, "Mandiri"],
  [/\bbsi\b/, "BSI"],
  [/\bcimb( niaga)?\b/, "CIMB"],
  [/\bpermata\b/, "Permata"],
  [/\bbtn\b/, "BTN"],
  [/\b(bank )?jago\b/, "Jago"],
  [/\bsea ?bank\b/, "SeaBank"],
  [/\bblu\b/, "blu"],
  [/\bdanamon\b/, "Danamon"],
];

// "dana" is also an ordinary word ("dana darurat"); only accept it as the
// e-wallet when it stands alone or follows a payment verb.
const PAY_VERB = "(?:via|pake|pakai|lewat|bayar|ke|tf|transfer|trf|saldo|dari|masuk)";

const EWALLETS: Array<[RegExp, string]> = [
  [/\bgo-?pay\b/, "GoPay"],
  [/\bovo\b/, "OVO"],
  [new RegExp(`(^dana$|\\b${PAY_VERB} dana\\b)`), "DANA"],
  [/\b(shopee ?pay|spay)\b/, "ShopeePay"],
  [/\blink ?aja\b/, "LinkAja"],
];

export function parsePaymentMethod(input: string): string | null {
  const s = input.toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return null;

  if (/\b(qris|scan qr|qr ?code|qr)\b/.test(s)) return "qris";
  for (const [re, name] of EWALLETS) if (re.test(s)) return `ewallet:${name}`;
  for (const [re, name] of BANKS) if (re.test(s)) return `bank:${name}`;
  if (/\b(cash|tunai|kontan|cas|kes)\b/.test(s)) return "cash";
  if (/\b(transfer|tf|trf|trnsfr|m-?banking|rekening|rek)\b/.test(s)) return "bank:other";
  return null;
}
