import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withBusiness, type Db } from "@bukuwa/db";
import { createTestBusiness, createTestDb } from "@bukuwa/db/testing";
import { generateMonthlyReport, linkSigner } from "@bukuwa/reports";
import { createApp } from "../src/app.js";

const key = randomBytes(32);
const signer = linkSigner({ key, baseUrl: "https://api.test", reportTtlMinutes: 15, evidenceTtlHours: 24 });
const NOW = new Date("2026-11-13T05:00:00Z");
let db: Db;
let url: string;
let now = NOW;

beforeAll(async () => {
  ({ db } = await createTestDb());
  const biz = await createTestBusiness(db, "Catering Rina");
  const g = await withBusiness(db, biz, (tx) =>
    generateMonthlyReport(tx, biz, {
      month: "2026-10", format: "xlsx", today: "2026-11-13", now: NOW, actor: "owner", defaultRegime: "umkm_final_individual",
      evidenceUrl: (id) => signer.evidenceUrl(biz, id, NOW),
    }),
  );
  url = signer.reportUrl(biz, g.reportId, NOW);
});

const app = () =>
  createApp({
    db,
    queue: { enqueueInbound: async () => {} },
    config: { WA_APP_SECRET: "test-app-secret-0123456789", WA_VERIFY_TOKEN: "verify-me-please", WA_WEBHOOK_MAX_BYTES: 1000 },
    files: { key },
    now: () => now,
    log: () => {},
  });

describe("GET /r/:token", () => {
  it("downloads the report as an uncached attachment", async () => {
    now = NOW;
    const res = await app().request(new URL(url).pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="laporan-catering-rina-2026-10.xlsx"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it("says the link expired after 15 minutes, in Bahasa", async () => {
    now = new Date(NOW.getTime() + 15 * 60_000);
    const res = await app().request(new URL(url).pathname);
    expect(res.status).toBe(410);
    expect(await res.text()).toMatch(/kedaluwarsa/);
  });

  it("404s a tampered token", async () => {
    now = NOW;
    const res = await app().request(`${new URL(url).pathname}x`);
    expect(res.status).toBe(404);
  });
});
