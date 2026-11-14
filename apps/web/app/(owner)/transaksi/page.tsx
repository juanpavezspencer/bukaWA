"use client";

import { useCallback, useEffect, useState } from "react";
import { useBusiness } from "@/components/session";
import { Button, Card, inputCls, Notice } from "@/components/ui";
import { api, type Account, type Transaction } from "@/lib/api";
import { addDays, dateLong, KIND_LABEL, parseRupiahInput, rp } from "@/lib/format";

interface Found {
  transactions: Transaction[];
  matched: number;
  count: number;
  totalIdr: string;
}

const KINDS = ["", "sale", "expense", "receivable", "payable", "settlement", "owner_capital", "owner_drawing"];

export default function TransaksiPage() {
  const { business } = useBusiness();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState(addDays(business.today, -29));
  const [to, setTo] = useState(business.today);
  const [data, setData] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    const p = new URLSearchParams({ from, to, limit: "100" });
    if (q.trim()) p.set("q", q.trim());
    if (kind) p.set("kind", kind);
    api<Found>(`/api/transactions?${p}`).then(setData).catch((e: Error) => setError(e.message));
  }, [q, kind, from, to]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    api<{ accounts: Account[] }>("/api/accounts").then((r) => setAccounts(r.accounts)).catch(() => {});
  }, []);

  const cancel = async (t: Transaction) => {
    if (!confirm(`Hapus "${t.description}" ${rp(t.amountIdr)}?\n\nTransaksi nggak dihapus dari buku, tapi dibatalkan dengan catatan pembatalan.`)) return;
    try {
      await api(`/api/transactions/${t.id}/cancel`, { method: "POST", idempotent: true });
      setFlash("Transaksi dibatalkan ✅");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <input className={inputCls} placeholder="Cari: ayam, Bu Sari, listrik…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari transaksi" />
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Jenis">
          {KINDS.map((k) => <option key={k} value={k}>{k ? KIND_LABEL[k] : "Semua jenis"}</option>)}
        </select>
        <input type="date" className={inputCls} value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Dari" />
        <input type="date" className={inputCls} value={to} min={from} max={business.today} onChange={(e) => setTo(e.target.value)} aria-label="Sampai" />
      </div>
      {flash && <Notice>{flash}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {data && (
        <Card
          title={kind ? `${data.count} transaksi aktif · total ${rp(data.totalIdr)}` : `${data.count} transaksi aktif`}
          action={data.matched > data.transactions.length ? <span className="text-xs text-ink-3">menampilkan {data.transactions.length} terbaru</span> : undefined}
        >
          {!data.transactions.length && <p className="text-sm text-ink-3">Nggak ada transaksi yang cocok.</p>}
          <ul className="divide-y divide-line">
            {data.transactions.map((t) => (
              <li key={t.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-3 ${t.cancelled ? "opacity-60" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className={`truncate font-medium ${t.cancelled ? "line-through" : ""}`}>{t.description}</div>
                  <div className="text-xs text-ink-3">
                    {dateLong(t.date)} · {KIND_LABEL[t.kind]}{t.category && t.category !== KIND_LABEL[t.kind] ? ` · ${t.category}` : ""}{t.paymentAccount ? ` · ${t.paymentAccount}` : ""}
                    {t.cancelled && " · dibatalkan"}
                  </div>
                </div>
                <div className={`num font-semibold ${t.kind === "sale" ? "" : "text-ink-2"}`}>{t.kind === "expense" ? "-" : ""}{rp(t.amountIdr)}</div>
                {!t.cancelled && (
                  <div className="flex gap-1">
                    {t.editable && <Button variant="ghost" onClick={() => { setFlash(null); setEditing(t); }}>Edit</Button>}
                    <Button variant="danger" onClick={() => cancel(t)}>Hapus</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && (
        <EditDialog
          tx={editing}
          accounts={accounts}
          today={business.today}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setFlash("Transaksi dikoreksi ✅ Yang lama dibatalkan, diganti yang benar."); load(); }}
        />
      )}
    </>
  );
}

function EditDialog({ tx, accounts, today, onClose, onSaved }: { tx: Transaction; accounts: Account[]; today: string; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState(tx.amountIdr);
  const [date, setDate] = useState(tx.date);
  const [paymentCode, setPaymentCode] = useState(tx.paymentCode ?? "");
  const [categoryCode, setCategoryCode] = useState(tx.categoryCode ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const money = accounts.filter((a) => ["1100", "1110", "1120"].includes(a.code));
  const categories = accounts.filter((a) => (tx.kind === "sale" ? a.type === "income" : a.type === "expense" || a.code === "1300"));
  const canCategory = tx.kind === "sale" || tx.kind === "expense";

  const save = async () => {
    const parsed = parseRupiahInput(amount);
    if (!parsed) return setError("Nominalnya belum jelas. Contoh: 150000 atau 150rb.");
    const body: Record<string, string> = {};
    if (parsed.toString() !== tx.amountIdr) body.amountIdr = parsed.toString();
    if (date !== tx.date) body.date = date;
    if (tx.paymentCode && paymentCode !== tx.paymentCode) body.paymentCode = paymentCode;
    if (canCategory && categoryCode !== tx.categoryCode) body.categoryCode = categoryCode;
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      await api(`/api/transactions/${tx.id}/correct`, { method: "POST", idempotent: true, body: JSON.stringify(body) });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="Edit transaksi">
      <div className="w-full max-w-md space-y-3 rounded-xl border border-line bg-surface p-5">
        <h2 className="font-semibold">Edit: {tx.description}</h2>
        <label className="block text-sm text-ink-2">Nominal
          <input className={`${inputCls} num mt-1`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block text-sm text-ink-2">Tanggal
          <input type="date" className={`${inputCls} mt-1`} value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </label>
        {tx.paymentCode && (
          <label className="block text-sm text-ink-2">Dibayar lewat
            <select className={`${inputCls} mt-1`} value={paymentCode} onChange={(e) => setPaymentCode(e.target.value)}>
              {money.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
            </select>
          </label>
        )}
        {canCategory && (
          <label className="block text-sm text-ink-2">Kategori
            <select className={`${inputCls} mt-1`} value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
              {categories.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
            </select>
          </label>
        )}
        <p className="text-xs text-ink-3">Transaksi lama nggak diubah: dibatalkan lalu diganti yang benar, jadi riwayatnya tetap ada.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Batal</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Menyimpan…" : "Simpan"}</Button>
        </div>
      </div>
    </div>
  );
}
