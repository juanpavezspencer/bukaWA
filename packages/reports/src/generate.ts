import { auditLog, reports, type Tx } from "@bukuwa/db";
import { reportFileName } from "./format.js";
import { buildMonthlyReport, type MonthlyReport } from "./monthly.js";
import { renderReportPdf } from "./pdf.js";
import type { TaxSettings } from "./tax.js";
import { renderReportXlsx } from "./xlsx.js";

export type ReportFormat = "pdf" | "xlsx";

export const MIME: Record<ReportFormat, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export interface GeneratedReport {
  reportId: string;
  fileName: string;
  bytes: number;
  report: MonthlyReport;
}

/**
 * Build, render and store one monthly report, and audit the export (spec
 * 8.2). Runs in the caller's business-scoped transaction.
 */
export async function generateMonthlyReport(
  tx: Tx,
  businessId: string,
  args: {
    month: string;
    format: ReportFormat;
    today: string;
    now: Date;
    actor: string;
    createdBy?: string;
    evidenceUrl: (captureId: string) => string;
  } & TaxSettings,
): Promise<GeneratedReport> {
  const report = await buildMonthlyReport(tx, businessId, args);
  const content = args.format === "pdf" ? await renderReportPdf(report) : await renderReportXlsx(report);
  const fileName = reportFileName(report.businessName, args.month, args.format);
  const [row] = await tx
    .insert(reports)
    .values({
      businessId,
      kind: "monthly",
      format: args.format,
      periodFrom: report.period.from,
      periodTo: report.period.to,
      fileName,
      mimeType: MIME[args.format],
      content: Buffer.from(content),
      createdBy: args.createdBy,
    })
    .returning({ id: reports.id });
  await tx.insert(auditLog).values({
    businessId,
    actor: args.actor,
    action: "report.export",
    entity: "report",
    entityId: row!.id,
    after: {
      kind: "monthly",
      format: args.format,
      month: args.month,
      period: report.period,
      bytes: content.byteLength,
      taxIdr: report.tax.taxIdr.toString(),
      turnoverIdr: report.tax.turnoverIdr.toString(),
    },
  });
  return { reportId: row!.id, fileName, bytes: content.byteLength, report };
}
