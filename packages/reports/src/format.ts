import { formatRupiah } from "@bukuwa/idn";
import { formatRate } from "@bukuwa/tax";

export const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export const rp = formatRupiah;
export { formatRate };

/** "2026-10" -> "Oktober 2026". */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** "2026-11-16" -> "16 Nov 2026". */
export function dateLabel(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${SHORT[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/** User-facing tax disclaimer (spec 8.1): on every tax screen, message and report. */
export const TAX_DISCLAIMER = "Ini perkiraan, bukan nasihat pajak. Cek lagi dengan konsultan pajak sebelum bayar dan lapor.";

export const EVIDENCE_LABEL = { photo: "Foto/PDF", voice: "Voice note", text: "Chat" } as const;

export function reportFileName(businessName: string, month: string, ext: "pdf" | "xlsx"): string {
  const slug = businessName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "usaha";
  return `laporan-${slug}-${month}.${ext}`;
}
