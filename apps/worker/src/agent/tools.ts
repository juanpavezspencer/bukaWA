import { z } from "zod/v4";
import { setBusinessScope, withAppRole, type Db, type Tx } from "@bukuwa/db";
import { agentTool, CATEGORY_NAMES, type AgentTool } from "@bukuwa/ai";
import { formatRupiah, similarContact, parseIdDate, parsePaymentMethod, parseRupiah, PERIOD_PRESETS, resolvePeriod, type PeriodPreset } from "@bukuwa/idn";
import { contacts } from "@bukuwa/db";
import {
  cashPosition,
  correctedDraft,
  findContact,
  findTransactions,
  openBalances,
  getJournalSummary,
  LedgerError,
  paymentAccountCode,
  profitAndLoss,
  type ContactBalance,
  type JournalSummary,
  type ProfitAndLoss,
} from "@bukuwa/ledger";
import { DEFAULT_CHART_OF_ACCOUNTS } from "@bukuwa/db";

/*
 * The tools the Q&A agent may call (spec 7.3). All read through RLS for one
 * business. Amounts go to the model pre-formatted ("Rp 1.250.000") so it can
 * copy them; every derived number (totals, differences, percentages) is
 * computed here, never by the model.
 */

export interface ToolContext {
  db: Db;
  businessId: string;
  today: string;
  /** The owner's message: corrected amounts must be copied from it. */
  message: string;
  /** Signs reminder drafts. */
  businessName?: string;
}

/** A correction the owner still has to confirm with a button. */
export interface CorrectionProposal {
  journalId: string;
  action: "cancel" | "change";
  amountIdr?: string;
  date?: string;
  paymentCode?: string;
  categoryCode?: string;
}

const rp = (n: bigint) => formatRupiah(n);
const signed = (n: bigint) => (n > 0n ? `+${rp(n)}` : n < 0n ? `-${rp(-n)}` : rp(0n));

/** Percent change as text, computed with integers ("+12,5%"); null when the base is zero. */
export function percentChange(current: bigint, previous: bigint): string | null {
  if (previous === 0n) return null;
  const base = previous < 0n ? -previous : previous;
  const tenths = ((current - previous) * 1000n) / base; // truncated toward zero
  const sign = tenths > 0n ? "+" : tenths < 0n ? "-" : "";
  const abs = tenths < 0n ? -tenths : tenths;
  const whole = abs / 10n;
  const frac = abs % 10n;
  return `${sign}${whole}${frac ? `,${frac}` : ""}%`;
}

const CATEGORY_CODE = new Map(DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.name, a.code]));
const KIND_LABEL: Record<string, string> = {
  sale: "pemasukan (penjualan)",
  expense: "pengeluaran",
  owner_capital: "tambah modal",
  owner_drawing: "prive (ambil pribadi)",
  receivable: "piutang (jual belum dibayar)",
  payable: "utang (beli belum dibayar)",
  settlement: "pelunasan utang/piutang",
  other: "lainnya",
};

async function read<T>(ctx: ToolContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withAppRole(ctx.db, async (tx) => {
    await setBusinessScope(tx, ctx.businessId);
    return fn(tx);
  });
}

const Period = z
  .object({
    preset: z.enum(PERIOD_PRESETS).nullable().describe("Named period relative to today. Use this when possible."),
    from: z.string().nullable().describe("Custom start, YYYY-MM-DD (only if no preset fits)."),
    to: z.string().nullable().describe("Custom end, YYYY-MM-DD, inclusive."),
  })
  .describe("Which dates. Weeks start Monday.");
type PeriodInput = z.infer<typeof Period>;

function rangeOf(p: PeriodInput, today: string): { from: string; to: string } | { error: string } {
  if (p.preset) return resolvePeriod(p.preset as PeriodPreset, today);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (p.from && p.to && iso.test(p.from) && iso.test(p.to) && p.from <= p.to) return { from: p.from, to: p.to > today ? today : p.to };
  return { error: "give a preset, or both from and to as YYYY-MM-DD with from <= to" };
}

function plView(pl: ProfitAndLoss) {
  return {
    period: { from: pl.from, to: pl.to },
    income: rp(pl.incomeIdr),
    expenses: rp(pl.expenseIdr),
    profit: rp(pl.profitIdr),
    transaction_count: pl.transactionCount,
    income_by_category: pl.income.map((a) => ({ category: a.name, amount: rp(a.amountIdr) })),
    expenses_by_category: pl.expenses.slice(0, 5).map((a) => ({ category: a.name, amount: rp(a.amountIdr) })),
  };
}

function txView(t: JournalSummary) {
  return {
    ref: t.id,
    date: t.date,
    description: t.description,
    type: KIND_LABEL[t.kind] ?? t.kind,
    amount: rp(t.amountIdr),
    category: t.category,
    paid_with: t.paymentAccount,
    counterparty: t.counterparty,
    cancelled: t.reversed,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const short = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/** The reminder an owner forwards to a customer. Built by code: the amounts come from the ledger. */
export function reminderText(businessName: string, b: ContactBalance): string {
  const items = b.openItems.slice(0, 5).map((i) => `• ${short(i.date)}, ${i.description}: ${rp(i.openIdr)}${i.openIdr < i.amountIdr ? " (sisa)" : ""}`);
  const more = b.openItems.length > 5 ? [`• dan ${b.openItems.length - 5} lainnya`] : [];
  return [
    `Halo ${b.name}, semoga sehat selalu 🙏`,
    `Mau mengingatkan, masih ada tagihan dari ${businessName} sebesar *${rp(b.balanceIdr)}*:`,
    ...items,
    ...more,
    "Kalau sudah transfer, kabari ya. Terima kasih banyak!",
  ].join("\n");
}

/** Exact name match first; otherwise a single loose match ("sari" ~ "Bu Sari"). */
async function lookupContact(tx: Tx, businessId: string, name: string): Promise<{ id: string; name: string } | undefined> {
  const exact = await findContact(tx, businessId, name);
  if (exact) return exact;
  const all = await tx.select({ id: contacts.id, name: contacts.name }).from(contacts);
  const hits = all.filter((c) => similarContact(c.name, name));
  return hits.length === 1 ? hits[0] : undefined;
}

export function buildTools(
  ctx: ToolContext,
  onProposal: (p: CorrectionProposal, summary: JournalSummary) => void,
  onReminder: (r: { contactName: string; text: string }) => void = () => {},
): AgentTool[] {
  const getPL = agentTool({
    name: "get_profit_and_loss",
    description:
      "Income (pemasukan), expenses (pengeluaran) and profit (laba/untung) for a period, with the biggest categories. " +
      "Pass compare_to to also get the other period and the change, already computed.",
    input: z.object({
      period: Period,
      compare_to: Period.nullable().describe("Optional second period to compare with (e.g. last_month)."),
    }),
    async run(i) {
      const a = rangeOf(i.period, ctx.today);
      if ("error" in a) return { output: a };
      const b = i.compare_to ? rangeOf(i.compare_to, ctx.today) : null;
      if (b && "error" in b) return { output: b };
      return read(ctx, async (tx) => {
        const cur = await profitAndLoss(tx, ctx.businessId, a);
        if (!b) return { output: plView(cur) };
        const prev = await profitAndLoss(tx, ctx.businessId, b);
        return {
          output: {
            current: plView(cur),
            compared_to: plView(prev),
            change: {
              income: signed(cur.incomeIdr - prev.incomeIdr),
              expenses: signed(cur.expenseIdr - prev.expenseIdr),
              profit: signed(cur.profitIdr - prev.profitIdr),
              profit_percent: percentChange(cur.profitIdr, prev.profitIdr),
              income_percent: percentChange(cur.incomeIdr, prev.incomeIdr),
            },
          },
        };
      });
    },
  });

  const getCash = agentTool({
    name: "get_cash_position",
    description: "Current balances of Kas (cash), Bank and E-wallet, and their total, as of today.",
    input: z.object({}),
    async run() {
      return read(ctx, async (tx) => {
        const cp = await cashPosition(tx, ctx.businessId, ctx.today);
        return {
          output: {
            as_of: cp.asOf,
            accounts: cp.accounts.map((a) => ({ account: a.name, balance: rp(a.balanceIdr) })),
            total: rp(cp.totalIdr),
          },
        };
      });
    },
  });

  const list = agentTool({
    name: "list_transactions",
    description:
      "Find recorded entries, newest first. Use for 'what did I spend on X', 'show yesterday's sales', and to find the entry an owner wants to correct. " +
      "Each result has a ref to use with propose_correction. Count and total are computed for you.",
    input: z.object({
      period: Period.nullable(),
      text: z.string().nullable().describe("Words in the description or customer/supplier name, e.g. 'ayam' or 'Bu Sari'."),
      category: z.enum(CATEGORY_NAMES).nullable(),
      type: z.enum(["sale", "expense", "owner_capital", "owner_drawing", "receivable", "payable", "settlement"]).nullable(),
      include_cancelled: z.boolean().nullable().describe("Default true; cancelled entries are marked."),
      limit: z.number().int().min(1).max(50).nullable(),
    }),
    async run(i) {
      const range = i.period ? rangeOf(i.period, ctx.today) : null;
      if (range && "error" in range) return { output: range };
      return read(ctx, async (tx) => {
        const found = await findTransactions(tx, ctx.businessId, {
          ...(range ?? {}),
          text: i.text ?? undefined,
          accountCode: i.category ? CATEGORY_CODE.get(i.category) : undefined,
          kind: i.type ?? undefined,
          includeReversed: i.include_cancelled ?? true,
          limit: i.limit ?? 10,
        });
        const shown = found.transactions;
        return {
          output: {
            count: found.count,
            total: rp(found.totalIdr),
            note: found.matched > shown.length ? `showing ${shown.length} of ${found.matched}` : undefined,
            transactions: shown.map(txView),
          },
        };
      });
    },
  });

  const openItems = agentTool({
    name: "get_open_items",
    description:
      "Receivables (piutang: customers who haven't paid, 'siapa yang belum bayar') and payables (utang: what the owner still owes suppliers). " +
      "Balances per contact with the oldest unpaid date and the open items; totals computed for you.",
    input: z.object({
      kind: z.enum(["receivable", "payable"]).nullable().describe("receivable = piutang, payable = utang; null for both."),
      contact: z.string().nullable().describe("A customer or supplier name, e.g. 'Bu Sari'; null for everyone."),
    }),
    async run(i) {
      return read(ctx, async (tx) => {
        let contactId: string | undefined;
        if (i.contact) {
          const c = await lookupContact(tx, ctx.businessId, i.contact);
          if (!c) return { output: { contacts: [], note: `no contact named "${i.contact}" has any recorded debt` } };
          contactId = c.id;
        }
        const all = await openBalances(tx, ctx.businessId, { kind: i.kind ?? undefined, contactId });
        const total = (k: "receivable" | "payable") => rp(all.filter((b) => b.kind === k && b.balanceIdr > 0n).reduce((s, b) => s + b.balanceIdr, 0n));
        return {
          output: {
            ...(i.kind !== "payable" ? { total_receivable: total("receivable") } : {}),
            ...(i.kind !== "receivable" ? { total_payable: total("payable") } : {}),
            ...(i.kind ? { total: total(i.kind) } : {}),
            contacts: all.slice(0, 20).map((b) => ({
              name: b.name,
              type: b.kind === "receivable" ? "piutang (dia utang ke owner)" : "utang (owner utang ke dia)",
              balance: b.balanceIdr < 0n ? `lebih bayar ${rp(-b.balanceIdr)}` : rp(b.balanceIdr),
              since: b.oldestOpenDate,
              last_payment: b.lastPaymentDate,
              open_items: b.openItems.slice(0, 5).map((o) => ({ date: o.date, description: o.description, remaining: rp(o.openIdr) })),
            })),
            note: all.length > 20 ? `showing 20 of ${all.length} contacts` : undefined,
          },
        };
      });
    },
  });

  const reminder = agentTool({
    name: "draft_reminder",
    description:
      "Write a polite payment reminder for a customer who owes the owner, for the owner to forward. The text is generated for you and sent " +
      "to the owner automatically; after this succeeds, stop.",
    input: z.object({ contact: z.string().describe("The customer's name as the owner wrote it.") }),
    async run(i) {
      const found = await read(ctx, async (tx) => {
        const c = await lookupContact(tx, ctx.businessId, i.contact);
        if (!c) return undefined;
        const [b] = await openBalances(tx, ctx.businessId, { contactId: c.id, kind: "receivable" });
        return b;
      });
      if (!found || found.balanceIdr <= 0n) return { output: { error: `${i.contact} has no unpaid receivable` } };
      onReminder({ contactName: found.name, text: reminderText(ctx.businessName ?? "kami", found) });
      return { output: { status: "reminder draft will be sent to the owner" }, stop: true };
    },
  });

  const propose = agentTool({
    name: "propose_correction",
    description:
      "Prepare a correction of one recorded entry for the owner to confirm with a button. Nothing changes until they press OK. " +
      "action 'cancel' removes the entry (a reversing entry is posted). action 'change' replaces it with a corrected copy. " +
      "For a new amount, copy the amount exactly as the owner wrote it (e.g. '45rb') into new_amount_text. " +
      "Call list_transactions first to get the ref. After this succeeds, stop: the confirmation card is sent automatically.",
    input: z.object({
      ref: z.string(),
      action: z.enum(["cancel", "change"]),
      new_amount_text: z.string().nullable(),
      new_date_text: z.string().nullable().describe("As the owner wrote it, e.g. 'kemarin' or '10/11'."),
      new_payment_text: z.string().nullable().describe("As the owner wrote it, e.g. 'cash' or 'tf bca'."),
      new_category: z.enum(CATEGORY_NAMES).nullable(),
    }),
    async run(i) {
      const summary = await read(ctx, (tx) => getJournalSummary(tx, ctx.businessId, i.ref));
      if (!summary) return { output: { error: "no entry with that ref; call list_transactions" } };
      if (summary.reversed) return { output: { error: "that entry is already cancelled" } };

      const p: CorrectionProposal = { journalId: summary.id, action: i.action };
      if (i.action === "change") {
        const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");
        if (i.new_amount_text) {
          // Same rule as capture: the amount must be the owner's own words, parsed by code.
          if (!squash(ctx.message).includes(squash(i.new_amount_text))) {
            return { output: { error: "new_amount_text must be copied exactly from the owner's message" } };
          }
          const amt = parseRupiah(i.new_amount_text);
          if (amt === null || amt <= 0n) return { output: { error: `can't read "${i.new_amount_text}" as an amount; ask the owner` } };
          p.amountIdr = amt.toString();
        }
        if (i.new_date_text) {
          const d = parseIdDate(i.new_date_text, ctx.today);
          if (!d) return { output: { error: `can't read "${i.new_date_text}" as a past date; ask the owner` } };
          p.date = d;
        }
        if (i.new_payment_text) {
          const code = paymentAccountCode(parsePaymentMethod(i.new_payment_text));
          if (!code) return { output: { error: `can't read "${i.new_payment_text}" as a payment method` } };
          p.paymentCode = code;
        }
        if (i.new_category) p.categoryCode = CATEGORY_CODE.get(i.new_category);
        try {
          correctedDraft(ctx.businessId, summary, {
            amountIdr: p.amountIdr ? BigInt(p.amountIdr) : undefined,
            date: p.date,
            paymentCode: p.paymentCode,
            categoryCode: p.categoryCode,
          });
        } catch (err) {
          if (err instanceof LedgerError) return { output: { error: err.message } };
          throw err;
        }
      }
      onProposal(p, summary);
      return { output: { status: "confirmation card will be sent to the owner" }, stop: true };
    },
  });

  return [getPL, getCash, list, openItems, reminder, propose];
}
