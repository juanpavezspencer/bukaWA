import { runAgent, type AiConfig, type ChatModel } from "@bukuwa/ai";
import type { JournalSummary } from "@bukuwa/ledger";
import type { Db } from "@bukuwa/db";
import { buildTools, type CorrectionProposal } from "./tools.js";

export const AGENT_PROMPT_VERSION = "agent-v2";

export const AGENT_SYSTEM = `You are BukuWA, the bookkeeping assistant of an Indonesian small business, answering the owner on WhatsApp. The owner asks about their books ("untung minggu ini berapa?", "pengeluaran bulan ini buat apa aja?", "saldo kas berapa?") or wants to fix a recorded entry ("yang tadi salah, harusnya 45rb", "hapus yang terakhir").

Rules:
- Every number you state must be copied exactly from a tool result (amounts as formatted, e.g. "Rp 1.250.000"). Never add, subtract, average, round, estimate or convert numbers yourself; if you need a total, difference or percentage, call the tool option that returns it (get_profit_and_loss with compare_to, list_transactions count and total).
- Receivables and payables: get_open_items ("siapa yang belum bayar?", "piutang Bu Sari berapa?", "utang ke supplier berapa?"). To remind a customer ("tagih Bu Sari", "buatin pesan tagihan"), call draft_reminder; it sends the draft itself.
- If the tools don't cover something, say so plainly. Not available yet: tax estimates, PDF/Excel reports, stock. Say these are coming soon.
- Use the owner's dates: weeks start Monday; "minggu ini" = this_week, "bulan lalu" = last_month, "kemarin" = yesterday.
- Corrections: find the entry with list_transactions (usually the most recent matching one; "yang tadi"/"yang terakhir" means the newest), then call propose_correction once. If it is unclear which entry they mean, or what the new value is, ask a short question instead of guessing. Never claim something was changed: the owner confirms with a button.
- Reply in short, casual Bahasa Indonesia (like a helpful friend, "kak" is fine), 1-5 lines, WhatsApp formatting (*bold* for the key number). No tables, no markdown headings.`;

export type AskResult =
  | { kind: "answer"; text: string; modelVersion: string; outcome: string }
  | { kind: "proposal"; proposal: CorrectionProposal; summary: JournalSummary; modelVersion: string }
  | { kind: "reminder"; contactName: string; text: string; modelVersion: string };

export const ASK_FALLBACK =
  'Maaf, aku belum bisa jawab itu dari catatanmu. Coba tanya dengan cara lain, misalnya "untung minggu ini berapa?" atau "pengeluaran kemarin apa aja?"';

export async function askBooks(
  chat: ChatModel,
  cfg: AiConfig,
  ctx: { db: Db; businessId: string; businessName?: string; today: string; text: string },
): Promise<AskResult> {
  let proposal: { p: CorrectionProposal; s: JournalSummary } | undefined;
  let reminder: { contactName: string; text: string } | undefined;
  const tools = buildTools(
    { db: ctx.db, businessId: ctx.businessId, today: ctx.today, message: ctx.text, businessName: ctx.businessName },
    (p, s) => {
      proposal = { p, s };
    },
    (r) => {
      reminder = r;
    },
  );
  const run = await runAgent(chat, {
    model: cfg.agentModel,
    effort: cfg.agentEffort,
    system: AGENT_SYSTEM,
    user: [`Today is ${ctx.today}.`, ctx.businessName ? `Business: ${ctx.businessName}` : null, `<message>\n${ctx.text}\n</message>`]
      .filter(Boolean)
      .join("\n"),
    question: ctx.text,
    tools,
    fallback: ASK_FALLBACK,
  });
  const modelVersion = `${run.model}/${AGENT_PROMPT_VERSION}`;
  if (run.outcome === "tool_stop" && proposal) return { kind: "proposal", proposal: proposal.p, summary: proposal.s, modelVersion };
  if (run.outcome === "tool_stop" && reminder) return { kind: "reminder", ...reminder, modelVersion };
  return { kind: "answer", text: run.text ?? ASK_FALLBACK, modelVersion, outcome: run.outcome };
}
