import ExcelJS from "exceljs";
import { asc, eq, sql } from "drizzle-orm";
import { accounts, auditLog, businesses, captures, contacts, journalLines, journals, messages, reports, rows, users, type Tx } from "@bukuwa/db";
import { MIME } from "./generate.js";

/*
 * "ekspor data" (UU PDP: the owner can take their data with them). One Excel
 * workbook with everything kept about the business: the ledger line by line,
 * contacts, the chat log, what was captured from photos and voice notes, and
 * the consent / audit trail. Also sent before an erasure. Stored as a report
 * row so the usual signed, expiring link serves it.
 */

const RUPIAH = '"Rp" #,##0;[Red]-"Rp" #,##0';

function idr(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`amount too large for a spreadsheet cell: ${n}`);
  return Number(n);
}

function sheet(wb: ExcelJS.Workbook, name: string, columns: Array<Partial<ExcelJS.Column>>) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  return ws;
}

export interface DataExportOptions {
  now: Date;
  actor: string;
  createdBy?: string;
  /** Decrypts stored phone numbers (owner, contacts) so the owner gets them back. */
  decryptPhone: (enc: Buffer) => string;
}

export async function generateDataExport(tx: Tx, businessId: string, o: DataExportOptions): Promise<{ reportId: string; fileName: string; bytes: number }> {
  const [b] = await tx.select().from(businesses).where(eq(businesses.id, businessId));
  if (!b) throw new Error("business not found");
  const owner = (await tx.select().from(users).where(eq(users.businessId, businessId)))[0];
  const wb = new ExcelJS.Workbook();
  wb.creator = "BukuWA";
  wb.created = o.now;

  const info = sheet(wb, "Info", [
    { header: "Data", key: "k", width: 28 },
    { header: "Isi", key: "v", width: 48 },
  ]);
  info.addRows([
    { k: "Nama usaha", v: b.name },
    { k: "Jenis usaha", v: b.type },
    { k: "Nomor WhatsApp pemilik", v: o.decryptPhone(b.ownerPhoneEnc) },
    { k: "Terdaftar sejak", v: b.createdAt },
    { k: "Paket", v: b.plan },
    { k: "Persetujuan privasi", v: owner?.consentAt ?? "" },
    { k: "Versi kebijakan privasi", v: owner?.consentVersion ?? "" },
    { k: "Diekspor pada", v: o.now },
  ]);

  const ledger = sheet(wb, "Jurnal", [
    { header: "Tanggal", key: "date", width: 12 },
    { header: "No. jurnal", key: "journal", width: 38 },
    { header: "Keterangan", key: "description", width: 36 },
    { header: "Sumber", key: "source", width: 10 },
    { header: "Kode akun", key: "code", width: 10 },
    { header: "Akun", key: "account", width: 26 },
    { header: "Debit", key: "debit", width: 16, style: { numFmt: RUPIAH } },
    { header: "Kredit", key: "credit", width: 16, style: { numFmt: RUPIAH } },
    { header: "Kontak", key: "contact", width: 22 },
    { header: "Membatalkan jurnal", key: "reverses", width: 38 },
    { header: "Dicatat", key: "createdAt", width: 20 },
  ]);
  const lines = await tx
    .select({
      date: journals.date,
      journal: journals.id,
      description: journals.description,
      source: journals.source,
      reverses: journals.reversesJournalId,
      createdAt: journals.createdAt,
      code: accounts.code,
      account: accounts.name,
      debit: journalLines.debit,
      credit: journalLines.credit,
      contact: contacts.name,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(contacts, eq(contacts.id, journalLines.contactId))
    .where(eq(journalLines.businessId, businessId))
    .orderBy(asc(journals.date), asc(journals.createdAt), asc(journalLines.lineNo));
  for (const l of lines) {
    ledger.addRow({ ...l, debit: idr(l.debit), credit: idr(l.credit), contact: l.contact ?? "", reverses: l.reverses ?? "" });
  }

  const people = sheet(wb, "Kontak", [
    { header: "Nama", key: "name", width: 28 },
    { header: "Jenis", key: "kind", width: 12 },
    { header: "Nomor HP", key: "phone", width: 18 },
    { header: "Dibuat", key: "createdAt", width: 20 },
  ]);
  for (const c of await tx.select().from(contacts).where(eq(contacts.businessId, businessId)).orderBy(asc(contacts.name))) {
    people.addRow({ name: c.name, kind: c.kind, phone: c.phoneEnc ? o.decryptPhone(c.phoneEnc) : "", createdAt: c.createdAt });
  }

  const chat = sheet(wb, "Pesan", [
    { header: "Waktu", key: "createdAt", width: 20 },
    { header: "Arah", key: "direction", width: 10 },
    { header: "Jenis", key: "type", width: 12 },
    { header: "Isi", key: "body", width: 80 },
  ]);
  for (const m of await tx.select().from(messages).where(eq(messages.businessId, businessId)).orderBy(asc(messages.createdAt))) {
    chat.addRow({ createdAt: m.createdAt, direction: m.direction === "inbound" ? "masuk" : "keluar", type: m.templateName ?? m.type, body: m.body ?? "" });
  }

  const caps = sheet(wb, "Catatan dari chat", [
    { header: "Waktu", key: "createdAt", width: 20 },
    { header: "Sumber", key: "source", width: 10 },
    { header: "Teks", key: "rawText", width: 50 },
    { header: "Transkrip voice note", key: "transcript", width: 50 },
    { header: "Status", key: "status", width: 22 },
    { header: "No. jurnal", key: "journalId", width: 38 },
  ]);
  for (const c of await tx.select().from(captures).where(eq(captures.businessId, businessId)).orderBy(asc(captures.createdAt))) {
    caps.addRow({ createdAt: c.createdAt, source: c.source, rawText: c.rawText ?? "", transcript: c.transcript ?? "", status: c.status, journalId: c.journalId ?? "" });
  }

  const trail = sheet(wb, "Riwayat", [
    { header: "Waktu", key: "at", width: 20 },
    { header: "Aksi", key: "action", width: 28 },
    { header: "Oleh", key: "actor", width: 38 },
  ]);
  for (const a of await tx.select().from(auditLog).where(eq(auditLog.businessId, businessId)).orderBy(asc(auditLog.at))) {
    trail.addRow({ at: a.at, action: a.action, actor: a.actor });
  }

  const content = Buffer.from(await wb.xlsx.writeBuffer());
  const today = o.now.toISOString().slice(0, 10);
  const [first] = rows<{ d: string | null }>(await tx.execute(sql`select min(date)::text as d from journals where business_id = ${businessId}`));
  const slug = b.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "usaha";
  const fileName = `data-${slug}-${today}.xlsx`;
  const from = first?.d && first.d < today ? first.d : today;
  const [row] = await tx
    .insert(reports)
    .values({ businessId, kind: "data_export", format: "xlsx", periodFrom: from, periodTo: today, fileName, mimeType: MIME.xlsx, content, createdBy: o.createdBy })
    .returning({ id: reports.id });
  await tx.insert(auditLog).values({
    businessId,
    actor: o.actor,
    action: "privacy.export",
    entity: "report",
    entityId: row!.id,
    after: { bytes: content.byteLength, journalLines: lines.length },
  });
  return { reportId: row!.id, fileName, bytes: content.byteLength };
}
