import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, captures, memoryMediaStore, withBusiness, type Db } from "@bukuwa/db";
import { createTestBusiness, createTestDb } from "@bukuwa/db/testing";
import { buildJournalDraft, postJournal } from "@bukuwa/ledger";
import { generateMonthlyReport, linkSigner, openSignedFile } from "../src/index.js";

const key = randomBytes(32);
const signer = linkSigner({ key, baseUrl: "https://bukuwa.test", reportTtlMinutes: 15, evidenceTtlHours: 24 });
const NOW = new Date("2026-11-13T05:00:00Z");
const store = memoryMediaStore();
let db: Db;
let biz: string;
let other: string;
let reportId: string;
let captureId: string;
const token = (url: string) => url.split("/").pop()!;

beforeAll(async () => {
  ({ db } = await createTestDb());
  biz = await createTestBusiness(db, "Catering Rina");
  other = await createTestBusiness(db, "Toko Dimas");
  const mediaUrl = await store.put(`${biz}/wamid.1.jpg`, new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");
  await withBusiness(db, biz, async (tx) => {
    const [c] = await tx.insert(captures).values({ businessId: biz, source: "photo", mediaUrl, status: "confirmed" }).returning();
    captureId = c!.id;
    await postJournal(tx, { ...buildJournalDraft(biz, { kind: "sale", amountIdr: 1_000_000n, date: "2026-10-02", description: "Jual", source: "photo", paymentMethod: "cash" }), idempotencyKey: `capture:${captureId}:0` });
    reportId = (
      await generateMonthlyReport(tx, biz, {
        month: "2026-10", format: "pdf", today: "2026-11-13", now: NOW, actor: "owner", defaultRegime: "umkm_final_individual",
        evidenceUrl: (id) => signer.evidenceUrl(biz, id, NOW),
      })
    ).reportId;
  });
});

describe("openSignedFile", () => {
  it("serves the stored report and audits the download", async () => {
    const f = await openSignedFile({ db, key }, "report", token(signer.reportUrl(biz, reportId, NOW)), NOW);
    expect(f).toMatchObject({ status: 200, mimeType: "application/pdf", fileName: "laporan-catering-rina-2026-10.pdf", disposition: "attachment" });
    expect(f.status === 200 && Buffer.from(f.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const audits = await withBusiness(db, biz, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "report.download")));
    expect(audits).toHaveLength(1);
  });

  it("serves the evidence photo inline", async () => {
    const f = await openSignedFile({ db, key, store }, "evidence", token(signer.evidenceUrl(biz, captureId, NOW)), NOW);
    expect(f).toMatchObject({ status: 200, mimeType: "image/jpeg", disposition: "inline" });
  });

  it("answers 410 after expiry and 404 for forged or mismatched links", async () => {
    const t = token(signer.reportUrl(biz, reportId, NOW));
    expect((await openSignedFile({ db, key }, "report", t, new Date(NOW.getTime() + 16 * 60_000))).status).toBe(410);
    expect((await openSignedFile({ db, key: randomBytes(32) }, "report", t, NOW)).status).toBe(404);
    expect((await openSignedFile({ db, key, store }, "evidence", t, NOW)).status).toBe(404);
  });

  it("never serves a business's file under a link signed for another business", async () => {
    // A genuine signature over the wrong business id: RLS hides the row.
    expect((await openSignedFile({ db, key }, "report", token(signer.reportUrl(other, reportId, NOW)), NOW)).status).toBe(404);
    expect((await openSignedFile({ db, key, store }, "evidence", token(signer.evidenceUrl(other, captureId, NOW)), NOW)).status).toBe(404);
  });
});
