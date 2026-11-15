import { and, eq, gte, sql } from "drizzle-orm";
import { messages, rows, usageEvents, type Tx } from "@bukuwa/db";
import { costMicroIdr, microToRupiah, type MeteredCall, type Pricing } from "@bukuwa/ai";
import { localDateTime, utcOffsetHours } from "@bukuwa/idn";

/*
 * Milestone 8 hardening: per-business cost metering (spec 5) and a daily
 * message cap, so one runaway chat (a forwarding loop, a bot) can't run up
 * model spend for everyone.
 */

export interface MeteringDeps {
  pricing: Pricing;
  /** Log a warning when a business's month-to-date model cost first passes this (rupiah). */
  monthlyAlertIdr: bigint;
}

export interface LimitDeps {
  /** Inbound messages per business per local day that get model calls. */
  dailyInbound: number;
}

/** Start of the local day / month containing `now`, as an instant. */
export function localStart(now: Date, timezone: string, unit: "day" | "month"): Date {
  const { date } = localDateTime(now, timezone);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, unit === "day" ? d : 1) - utcOffsetHours(timezone) * 3_600_000);
}

/** Inbound messages already logged for this business today (local time). */
export async function inboundToday(tx: Tx, businessId: string, now: Date, timezone: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.businessId, businessId), eq(messages.direction, "inbound"), gte(messages.createdAt, localStart(now, timezone, "day"))));
  return r?.n ?? 0;
}

/**
 * Write one usage_events row per model call and warn once when the month's
 * model cost crosses the alert line. Must run in the business's scope.
 */
export async function recordUsage(
  tx: Tx,
  deps: MeteringDeps,
  ctx: { businessId: string; waMessageId?: string; now: Date; timezone: string },
  calls: MeteredCall[],
  log: (e: Record<string, unknown>) => void,
): Promise<bigint> {
  if (!calls.length) return 0n;
  const values = calls.map((c) => ({
    businessId: ctx.businessId,
    kind: c.kind,
    model: c.model,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheReadTokens: c.cacheReadTokens,
    cacheWriteTokens: c.cacheWriteTokens,
    costMicroIdr: costMicroIdr(deps.pricing, c.model, c),
    waMessageId: ctx.waMessageId ?? null,
  }));
  const added = values.reduce((s, v) => s + v.costMicroIdr, 0n);
  const r = rows<{ total: string | null }>(
    await tx.execute(sql`
      select sum(cost_micro_idr)::text as total from usage_events
      where business_id = ${ctx.businessId} and created_at >= ${localStart(ctx.now, ctx.timezone, "month").toISOString()}::timestamptz`),
  );
  const before = BigInt(r[0]?.total ?? "0");
  await tx.insert(usageEvents).values(values);
  const line = deps.monthlyAlertIdr * 1_000_000n;
  if (before < line && before + added >= line) {
    log({ level: "warn", event: "cost.over_budget", businessId: ctx.businessId, monthToDateIdr: microToRupiah(before + added).toString(), alertIdr: deps.monthlyAlertIdr.toString() });
  }
  return added;
}
