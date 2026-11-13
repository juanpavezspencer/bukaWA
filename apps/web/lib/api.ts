"use client";

/** Thin fetch wrapper for the dashboard API (same origin, proxied to the Hono API). */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { idempotent?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body) headers["content-type"] = "application/json";
  if (init.idempotent) headers["idempotency-key"] = crypto.randomUUID().replace(/-/g, "");
  const res = await fetch(path, { ...init, credentials: "same-origin", headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? "error", body.message ?? "Ada masalah, coba lagi ya.");
  return body as T;
}

/** Reads the magic-link token from the URL fragment (never sent to any server) and clears it. */
export function takeFragmentToken(): string | null {
  const m = /[#&]t=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  history.replaceState(null, "", window.location.pathname);
  return m ? m[1]! : null;
}

export interface Business {
  id: string;
  name: string;
  type: string;
  timezone: string;
  plan: string;
  today: string;
}

export interface Transaction {
  id: string;
  date: string;
  description: string;
  source: string;
  kind: string;
  amountIdr: string;
  category: string | null;
  categoryCode: string | null;
  paymentAccount: string | null;
  paymentCode: string | null;
  counterparty: string | null;
  cancelled: boolean;
  editable: boolean;
}

export interface Account {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
}

export interface PnlBucket {
  from: string;
  to: string;
  incomeIdr: string;
  expenseIdr: string;
  profitIdr: string;
  cashInIdr: string;
  cashOutIdr: string;
}

export interface Pnl {
  from: string;
  to: string;
  bucket: "day" | "week" | "month";
  buckets: PnlBucket[];
  total: {
    incomeIdr: string;
    expenseIdr: string;
    profitIdr: string;
    transactionCount: number;
    income: Array<{ code: string; name: string; amountIdr: string }>;
    expenses: Array<{ code: string; name: string; amountIdr: string }>;
  };
  cashFlow: { inIdr: string; outIdr: string; netIdr: string };
}

export interface ContactBalance {
  contactId: string;
  name: string;
  kind: "receivable" | "payable";
  balanceIdr: string;
  openItems: Array<{ journalId: string; date: string; description: string; amountIdr: string; openIdr: string }>;
  oldestOpenDate: string | null;
  lastPaymentDate: string | null;
}
