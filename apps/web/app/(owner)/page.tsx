"use client";

import { useEffect, useState } from "react";
import { PnlChart } from "@/components/pnl-chart";
import { useBusiness } from "@/components/session";
import { Card, Notice, Segmented } from "@/components/ui";
import { api, type Pnl } from "@/lib/api";
import { dateLong, presetRange, rp, type Bucket, type Preset } from "@/lib/format";

const PRESETS: Array<[Preset, string]> = [
  ["7d", "7 hari"],
  ["30d", "30 hari"],
  ["month", "Bulan ini"],
  ["lastMonth", "Bulan lalu"],
  ["year", "Tahun ini"],
];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-sm text-ink-2">{label}</div>
      <div className="num mt-1 whitespace-nowrap text-lg font-semibold sm:text-xl">{value}</div>
      {sub && <div className="num mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

export default function Ringkasan() {
  const { business } = useBusiness();
  const [preset, setPreset] = useState<Preset>("month");
  const [bucket, setBucket] = useState<Bucket>(presetRange("month", business.today).bucket);
  const [data, setData] = useState<Pnl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const range = presetRange(preset, business.today);

  useEffect(() => {
    setError(null);
    api<Pnl>(`/api/reports/pnl?from=${range.from}&to=${range.to}&bucket=${bucket}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [range.from, range.to, bucket]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Periode" value={preset} options={PRESETS} onChange={(p) => { setPreset(p); setBucket(presetRange(p, business.today).bucket); }} />
        <Segmented label="Per" value={bucket} options={[["day", "Harian"], ["week", "Mingguan"], ["month", "Bulanan"]]} onChange={setBucket} />
      </div>
      <p className="text-sm text-ink-3">{dateLong(range.from)} – {dateLong(range.to)}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Pemasukan" value={rp(data.total.incomeIdr)} />
            <Stat label="Pengeluaran" value={rp(data.total.expenseIdr)} />
            <Stat label="Laba" value={rp(data.total.profitIdr)} sub={`dari ${data.total.transactionCount} transaksi`} />
            <Stat label="Arus kas bersih" value={rp(data.cashFlow.netIdr)} sub={`masuk ${rp(data.cashFlow.inIdr)} · keluar ${rp(data.cashFlow.outIdr)}`} />
          </div>
          <Card title="Pemasukan & pengeluaran">
            <PnlChart buckets={data.buckets} unit={data.bucket} />
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Pemasukan per kategori">
              <Breakdown rows={data.total.income} />
            </Card>
            <Card title="Pengeluaran per kategori">
              <Breakdown rows={data.total.expenses} />
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function Breakdown({ rows }: { rows: Array<{ code: string; name: string; amountIdr: string }> }) {
  if (!rows.length) return <p className="text-sm text-ink-3">Belum ada.</p>;
  return (
    <ul className="num divide-y divide-line text-sm">
      {rows.map((r) => (
        <li key={r.code} className="flex justify-between py-2"><span className="text-ink-2">{r.name}</span><span>{rp(r.amountIdr)}</span></li>
      ))}
    </ul>
  );
}
