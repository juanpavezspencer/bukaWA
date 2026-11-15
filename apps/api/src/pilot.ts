/*
 * Pilot metrics (spec 10), computed in code from per-business counts the
 * admin console reads with SQL. Targets: week-8 retention 40%+, 15+
 * transactions per active business per week, 70%+ auto-confirmed, cost under
 * Rp 3.000 per active business per month, median reply under 4 s (text) and
 * 12 s (photos).
 */

export interface PilotBusinessRow {
  id: string;
  name: string;
  cohort: string | null;
  createdAt: Date;
  /** Owner transactions (no reversals, no opening balance) per week since joining: index 0 = first 7 days. */
  weeklyTx: number[];
  tx7d: number;
  /** Captures closed in the window. */
  confirmedClean: number;
  confirmedReversed: number;
  cancelled: number;
  /** Window cost, micro-rupiah (models) and rupiah (WhatsApp templates). */
  llmMicroIdr: bigint;
  waIdr: bigint;
}

export interface PilotTargets {
  /** Which week since joining counts for retention (spec: week 8). */
  retentionWeek: number;
  /** Transactions in that week to count as retained (spec: 3). */
  retentionMinTx: number;
  /** An "active" business sent at least this many transactions in the last 7 days. */
  activeMinTx: number;
}

export const DEFAULT_TARGETS: PilotTargets = { retentionWeek: 8, retentionMinTx: 3, activeMinTx: 1 };

export interface PilotBusiness {
  id: string;
  name: string;
  cohort: string;
  createdAt: Date;
  weeksSinceJoin: number;
  tx7d: number;
  active: boolean;
  /** null until the business has reached the retention week. */
  retained: boolean | null;
  autoConfirmPct: number | null;
  costIdr: bigint;
}

export interface CohortSummary {
  cohort: string;
  businesses: number;
  active: number;
  /** Businesses old enough to judge retention, and how many were retained. */
  retentionEligible: number;
  retained: number;
  retentionPct: number | null;
  txPerActivePerWeek: number | null;
  autoConfirmPct: number | null;
  costIdr: bigint;
  costPerActiveIdr: bigint | null;
}

const NO_COHORT = "(tanpa kode)";
const WEEK_MS = 7 * 86_400_000;

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

/** Micro-rupiah to rupiah, half up. */
const toIdr = (micro: bigint) => (micro + 500_000n) / 1_000_000n;

export function pilotBusiness(r: PilotBusinessRow, now: Date, t: PilotTargets = DEFAULT_TARGETS): PilotBusiness {
  const weeksSinceJoin = Math.floor((now.getTime() - r.createdAt.getTime()) / WEEK_MS);
  // Week N (1-based) is complete once N full weeks have passed.
  const retained = weeksSinceJoin >= t.retentionWeek ? (r.weeklyTx[t.retentionWeek - 1] ?? 0) >= t.retentionMinTx : null;
  const closed = r.confirmedClean + r.confirmedReversed + r.cancelled;
  return {
    id: r.id,
    name: r.name,
    cohort: r.cohort ?? NO_COHORT,
    createdAt: r.createdAt,
    weeksSinceJoin,
    tx7d: r.tx7d,
    active: r.tx7d >= t.activeMinTx,
    retained,
    autoConfirmPct: pct(r.confirmedClean, closed),
    costIdr: toIdr(r.llmMicroIdr) + r.waIdr,
  };
}

export function summarizeCohorts(rows: PilotBusinessRow[], now: Date, t: PilotTargets = DEFAULT_TARGETS): { businesses: PilotBusiness[]; cohorts: CohortSummary[]; total: CohortSummary } {
  const businesses = rows.map((r) => pilotBusiness(r, now, t));
  const groups = new Map<string, Array<{ b: PilotBusiness; r: PilotBusinessRow }>>();
  rows.forEach((r, i) => {
    const b = businesses[i]!;
    groups.set(b.cohort, [...(groups.get(b.cohort) ?? []), { b, r }]);
  });
  const summarize = (cohort: string, members: Array<{ b: PilotBusiness; r: PilotBusinessRow }>): CohortSummary => {
    const active = members.filter((m) => m.b.active);
    const eligible = members.filter((m) => m.b.retained !== null);
    const clean = members.reduce((s, m) => s + m.r.confirmedClean, 0);
    const closed = members.reduce((s, m) => s + m.r.confirmedClean + m.r.confirmedReversed + m.r.cancelled, 0);
    const costIdr = members.reduce((s, m) => s + m.b.costIdr, 0n);
    const activeTx = active.reduce((s, m) => s + m.b.tx7d, 0);
    return {
      cohort,
      businesses: members.length,
      active: active.length,
      retentionEligible: eligible.length,
      retained: eligible.filter((m) => m.b.retained).length,
      retentionPct: pct(eligible.filter((m) => m.b.retained).length, eligible.length),
      txPerActivePerWeek: active.length ? Math.round((activeTx / active.length) * 10) / 10 : null,
      autoConfirmPct: pct(clean, closed),
      costIdr,
      costPerActiveIdr: active.length ? costIdr / BigInt(active.length) : null,
    };
  };
  const cohorts = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, m]) => summarize(c, m));
  const total = summarize("Semua", rows.map((r, i) => ({ b: businesses[i]!, r })));
  return { businesses, cohorts, total };
}

/** Median of a list of durations (ms); null when empty. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
