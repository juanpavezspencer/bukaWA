"use client";

import { useEffect, useState } from "react";
import { Card, Notice } from "@/components/ui";
import { api, type ContactBalance } from "@/lib/api";
import { dateLong, rp } from "@/lib/format";

export default function KontakPage() {
  const [rows, setRows] = useState<ContactBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ contacts: ContactBalance[] }>("/api/contacts").then((r) => setRows(r.contacts)).catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!rows) return <p className="text-ink-3">Memuat…</p>;
  const group = (k: ContactBalance["kind"]) => rows.filter((r) => r.kind === k);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <List title="Piutang (pelanggan belum bayar)" rows={group("receivable")} empty="Nggak ada piutang. Mantap!" />
      <List title="Utang (belum kamu bayar)" rows={group("payable")} empty="Nggak ada utang ke supplier." />
    </div>
  );
}

function List({ title, rows, empty }: { title: string; rows: ContactBalance[]; empty: string }) {
  const total = rows.reduce((s, r) => s + BigInt(r.balanceIdr), 0n);
  return (
    <Card title={title} action={rows.length ? <span className="num text-sm font-semibold">{rp(total)}</span> : undefined}>
      {!rows.length && <p className="text-sm text-ink-3">{empty}</p>}
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.contactId} className="py-3">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{r.name}</span>
              <span className="num font-semibold">{rp(r.balanceIdr)}</span>
            </div>
            <div className="text-xs text-ink-3">
              {r.oldestOpenDate && `Sejak ${dateLong(r.oldestOpenDate)}`}
              {r.lastPaymentDate && ` · bayar terakhir ${dateLong(r.lastPaymentDate)}`}
            </div>
            {r.openItems.length > 0 && (
              <ul className="num mt-1 space-y-0.5 text-xs text-ink-2">
                {r.openItems.map((i) => (
                  <li key={i.journalId} className="flex justify-between"><span>{dateLong(i.date)} · {i.description}</span><span>{rp(i.openIdr)}</span></li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
