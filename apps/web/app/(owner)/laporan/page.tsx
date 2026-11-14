"use client";

import { useState } from "react";
import { useBusiness } from "@/components/session";
import { Button, Card, inputCls, Notice, Segmented } from "@/components/ui";
import { api } from "@/lib/api";
import { monthLong, recentMonths } from "@/lib/format";

export default function LaporanPage() {
  const { business, exportsEnabled } = useBusiness();
  const months = recentMonths(business.today);
  const [month, setMonth] = useState(months[1] ?? months[0]!);
  const [format, setFormat] = useState<"pdf" | "xlsx">("pdf");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; fileName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<{ url: string; fileName: string }>("/api/exports", { method: "POST", body: JSON.stringify({ month, format }) });
      setResult(r);
      window.open(r.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Laporan bulanan">
      <p className="mb-4 text-sm text-ink-2">Laba rugi, daftar transaksi dan estimasi pajak satu bulan. PDF untuk dibaca, Excel untuk diolah.</p>
      {!exportsEnabled ? (
        <Notice>Ekspor belum aktif.</Notice>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select className={`${inputCls} w-auto`} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Bulan">
            {months.map((m) => <option key={m} value={m}>{monthLong(m)}{m === months[0] ? " (berjalan)" : ""}</option>)}
          </select>
          <Segmented label="Format" value={format} options={[["pdf", "PDF"], ["xlsx", "Excel"]]} onChange={setFormat} />
          <Button onClick={go} disabled={busy}>{busy ? "Menyiapkan…" : "Unduh"}</Button>
        </div>
      )}
      {result && (
        <p className="mt-3 text-sm text-ink-2">
          Siap: <a className="underline" href={result.url} target="_blank" rel="noopener noreferrer">{result.fileName}</a> (link berlaku 15 menit)
        </p>
      )}
      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
    </Card>
  );
}
