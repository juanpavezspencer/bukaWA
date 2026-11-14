import { createAdminLoginToken, createLoginToken, type Tx } from "@bukuwa/db";
import type { OutboundMessage } from "@bukuwa/wa";

/*
 * Magic-link login sent via WhatsApp (milestone 7). The owner types
 * "dashboard"; the bot answers with a one-time link. The token sits in the URL
 * fragment, so it never reaches server or proxy logs, and the messages log
 * keeps a redacted copy.
 */

export interface DashboardDeps {
  /** Origin of apps/web, e.g. https://app.bukuwa.id */
  webBaseUrl: string;
  loginTtlMinutes: number;
  adminLoginTtlMinutes: number;
  /** HMACs of the staff numbers allowed into the admin console (config). */
  adminPhoneHashes: ReadonlySet<string>;
}

const normalize = (t: string) =>
  t
    .toLowerCase()
    .replace(/[?!.,]+/g, " ")
    .replace(/\b(dong|ya|kak|minta|tolong|mau|aku|saya|ke|link|linknya|buka|kirim|kirimin)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const OWNER = new Set(["dashboard", "dasbor", "dashbor", "login", "masuk", "masuk dashboard", "login dashboard", "web"]);

export function isDashboardRequest(text: string): boolean {
  return OWNER.has(normalize(text));
}

export function isAdminRequest(text: string): boolean {
  return normalize(text) === "admin";
}

const base = (d: DashboardDeps) => d.webBaseUrl.replace(/\/+$/, "");

export async function dashboardLink(tx: Tx, d: DashboardDeps, a: { businessId: string; userId: string; now: Date }): Promise<OutboundMessage[]> {
  const token = await createLoginToken(tx, { ...a, ttlMs: d.loginTtlMinutes * 60_000 });
  const tail =
    `\n\nBerlaku ${d.loginTtlMinutes} menit dan cuma bisa dipakai sekali. Jangan diteruskan ke orang lain ya, ` +
    "link ini bisa buka semua catatan usahamu. Di sana kamu bisa lihat transaksi, laba rugi, kontak dan download laporan.";
  return [
    {
      kind: "text",
      body: `Ini link masuk dashboard kamu 👇\n${base(d)}/masuk#t=${token}${tail}`,
      logBody: `Ini link masuk dashboard kamu 👇\n${base(d)}/masuk#t=[redacted]${tail}`,
    },
  ];
}

export async function adminLink(tx: Tx, d: DashboardDeps, a: { phoneHash: string; now: Date }): Promise<OutboundMessage[]> {
  const token = await createAdminLoginToken(tx, { ...a, ttlMs: d.adminLoginTtlMinutes * 60_000 });
  return [{ kind: "text", body: `Admin console: ${base(d)}/admin/masuk#t=${token}\nBerlaku ${d.adminLoginTtlMinutes} menit, sekali pakai.` }];
}
