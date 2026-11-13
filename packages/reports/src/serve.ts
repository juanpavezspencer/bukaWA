import { eq } from "drizzle-orm";
import { auditLog, captures, reports, withBusiness, type Db, type MediaStore } from "@bukuwa/db";
import { verifyLink, type LinkKind } from "./links.js";

/*
 * Resolve a signed link to the file it opens (apps/api /r and /e). The
 * signature says which business; the row is still read inside that
 * business's RLS scope, and every download is audited (spec 8.2).
 */

export type SignedFile =
  | { status: 200; bytes: Uint8Array; mimeType: string; fileName: string; disposition: "attachment" | "inline" }
  | { status: 404 | 410 };

export async function openSignedFile(
  deps: { db: Db; key: Buffer; store?: MediaStore },
  kind: LinkKind,
  token: string,
  now: Date,
): Promise<SignedFile> {
  const v = verifyLink(deps.key, token, now);
  // Forged and malformed tokens look like missing files.
  if (!v.ok) return { status: v.reason === "expired" ? 410 : 404 };
  const { claims } = v;
  if (claims.kind !== kind) return { status: 404 };

  if (kind === "report") {
    return withBusiness(deps.db, claims.businessId, async (tx) => {
      const [r] = await tx.select().from(reports).where(eq(reports.id, claims.id));
      if (!r) return { status: 404 as const };
      await tx.insert(auditLog).values({ businessId: claims.businessId, actor: "signed_link", action: "report.download", entity: "report", entityId: r.id });
      return { status: 200 as const, bytes: new Uint8Array(r.content), mimeType: r.mimeType, fileName: r.fileName, disposition: "attachment" as const };
    });
  }

  if (!deps.store) return { status: 404 };
  const found = await withBusiness(deps.db, claims.businessId, async (tx) => {
    const [c] = await tx.select({ id: captures.id, mediaUrl: captures.mediaUrl }).from(captures).where(eq(captures.id, claims.id));
    if (!c?.mediaUrl) return undefined;
    await tx.insert(auditLog).values({ businessId: claims.businessId, actor: "signed_link", action: "evidence.download", entity: "capture", entityId: c.id });
    return c.mediaUrl;
  });
  if (!found) return { status: 404 };
  const file = await deps.store.get(found);
  const ext = file.mimeType.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "bin";
  return { status: 200, bytes: file.bytes, mimeType: file.mimeType, fileName: `bukti-${claims.id.slice(0, 8)}.${ext}`, disposition: "inline" };
}
