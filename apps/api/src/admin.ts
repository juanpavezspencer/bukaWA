import { randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { auditLog, captureReviews, exchangeAdminLoginToken, pilotInvites, resolveAdminSession, revokeAdminSession, rows, withAdmin, type Db } from "@bukuwa/db";
import { maskSensitiveIds } from "@bukuwa/idn";
import { json, originCheck } from "./dashboard.js";
import { DEFAULT_TARGETS, summarizeCohorts, type PilotBusinessRow, type PilotTargets } from "./pilot.js";

/*
 * Staff console API (milestone 7): businesses, message logs, extraction
 * errors and the manual review queue. Runs as the bukuwa_admin DB role,
 * read-only across tenants except for reviews and audit rows. Message text
 * is masked (NIK/NPWP, phone numbers) before it leaves the server, and
 * opening a business's messages is audited.
 */

export interface AdminConfig {
  webOrigin: string;
  sessionHours: number;
  cookieSecure: boolean;
  /** Captures below this model confidence go to the review queue. */
  reviewConfidenceBelow: number;
  /** Pilot metric definitions (spec 10); defaults are the spec's. */
  pilotTargets?: PilotTargets;
  /** Monthly cost target per active business, rupiah (spec 10: Rp 3.000). */
  costTargetIdr?: bigint;
}

export const ADMIN_COOKIE = "bw_admin";

type Env = { Variables: { admin: { phoneHash: string } } };

const PHONE = /(?:\+?62|0)\s?8(?:[\s-]?\d){7,12}/g;

/** Mask NIK/NPWP and phone numbers (keep the last 3 digits). */
export function maskForStaff(text: string | null): string | null {
  if (text === null) return null;
  return maskSensitiveIds(text).replace(PHONE, (m) => `08•••${m.replace(/\D/g, "").slice(-3)}`);
}

function deepMask(v: unknown): unknown {
  if (typeof v === "string") return maskForStaff(v);
  if (Array.isArray(v)) return v.map(deepMask);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepMask(x)]));
  return v;
}

const actorOf = (a: { phoneHash: string }) => `admin:${a.phoneHash.slice(0, 12)}`;
const err = (c: Context, status: 400 | 401 | 404, code: string, message: string) => json(c, { error: code, message }, status);

// No 0/O or 1/I/L: codes are read aloud and typed on phones.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

const InviteBody = z
  .object({
    cohort: z.string().regex(/^[a-z0-9-]{2,40}$/),
    maxUses: z.number().int().min(1).max(1000),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

const ReviewBody = z
  .object({
    verdict: z.enum(["correct", "wrong", "unclear"]),
    wrongFields: z.array(z.enum(["intent", "amount", "date", "category", "payment_method", "counterparty", "kind", "other"])).max(8).default([]),
    note: z.string().max(1000).optional(),
  })
  .strict();

export function adminRoutes({ db, cfg, now, log }: { db: Db; cfg: AdminConfig; now: () => Date; log?: (e: Record<string, unknown>) => void }): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", originCheck(cfg.webOrigin));
  const cookieOpts = { httpOnly: true, secure: cfg.cookieSecure, sameSite: "Strict" as const, path: "/api/admin" };

  app.post("/auth/exchange", async (c) => {
    const body = z.object({ token: z.string().min(20).max(100) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return err(c, 400, "bad_request", "Link login nggak valid.");
    const s = await exchangeAdminLoginToken(db, body.data.token, now(), cfg.sessionHours * 3_600_000);
    if (!s) return err(c, 401, "link_invalid", "Link login sudah dipakai atau kedaluwarsa.");
    setCookie(c, ADMIN_COOKIE, s.sessionToken, { ...cookieOpts, expires: s.expiresAt });
    return json(c, { ok: true, expiresAt: s.expiresAt });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, ADMIN_COOKIE);
    if (token) await revokeAdminSession(db, token, now());
    deleteCookie(c, ADMIN_COOKIE, cookieOpts);
    return json(c, { ok: true });
  });

  app.use("*", async (c, next) => {
    const token = getCookie(c, ADMIN_COOKIE);
    const s = token ? await resolveAdminSession(db, token, now()) : null;
    if (!s) return err(c, 401, "unauthenticated", "Sesi admin habis, minta link baru lewat WhatsApp.");
    c.set("admin", s);
    return next();
  });

  app.get("/businesses", async (c) => {
    const since = new Date(now().getTime() - 7 * 86_400_000);
    const list = await withAdmin(db, async (tx) =>
      rows(
        await tx.execute(sql`
          select b.id, b.name, b.type, b.plan, b.created_at as "createdAt",
            (select count(*)::int from messages m where m.business_id = b.id and m.created_at >= ${since}) as "messages7d",
            (select count(*)::int from captures x where x.business_id = b.id and x.status = 'failed') as "failedCaptures",
            (select count(*)::int from journals j where j.business_id = b.id and j.reverses_journal_id is null) as "entries",
            (select max(m.created_at) from messages m where m.business_id = b.id) as "lastMessageAt"
          from businesses b order by b.created_at desc limit 500`),
      ),
    );
    return json(c, { businesses: list });
  });

  app.get("/businesses/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return err(c, 404, "not_found", "Bisnis nggak ditemukan.");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
    const admin = c.get("admin");
    const out = await withAdmin(db, async (tx) => {
      const [b] = rows<{ id: string; name: string }>(await tx.execute(sql`select id, name from businesses where id = ${id}`));
      if (!b) return null;
      const msgs = rows<{ id: string; direction: string; type: string; body: string | null; templateName: string | null; createdAt: string }>(
        await tx.execute(sql`
          select id, direction, type, body, template_name as "templateName", created_at as "createdAt"
          from messages where business_id = ${id} order by created_at desc limit ${limit}`),
      );
      await tx.insert(auditLog).values({ businessId: id, actor: actorOf(admin), action: "admin.view_messages", entity: "business", entityId: id, after: { count: msgs.length } });
      return { business: b, messages: msgs.map((m) => ({ ...m, body: maskForStaff(m.body) })) };
    });
    if (!out) return err(c, 404, "not_found", "Bisnis nggak ditemukan.");
    return json(c, out);
  });

  /** Failed, cancelled, low-confidence, or confirmed-then-reversed captures nobody has reviewed yet. */
  app.get("/review", async (c) => {
    const below = cfg.reviewConfidenceBelow;
    const items = await withAdmin(db, async (tx) =>
      rows<Record<string, unknown>>(
        await tx.execute(sql`
          select c.id, c.business_id as "businessId", b.name as "businessName", c.source, c.raw_text as "rawText",
            c.transcript, c.extraction_json as "extraction", c.confidence, c.status, c.model_version as "modelVersion",
            c.created_at as "createdAt",
            case
              when c.status = 'failed' then 'failed'
              when c.status = 'cancelled' then 'cancelled'
              when c.confidence is not null and c.confidence < ${below} then 'low_confidence'
              else 'reversed'
            end as reason
          from captures c join businesses b on b.id = c.business_id
          where not exists (select 1 from capture_reviews r where r.capture_id = c.id)
            and (
              c.status in ('failed', 'cancelled')
              or (c.confidence is not null and c.confidence < ${below})
              or (c.status = 'confirmed' and c.journal_id is not null
                  and exists (select 1 from journals r where r.reverses_journal_id = c.journal_id))
            )
          order by c.created_at desc limit 100`),
      ),
    );
    return json(c, {
      items: items.map((i) => ({ ...i, rawText: maskForStaff(i.rawText as string | null), transcript: maskForStaff(i.transcript as string | null), extraction: deepMask(i.extraction) })),
    });
  });

  app.post("/review/:captureId", async (c) => {
    const captureId = c.req.param("captureId");
    if (!z.string().uuid().safeParse(captureId).success) return err(c, 404, "not_found", "Capture nggak ditemukan.");
    const body = ReviewBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return err(c, 400, "bad_request", "Review nggak valid.");
    const admin = c.get("admin");
    const saved = await withAdmin(db, async (tx) => {
      const [cap] = rows<{ businessId: string }>(await tx.execute(sql`select business_id as "businessId" from captures where id = ${captureId}`));
      if (!cap) return null;
      const [r] = await tx
        .insert(captureReviews)
        .values({ businessId: cap.businessId, captureId, verdict: body.data.verdict, wrongFields: body.data.wrongFields, note: body.data.note, reviewer: admin.phoneHash })
        .returning({ id: captureReviews.id });
      await tx.insert(auditLog).values({
        businessId: cap.businessId,
        actor: actorOf(admin),
        action: "capture.review",
        entity: "capture",
        entityId: captureId,
        after: { verdict: body.data.verdict, wrongFields: body.data.wrongFields },
      });
      return r!;
    });
    if (!saved) return err(c, 404, "not_found", "Capture nggak ditemukan.");
    return json(c, { ok: true, reviewId: saved.id }, 201);
  });

  /** Pilot metrics per cohort and business over the last `days` (spec 10). */
  app.get("/pilot", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 90);
    const at = now();
    const since = new Date(at.getTime() - days * 86_400_000).toISOString();
    const week = new Date(at.getTime() - 7 * 86_400_000).toISOString();
    const out = await withAdmin(db, async (tx) => {
      const raw = rows<{
        id: string;
        name: string;
        cohort: string | null;
        createdAt: string | Date;
        weekly: Array<[number, number]>;
        tx7d: number;
        confirmedClean: number;
        confirmedReversed: number;
        cancelled: number;
        llmMicro: string | null;
        waIdr: string | null;
      }>(
        await tx.execute(sql`
          with owner_tx as (
            select j.business_id, j.created_at from journals j
            where j.reverses_journal_id is null and coalesce(j.idempotency_key, '') <> 'opening-balance'
          )
          select b.id, b.name, b.cohort, b.created_at as "createdAt",
            coalesce((
              select json_agg(json_build_array(w, n)) from (
                select floor(extract(epoch from (t.created_at - b.created_at)) / 604800)::int as w, count(*)::int as n
                from owner_tx t where t.business_id = b.id group by 1) x), '[]'::json) as weekly,
            (select count(*)::int from owner_tx t where t.business_id = b.id and t.created_at >= ${week}::timestamptz) as "tx7d",
            (select count(*)::int from captures x where x.business_id = b.id and x.updated_at >= ${since}::timestamptz and x.status = 'confirmed'
               and not exists (select 1 from journals r where r.reverses_journal_id = x.journal_id)) as "confirmedClean",
            (select count(*)::int from captures x where x.business_id = b.id and x.updated_at >= ${since}::timestamptz and x.status = 'confirmed'
               and exists (select 1 from journals r where r.reverses_journal_id = x.journal_id)) as "confirmedReversed",
            (select count(*)::int from captures x where x.business_id = b.id and x.updated_at >= ${since}::timestamptz and x.status = 'cancelled') as cancelled,
            (select sum(u.cost_micro_idr)::text from usage_events u where u.business_id = b.id and u.created_at >= ${since}::timestamptz) as "llmMicro",
            (select sum(m.cost_idr)::text from messages m where m.business_id = b.id and m.created_at >= ${since}::timestamptz) as "waIdr"
          from businesses b order by b.created_at limit 1000`),
      );
      const replies = rows<{ kind: string; n: number; medianMs: number | null; p90Ms: number | null }>(
        await tx.execute(sql`
          select case when type in ('image', 'document') then 'photo' when type = 'audio' then 'voice' else 'text' end as kind,
            count(*)::int as n,
            (percentile_cont(0.5) within group (order by extract(epoch from processed_at - received_at) * 1000))::int as "medianMs",
            (percentile_cont(0.9) within group (order by extract(epoch from processed_at - received_at) * 1000))::int as "p90Ms"
          from wa_inbound where processed_at is not null and received_at >= ${since}::timestamptz
          group by 1 order by 1`),
      );
      return { raw, replies };
    });
    const input: PilotBusinessRow[] = out.raw.map((r) => {
      const weeklyTx: number[] = [];
      for (const [w, n] of r.weekly) if (w >= 0) weeklyTx[w] = n;
      return {
        id: r.id,
        name: r.name,
        cohort: r.cohort,
        createdAt: new Date(r.createdAt),
        weeklyTx: Array.from(weeklyTx, (n) => n ?? 0),
        tx7d: r.tx7d,
        confirmedClean: r.confirmedClean,
        confirmedReversed: r.confirmedReversed,
        cancelled: r.cancelled,
        llmMicroIdr: BigInt(r.llmMicro ?? "0"),
        waIdr: BigInt(r.waIdr ?? "0"),
      };
    });
    const targets = cfg.pilotTargets ?? DEFAULT_TARGETS;
    const summary = summarizeCohorts(input, at, targets);
    return json(c, { days, targets: { ...targets, costTargetIdr: cfg.costTargetIdr ?? 3000n }, ...summary, replies: out.replies });
  });

  app.get("/invites", async (c) => {
    const list = await withAdmin(db, (tx) => tx.select().from(pilotInvites).orderBy(sql`${pilotInvites.createdAt} desc`).limit(500));
    return json(c, { invites: list.map(({ createdBy: _by, ...i }) => i) });
  });

  app.post("/invites", async (c) => {
    const body = InviteBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return err(c, 400, "bad_request", "Isi cohort (huruf kecil, angka, tanda -) dan jumlah pemakaian 1–1000.");
    const admin = c.get("admin");
    const expiresAt = body.data.expiresInDays ? new Date(now().getTime() + body.data.expiresInDays * 86_400_000) : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const [row] = await withAdmin(db, (tx) =>
        tx
          .insert(pilotInvites)
          .values({ code, cohort: body.data.cohort, maxUses: body.data.maxUses, expiresAt, createdBy: admin.phoneHash })
          .onConflictDoNothing()
          .returning(),
      );
      if (row) {
        log?.({ level: "info", event: "admin.invite_created", actor: actorOf(admin), code, cohort: row.cohort, maxUses: row.maxUses });
        const { createdBy: _by, ...invite } = row;
        return json(c, { invite }, 201);
      }
    }
    throw new Error("could not generate a unique invite code");
  });

  /** Pending "hapus data" requests, for support. */
  app.get("/erasures", async (c) => {
    const list = await withAdmin(db, async (tx) =>
      rows(
        await tx.execute(sql`
          select r.business_id as "businessId", b.name, r.requested_at as "requestedAt", r.scheduled_for as "scheduledFor", r.cancelled_at as "cancelledAt"
          from erasure_requests r join businesses b on b.id = r.business_id order by r.scheduled_for limit 200`),
      ),
    );
    const done = await withAdmin(db, async (tx) =>
      rows(await tx.execute(sql`select subject_id as "businessId", requested_at as "requestedAt", executed_at as "executedAt" from erasure_log order by executed_at desc limit 50`)),
    );
    return json(c, { pending: list, erased: done });
  });

  return app;
}
