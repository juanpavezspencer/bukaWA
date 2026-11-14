"use client";

import { useState } from "react";
import { AdminLoginHint } from "@/components/admin";
import { Button, Card, inputCls, Notice } from "@/components/ui";
import { api } from "@/lib/api";
import { useAdmin } from "@/lib/use-admin";

interface Item {
  id: string;
  businessName: string;
  source: string;
  rawText: string | null;
  transcript: string | null;
  extraction: unknown;
  confidence: number | null;
  status: string;
  modelVersion: string | null;
  createdAt: string;
  reason: "failed" | "cancelled" | "low_confidence" | "reversed";
}

const REASON: Record<Item["reason"], string> = { failed: "Gagal", cancelled: "Dibatalkan owner", low_confidence: "Confidence rendah", reversed: "Dikoreksi setelah OK" };
const FIELDS = ["intent", "amount", "date", "category", "payment_method", "counterparty", "kind", "other"];

export default function ReviewQueue() {
  const [v, setV] = useState(0);
  const s = useAdmin<{ items: Item[] }>("/api/admin/review", v);
  if (s === "loading") return <p className="text-ink-3">Memuat…</p>;
  if (s === "out") return <AdminLoginHint />;
  if (s instanceof Error) return <Notice tone="error">{s.message}</Notice>;
  if (!s.items.length) return <Notice>Antrian kosong.</Notice>;
  return (
    <div className="space-y-3">
      {s.items.map((i) => <ReviewCard key={i.id} item={i} onDone={() => setV(v + 1)} />)}
    </div>
  );
}

function ReviewCard({ item, onDone }: { item: Item; onDone: () => void }) {
  const [wrong, setWrong] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (verdict: "correct" | "wrong" | "unclear") => {
    try {
      await api(`/api/admin/review/${item.id}`, { method: "POST", body: JSON.stringify({ verdict, wrongFields: verdict === "wrong" ? wrong : [], note: note || undefined }) });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title={`${item.businessName} · ${item.source} · ${new Date(item.createdAt).toLocaleString("id-ID")}`} action={<span className="rounded bg-bg px-2 py-0.5 text-xs text-ink-2">{REASON[item.reason]}{item.confidence !== null ? ` · ${item.confidence.toFixed(2)}` : ""}</span>}>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-xs text-ink-3">Pesan</div>
          <p className="whitespace-pre-wrap text-sm">{item.rawText ?? item.transcript ?? "—"}</p>
          {item.transcript && item.rawText && <p className="mt-1 text-xs text-ink-2">Transkrip: {item.transcript}</p>}
        </div>
        <div>
          <div className="text-xs text-ink-3">Ekstraksi {item.modelVersion ? `(${item.modelVersion})` : ""}</div>
          <pre className="max-h-48 overflow-auto rounded bg-bg p-2 text-xs">{item.extraction ? JSON.stringify(item.extraction, null, 2) : "—"}</pre>
        </div>
      </div>
      <fieldset className="mt-3 flex flex-wrap gap-3 text-sm">
        <legend className="mb-1 text-xs text-ink-3">Field yang salah</legend>
        {FIELDS.map((f) => (
          <label key={f} className="inline-flex items-center gap-1">
            <input type="checkbox" checked={wrong.includes(f)} onChange={(e) => setWrong(e.target.checked ? [...wrong, f] : wrong.filter((x) => x !== f))} />
            {f}
          </label>
        ))}
      </fieldset>
      <input className={`${inputCls} mt-3`} placeholder="Catatan (opsional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => submit("correct")}>Model benar</Button>
        <Button variant="danger" onClick={() => submit("wrong")} disabled={!wrong.length}>Model salah</Button>
        <Button variant="ghost" onClick={() => submit("unclear")}>Nggak jelas</Button>
      </div>
    </Card>
  );
}
