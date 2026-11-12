import { z } from "zod/v4";
import { maskSensitiveIds } from "@bukuwa/idn";
import type { AiConfig } from "./config.js";
import type { StructuredModel } from "./model.js";

export const INTENTS = ["transaction", "question", "correction", "command", "chitchat", "unsupported"] as const;
export type Intent = (typeof INTENTS)[number];

export const RouterOutput = z.object({ intent: z.enum(INTENTS) });

export const ROUTER_PROMPT_VERSION = "router-v1";

export const ROUTER_SYSTEM = `You classify WhatsApp messages sent by Indonesian small-business owners to their bookkeeping assistant. Messages are casual Bahasa Indonesia, often with slang, abbreviations and typos (rb/ribu/k = thousand, jt = million, tf = transfer, td = tadi, kmrn = kemarin).

Return exactly one intent:
- transaction: the owner reports money that moved or a debt: a sale, purchase, expense, payment, transfer, salary, rent, owner putting in or taking out money, someone owing money. Examples: "jual nasi box 25 x 18rb tf bca", "belanja ayam 175rb cash", "bayar listrik 350rb", "Bu Sari utang 350rb", "ambil 200rb buat pribadi", "gaji karyawan 1,5jt".
- question: asks about their books or numbers. Examples: "untung minggu ini berapa?", "siapa yang belum bayar?", "pengeluaran bulan lalu?".
- correction: says a previous entry was wrong or should be removed. Examples: "yang tadi salah, harusnya 45rb", "hapus yang terakhir".
- command: asks the bot to do a setting or action, or asks for help. Examples: "bantuan", "menu", "kirim laporan", "ganti jam ringkasan".
- chitchat: greetings, thanks, small talk. Examples: "makasih", "halo", "pagi kak".
- unsupported: anything else.

If a message contains both a greeting and a transaction, it is a transaction.`;

export async function routeMessage(model: StructuredModel, cfg: AiConfig, text: string): Promise<{ intent: Intent; modelVersion: string }> {
  const r = await model.generate({
    model: cfg.routerModel,
    effort: cfg.routerEffort,
    system: ROUTER_SYSTEM,
    user: `<message>\n${maskSensitiveIds(text)}\n</message>`,
    schema: RouterOutput,
    maxTokens: 4096, // headroom for adaptive thinking
  });
  return { intent: r.output.intent, modelVersion: `${r.model}/${ROUTER_PROMPT_VERSION}` };
}
