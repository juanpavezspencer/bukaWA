import { eq } from "drizzle-orm";
import { auditLog, businesses, decryptPii, dueErasures, eraseBusiness, erasureRequests, withBusiness, type Db, type PiiKeys, type Tx } from "@bukuwa/db";
import { generateDataExport, type LinkSigner } from "@bukuwa/reports";
import type { OutboundMessage } from "@bukuwa/wa";
import type { MediaStore } from "./media/store.js";

/*
 * UU PDP rights over WhatsApp (spec 8.3: data export and deletion on request).
 *   "ekspor data"  -> an Excel file with everything kept, via a signed link
 *   "hapus data"   -> confirm buttons; on yes, an export link and a request
 *                     that erases everything after the grace period
 *   "batal hapus"  -> cancels a pending request
 * The erasure itself is erase_business(), run by the worker's erasure tick.
 */

export type PrivacyRequest = "export" | "erase" | "cancel_erase";

export interface PrivacyDeps {
  links: LinkSigner;
  reportLinkTtlMinutes: number;
  /** Days between confirmation and erasure (config). */
  graceDays: number;
}

export const ERASE_YES = "privacy:erase_yes";
export const ERASE_NO = "privacy:erase_no";

const EXPORT = /^(?:tolong\s+)?(?:ekspor|export|unduh|download)\s+(?:semua\s+)?data(?:\s+(?:saya|aku|ku|usaha))?\s*[.!?]*$/i;
const ERASE = /^(?:tolong\s+)?(?:hapus|delete)\s+(?:semua\s+)?(?:data|akun)(?:\s+(?:saya|aku|ku|usaha))?\s*[.!?]*$/i;
const CANCEL = /^(?:batal(?:kan)?\s+hapus(?:\s+data)?|jangan\s+(?:jadi\s+)?hapus(?:\s+data)?)\s*[.!?]*$/i;

export function parsePrivacyRequest(text: string): PrivacyRequest | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (CANCEL.test(t)) return "cancel_erase";
  if (EXPORT.test(t)) return "export";
  if (ERASE.test(t)) return "erase";
  return null;
}

export function parsePrivacyReply(replyId: string | undefined): "erase_yes" | "erase_no" | null {
  return replyId === ERASE_YES ? "erase_yes" : replyId === ERASE_NO ? "erase_no" : null;
}

const dateId = (d: Date, timeZone: string) => new Intl.DateTimeFormat("id-ID", { timeZone, day: "numeric", month: "long", year: "numeric" }).format(d);

interface Ctx {
  businessId: string;
  userId: string;
  now: Date;
  timezone: string;
}

async function exportLink(tx: Tx, keys: PiiKeys, d: PrivacyDeps, ctx: Ctx): Promise<string> {
  const g = await generateDataExport(tx, ctx.businessId, {
    now: ctx.now,
    actor: ctx.userId,
    createdBy: ctx.userId,
    decryptPhone: (enc) => decryptPii(keys, enc),
  });
  return d.links.reportUrl(ctx.businessId, g.reportId, ctx.now);
}

export async function handlePrivacyRequest(tx: Tx, keys: PiiKeys, d: PrivacyDeps, ctx: Ctx, req: PrivacyRequest): Promise<OutboundMessage[]> {
  if (req === "export") {
    const url = await exportLink(tx, keys, d, ctx);
    return [
      {
        kind: "text",
        body:
          `Ini semua data usaha kamu dalam satu file Excel 📦\n${url}\n\n` +
          `Isinya jurnal lengkap, kontak, riwayat chat, catatan dari foto/voice note, dan riwayat persetujuan. Link berlaku ${d.reportLinkTtlMinutes} menit; ketik "ekspor data" lagi kalau sudah mati.`,
      },
    ];
  }
  const [pending] = await tx.select().from(erasureRequests).where(eq(erasureRequests.businessId, ctx.businessId));
  const active = pending && !pending.cancelledAt ? pending : undefined;
  if (req === "cancel_erase") {
    if (!active) return [{ kind: "text", body: "Nggak ada permintaan hapus data yang aktif kok. Data kamu aman. 🙏" }];
    await tx.update(erasureRequests).set({ cancelledAt: ctx.now }).where(eq(erasureRequests.businessId, ctx.businessId));
    await tx.insert(auditLog).values({ businessId: ctx.businessId, actor: ctx.userId, action: "privacy.erasure_cancelled", entity: "business", entityId: ctx.businessId });
    return [{ kind: "text", body: "Oke, permintaan hapus data dibatalkan. Pembukuan jalan terus seperti biasa. 👍" }];
  }
  if (active) {
    return [
      {
        kind: "text",
        body: `Permintaan hapus data kamu sudah tercatat. Semua data akan dihapus permanen pada ${dateId(active.scheduledFor, ctx.timezone)}. Ketik "batal hapus" kalau berubah pikiran.`,
      },
    ];
  }
  return [
    {
      kind: "buttons",
      body:
        "Yakin mau hapus semua data? ⚠️\n\n" +
        `Semua pembukuan, kontak, foto nota, riwayat chat dan laporan akan dihapus permanen ${d.graceDays} hari lagi dan nggak bisa dikembalikan. ` +
        "Sebelum itu aku kirim file Excel berisi semua data kamu untuk disimpan sendiri.\n\n" +
        "Catatan: kalau kamu wajib pajak, simpan file itu. Pembukuan biasanya perlu disimpan bertahun-tahun.",
      buttons: [
        { id: ERASE_YES, title: "Ya, hapus" },
        { id: ERASE_NO, title: "Batal" },
      ],
    },
  ];
}

export async function handlePrivacyReply(tx: Tx, keys: PiiKeys, d: PrivacyDeps, ctx: Ctx, reply: "erase_yes" | "erase_no"): Promise<OutboundMessage[]> {
  if (reply === "erase_no") return [{ kind: "text", body: "Oke, nggak jadi. Data kamu tetap aman. 👍" }];
  const scheduledFor = new Date(ctx.now.getTime() + d.graceDays * 86_400_000);
  const [existing] = await tx.select().from(erasureRequests).where(eq(erasureRequests.businessId, ctx.businessId));
  if (existing && !existing.cancelledAt) {
    // Double tap: keep the first date.
    return [{ kind: "text", body: `Sudah tercatat ya. Data akan dihapus pada ${dateId(existing.scheduledFor, ctx.timezone)}.` }];
  }
  if (existing) {
    await tx.update(erasureRequests).set({ requestedAt: ctx.now, scheduledFor, cancelledAt: null }).where(eq(erasureRequests.businessId, ctx.businessId));
  } else {
    await tx.insert(erasureRequests).values({ businessId: ctx.businessId, requestedAt: ctx.now, scheduledFor });
  }
  await tx.insert(auditLog).values({
    businessId: ctx.businessId,
    actor: ctx.userId,
    action: "privacy.erasure_requested",
    entity: "business",
    entityId: ctx.businessId,
    after: { scheduledFor: scheduledFor.toISOString() },
  });
  const url = await exportLink(tx, keys, d, ctx);
  return [
    {
      kind: "text",
      body:
        `Permintaan hapus data diterima. Semua data akan dihapus permanen pada ${dateId(scheduledFor, ctx.timezone)}.\n\n` +
        `Simpan dulu salinan datanya (link berlaku ${d.reportLinkTtlMinutes} menit; ketik "ekspor data" untuk link baru):\n${url}\n\n` +
        'Berubah pikiran? Ketik "batal hapus" sebelum tanggal itu.',
    },
  ];
}

/**
 * Erasure tick: for every due request, delete the stored media, then every
 * row (erase_business). No message goes out afterwards: the owner was told
 * the date, and there is nothing left to send from.
 */
export async function runDueErasures(
  deps: { db: Db; keys: PiiKeys; media?: { store: MediaStore }; log?: (e: Record<string, unknown>) => void },
  now: Date,
): Promise<{ erased: number }> {
  const log = deps.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify(e)));
  let erased = 0;
  for (const businessId of await dueErasures(deps.db, now)) {
    const target = await withBusiness(deps.db, businessId, async (tx) => {
      const [b] = await tx.select({ phone: businesses.ownerPhoneEnc }).from(businesses);
      return b ? { phone: decryptPii(deps.keys, b.phone) } : null;
    });
    if (!target) continue;
    try {
      // Media first: if the row delete fails, the next tick retries both.
      await deps.media?.store.removeBusiness(businessId);
      const counts = await eraseBusiness(deps.db, businessId, target.phone, now);
      erased++;
      log({ level: "info", event: "privacy.erased", businessId, counts });
    } catch (err) {
      log({ level: "error", event: "privacy.erase_failed", businessId, error: (err as Error).message });
    }
  }
  return { erased };
}
