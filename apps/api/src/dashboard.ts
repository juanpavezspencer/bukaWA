import { and, eq } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  accounts,
  auditLog,
  businesses,
  exchangeLoginToken,
  journals,
  resolveSession,
  revokeSession,
  withBusiness,
  type Db,
  type Tx,
} from "@bukuwa/db";
import { localDateTime, periodBuckets, type BucketUnit } from "@bukuwa/idn";
import {
  cashFlow,
  correctedDraft,
  findTransactions,
  getJournalSummary,
  LedgerError,
  openBalances,
  postJournal,
  profitAndLoss,
  reverseJournal,
  type JournalSummary,
} from "@bukuwa/ledger";
import { generateMonthlyReport, type LinkSigner, type ReportFormat } from "@bukuwa/reports";

/*
 * Owner dashboard API (milestone 7). Every handler runs inside
 * withBusiness() for the session's business, so RLS scopes every query.
 * Edits never touch a posted journal: "hapus" posts a reversal and "edit"
 * posts a reversal plus the corrected entry, both audited.
 */

export interface DashboardConfig {
  /** The web app's origin; state-changing requests from any other origin are refused (CSRF). */
  webOrigin: string;
  sessionTtlDays: number;
  /** Secure cookies (off only for http://localhost in dev). */
  cookieSecure: boolean;
  /** Report download links for exports; exports are off without it. */
  signer?: LinkSigner;
  defaultRegime: string;
  /** Most buckets a P&L chart may ask for. */
  maxBuckets: number;
}

export interface DashboardDeps {
  db: Db;
  cfg: DashboardConfig;
  now: () => Date;
  log: (e: Record<string, unknown>) => void;
}

export const SESSION_COOKIE = "bw_session";

type Env = { Variables: { session: { businessId: string; userId: string } } };

/** JSON with bigint money as strings (never floats). */
export function json(c: Context, data: unknown, status: 200 | 201 | 400 | 401 | 403 | 404 | 409 | 422 | 503 = 200): Response {
  return c.body(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
  });
}

const err = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 503, code: string, message: string) => json(c, { error: code, message }, status);

/** Refuse non-GET requests whose Origin isn't the web app (SameSite=Lax already blocks most). */
export function originCheck(webOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
    if (c.req.header("origin") !== webOrigin) return err(c, 403, "bad_origin", "Permintaan ditolak.");
    return next();
  };
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,64}$/;

const TxQuery = z.object({
  from: DATE.optional(),
  to: DATE.optional(),
  q: z.string().max(100).optional(),
  kind: z.enum(["sale", "expense", "receivable", "payable", "settlement", "owner_capital", "owner_drawing", "other"]).optional(),
  cancelled: z.enum(["1", "0"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const CorrectBody = z
  .object({
    amountIdr: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
    date: DATE.optional(),
    paymentCode: z.string().max(10).optional(),
    categoryCode: z.string().max(10).optional(),
  })
  .strict();

const PnlQuery = z.object({ from: DATE, to: DATE, bucket: z.enum(["day", "week", "month"]).default("day") });
const ExportBody = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), format: z.enum(["pdf", "xlsx"]) }).strict();

const LEDGER_MESSAGES: Partial<Record<string, string>> = {
  ALREADY_REVERSED: "Transaksi ini sudah dibatalkan.",
  CANNOT_REVERSE_REVERSAL: "Ini catatan pembatalan, nggak bisa diubah.",
  NOT_CORRECTABLE: "Transaksi ini nggak bisa diedit begitu. Batalkan lalu catat ulang ya.",
  INVALID_CATEGORY: "Kategori atau akun itu nggak cocok untuk transaksi ini.",
  INVALID_AMOUNT: "Nominalnya harus angka rupiah lebih dari 0.",
  INVALID_DATE: "Tanggalnya nggak valid.",
  UNKNOWN_ACCOUNT: "Akun itu nggak ada.",
  TOO_MANY_ENTRIES: "Periodenya terlalu panjang, pilih yang lebih pendek ya.",
};

function ledgerError(c: Context, e: unknown): Response {
  if (!(e instanceof LedgerError)) throw e;
  return err(c, e.code === "ALREADY_REVERSED" ? 409 : 422, e.code, LEDGER_MESSAGES[e.code] ?? "Permintaan nggak bisa diproses.");
}

/** What the transaction list shows; lines stay server-side. */
function txView(t: JournalSummary) {
  return {
    id: t.id,
    date: t.date,
    description: t.description,
    source: t.source,
    kind: t.kind,
    amountIdr: t.amountIdr,
    category: t.category,
    categoryCode: t.categoryCode,
    paymentAccount: t.paymentAccount,
    paymentCode: t.paymentCode,
    counterparty: t.counterparty,
    cancelled: t.reversed,
    editable: !t.reversed && t.simple,
    createdAt: t.createdAt,
  };
}

async function businessToday(tx: Tx, businessId: string, now: Date) {
  const [b] = await tx
    .select({ id: businesses.id, name: businesses.name, type: businesses.type, timezone: businesses.timezone, plan: businesses.plan })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!b) throw new Error("session business not found");
  return { ...b, today: localDateTime(now, b.timezone).date };
}

/** The journal a dashboard action with this key already posted, if any (retries replay). */
async function postedFor(tx: Tx, businessId: string, key: string) {
  const [j] = await tx
    .select({ id: journals.id })
    .from(journals)
    .where(and(eq(journals.businessId, businessId), eq(journals.idempotencyKey, key)));
  return j?.id;
}

export function dashboardRoutes({ db, cfg, now, log }: DashboardDeps): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", originCheck(cfg.webOrigin));

  const cookieOpts = { httpOnly: true, secure: cfg.cookieSecure, sameSite: "Lax" as const, path: "/api" };

  app.post("/auth/exchange", async (c) => {
    const body = z.object({ token: z.string().min(20).max(100) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return err(c, 400, "bad_request", "Link login nggak valid.");
    const s = await exchangeLoginToken(db, body.data.token, now(), cfg.sessionTtlDays * 86_400_000);
    if (!s) {
      log({ level: "info", event: "dashboard.login.rejected" });
      return err(c, 401, "link_invalid", "Link login sudah dipakai atau kedaluwarsa. Ketik \"dashboard\" di WhatsApp untuk link baru ya.");
    }
    setCookie(c, SESSION_COOKIE, s.sessionToken, { ...cookieOpts, expires: s.expiresAt });
    log({ level: "info", event: "dashboard.login", businessId: s.businessId });
    return json(c, { ok: true, expiresAt: s.expiresAt });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await revokeSession(db, token, now());
    deleteCookie(c, SESSION_COOKIE, cookieOpts);
    return json(c, { ok: true });
  });

  // Everything below needs a live session.
  app.use("*", async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const s = token ? await resolveSession(db, token, now()) : null;
    if (!s) return err(c, 401, "unauthenticated", "Sesi habis. Ketik \"dashboard\" di WhatsApp untuk masuk lagi ya.");
    c.set("session", s);
    return next();
  });

  const scoped = <T>(c: Context<Env>, fn: (tx: Tx, s: { businessId: string; userId: string }) => Promise<T>) =>
    withBusiness(db, c.get("session").businessId, (tx) => fn(tx, c.get("session")));

  app.get("/me", async (c) => json(c, { business: await scoped(c, (tx, s) => businessToday(tx, s.businessId, now())), exportsEnabled: !!cfg.signer }));

  app.get("/accounts", async (c) => {
    const rows = await scoped(c, (tx, s) =>
      tx.select({ code: accounts.code, name: accounts.name, type: accounts.type }).from(accounts).where(eq(accounts.businessId, s.businessId)).orderBy(accounts.code),
    );
    return json(c, { accounts: rows });
  });

  app.get("/transactions", async (c) => {
    const q = TxQuery.safeParse(c.req.query());
    if (!q.success) return err(c, 400, "bad_request", "Filter nggak valid.");
    const f = q.data;
    try {
      const found = await scoped(c, (tx, s) =>
        findTransactions(tx, s.businessId, {
          from: f.from,
          to: f.to,
          text: f.q,
          kind: f.kind,
          includeReversed: f.cancelled !== "0",
          limit: f.limit ?? 50,
        }),
      );
      return json(c, { transactions: found.transactions.map(txView), matched: found.matched, count: found.count, totalIdr: found.totalIdr });
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  /** Cancel (hapus) or correct (edit): reversal, then the corrected copy. */
  const change = (action: "cancel" | "correct") => async (c: Context<Env>) => {
    const key = c.req.header("idempotency-key") ?? "";
    if (!IDEMPOTENCY.test(key)) return err(c, 400, "idempotency_key", "Idempotency-Key header is required.");
    let correction: z.infer<typeof CorrectBody> | undefined;
    if (action === "correct") {
      const b = CorrectBody.safeParse(await c.req.json().catch(() => null));
      if (!b.success) return err(c, 400, "bad_request", "Data koreksi nggak valid.");
      correction = b.data;
    }
    const journalId = c.req.param("id") ?? "";
    if (!z.string().uuid().safeParse(journalId).success) return err(c, 404, "not_found", "Transaksi nggak ditemukan.");
    const revKey = `dashboard:${key}:rev`;
    const newKey = `dashboard:${key}:0`;
    try {
      const out = await scoped(c, async (tx, s) => {
        const replay = await postedFor(tx, s.businessId, revKey);
        if (replay) return { reversalId: replay, correctedId: (await postedFor(tx, s.businessId, newKey)) ?? null, replayed: true };
        const original = await getJournalSummary(tx, s.businessId, journalId);
        if (!original) return null;
        const draft = correction
          ? correctedDraft(s.businessId, original, {
              amountIdr: correction.amountIdr ? BigInt(correction.amountIdr) : undefined,
              date: correction.date,
              paymentCode: correction.paymentCode,
              categoryCode: correction.categoryCode,
            })
          : undefined;
        const reversal = await reverseJournal(tx, { businessId: s.businessId, journalId, createdBy: s.userId, idempotencyKey: revKey });
        const corrected = draft ? await postJournal(tx, { ...draft, idempotencyKey: newKey, createdBy: s.userId }) : undefined;
        await tx.insert(auditLog).values({
          businessId: s.businessId,
          actor: s.userId,
          action: action === "cancel" ? "dashboard.cancel" : "dashboard.correct",
          entity: "journal",
          entityId: journalId,
          before: { date: original.date, amountIdr: original.amountIdr.toString(), categoryCode: original.categoryCode, paymentCode: original.paymentCode },
          after: { reversalId: reversal.id, correctedId: corrected?.id ?? null, ...(correction ?? {}) },
        });
        return { reversalId: reversal.id, correctedId: corrected?.id ?? null, replayed: false };
      });
      if (!out) return err(c, 404, "not_found", "Transaksi nggak ditemukan.");
      log({ level: "info", event: `dashboard.${action}`, businessId: c.get("session").businessId, replayed: out.replayed });
      return json(c, out);
    } catch (e) {
      return ledgerError(c, e);
    }
  };
  app.post("/transactions/:id/cancel", change("cancel"));
  app.post("/transactions/:id/correct", change("correct"));

  app.get("/reports/pnl", async (c) => {
    const q = PnlQuery.safeParse(c.req.query());
    if (!q.success || q.data.from > q.data.to) return err(c, 400, "bad_request", "Periode nggak valid.");
    let buckets: Array<{ from: string; to: string }>;
    try {
      buckets = periodBuckets(q.data.from, q.data.to, q.data.bucket as BucketUnit, cfg.maxBuckets);
    } catch {
      return err(c, 400, "too_many_buckets", "Periodenya terlalu panjang untuk tampilan ini, pilih mingguan atau bulanan ya.");
    }
    const out = await scoped(c, async (tx, s) => {
      const rows = [];
      for (const b of buckets) {
        const [p, f] = [await profitAndLoss(tx, s.businessId, b), await cashFlow(tx, s.businessId, b)];
        rows.push({ from: b.from, to: b.to, incomeIdr: p.incomeIdr, expenseIdr: p.expenseIdr, profitIdr: p.profitIdr, cashInIdr: f.inIdr, cashOutIdr: f.outIdr });
      }
      const range = { from: q.data.from, to: q.data.to };
      const total = await profitAndLoss(tx, s.businessId, range);
      const flow = await cashFlow(tx, s.businessId, range);
      return { ...range, bucket: q.data.bucket, buckets: rows, total, cashFlow: flow };
    });
    return json(c, out);
  });

  app.get("/contacts", async (c) => {
    const kind = c.req.query("kind");
    if (kind !== undefined && kind !== "receivable" && kind !== "payable") return err(c, 400, "bad_request", "Filter nggak valid.");
    const rows = await scoped(c, (tx, s) => openBalances(tx, s.businessId, { kind }));
    return json(c, { contacts: rows });
  });

  app.post("/exports", async (c) => {
    const signer = cfg.signer;
    if (!signer) return err(c, 503, "exports_off", "Ekspor belum aktif.");
    const b = ExportBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, "bad_request", "Bulan atau format nggak valid.");
    const at = now();
    try {
      const out = await scoped(c, async (tx, s) => {
        const biz = await businessToday(tx, s.businessId, at);
        if (b.data.month > biz.today.slice(0, 7)) return null;
        const g = await generateMonthlyReport(tx, s.businessId, {
          month: b.data.month,
          format: b.data.format as ReportFormat,
          today: biz.today,
          now: at,
          actor: s.userId,
          createdBy: s.userId,
          defaultRegime: cfg.defaultRegime,
          evidenceUrl: (id) => signer.evidenceUrl(s.businessId, id, at),
        });
        return { url: signer.reportUrl(s.businessId, g.reportId, at), fileName: g.fileName };
      });
      if (!out) return err(c, 422, "future_month", "Bulan itu belum ada datanya.");
      return json(c, out, 201);
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  return app;
}

