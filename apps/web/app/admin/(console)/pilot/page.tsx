"use client";

import { useState, type FormEvent } from "react";
import { AdminLoginHint } from "@/components/admin";
import { Button, Card, inputCls, Notice, Segmented } from "@/components/ui";
import { api } from "@/lib/api";
import { rp } from "@/lib/format";
import { useAdmin } from "@/lib/use-admin";

interface Cohort {
  cohort: string;
  businesses: number;
  active: number;
  retentionEligible: number;
  retained: number;
  retentionPct: number | null;
  txPerActivePerWeek: number | null;
  autoConfirmPct: number | null;
  costIdr: string;
  costPerActiveIdr: string | null;
}
interface PilotBiz {
  id: string;
  name: string;
  cohort: string;
  createdAt: string;
  weeksSinceJoin: number;
  tx7d: number;
  active: boolean;
  retained: boolean | null;
  autoConfirmPct: number | null;
  costIdr: string;
}
interface Pilot {
  days: number;
  targets: { retentionWeek: number; retentionMinTx: number; costTargetIdr: string };
  cohorts: Cohort[];
  total: Cohort;
  businesses: PilotBiz[];
  replies: Array<{ kind: "text" | "photo" | "voice"; n: number; medianMs: number | null; p90Ms: number | null }>;
}
interface Invite {
  code: string;
  cohort: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}
interface Erasures {
  pending: Array<{ businessId: string; name: string; requestedAt: string; scheduledFor: string; cancelledAt: string | null }>;
  erased: Array<{ businessId: string; requestedAt: string; executedAt: string }>;
}

const date = (s: string) => new Date(s).toLocaleDateString("id-ID", { dateStyle: "medium" });
const pctText = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("id-ID")}%`);
const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} dtk`);

/** On/off target, always with an icon and words, never color alone. */
function Status({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="text-xs text-ink-3">belum ada data</span>;
  return ok ? (
    <span className="text-xs font-medium text-accent">✓ sesuai target</span>
  ) : (
    <span className="text-xs font-medium text-danger">✕ di bawah target</span>
  );
}

function Kpi({ label, value, target, ok, note }: { label: string; value: string; target: string; ok: boolean | null; note?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-sm text-ink-2">{label}</div>
      <div className="num mt-1 whitespace-nowrap text-2xl font-semibold">{value}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
        <span>Target {target}</span>
        <Status ok={ok} />
      </div>
      {note && <div className="mt-1 text-xs text-ink-3">{note}</div>}
    </div>
  );
}

function Invites() {
  const [version, setVersion] = useState(0);
  const s = useAdmin<{ invites: Invite[] }>("/api/admin/invites", version);
  const [cohort, setCohort] = useState("");
  const [maxUses, setMaxUses] = useState("20");
  const [days, setDays] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Invite | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ invite: Invite }>("/api/admin/invites", {
        method: "POST",
        body: JSON.stringify({ cohort: cohort.trim(), maxUses: Number(maxUses), ...(days ? { expiresInDays: Number(days) } : {}) }),
      });
      setMade(r.invite);
      setVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card title="Kode undangan pilot">
      <form onSubmit={create} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
        <label className="text-sm text-ink-2">
          Cohort
          <input className={`${inputCls} mt-1`} value={cohort} onChange={(e) => setCohort(e.target.value)} placeholder="bandung-fnb" pattern="[a-z0-9-]{2,40}" required />
        </label>
        <label className="text-sm text-ink-2">
          Maks. pemakaian
          <input className={`${inputCls} mt-1`} type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} required />
        </label>
        <label className="text-sm text-ink-2">
          Berlaku (hari)
          <input className={`${inputCls} mt-1`} type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <Button type="submit">Buat kode</Button>
      </form>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      {made && (
        <p className="mt-3 rounded-lg border border-line bg-bg p-3 text-sm">
          Kode baru <b className="num">{made.code}</b>. Minta pemilik usaha kirim <b>KODE {made.code}</b> ke nomor WhatsApp BukuWA.
        </p>
      )}
      {s === "loading" ? (
        <p className="mt-3 text-ink-3">Memuat…</p>
      ) : s === "out" || s instanceof Error ? null : s.invites.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">Belum ada kode.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="num w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_th]:whitespace-nowrap">
            <thead className="text-left text-ink-3">
              <tr><th className="py-2 font-normal">Kode</th><th className="font-normal">Cohort</th><th className="text-right font-normal">Dipakai</th><th className="font-normal">Berlaku sampai</th></tr>
            </thead>
            <tbody>
              {s.invites.map((i) => (
                <tr key={i.code} className="border-t border-line">
                  <td className="py-2 font-medium">{i.code}</td>
                  <td>{i.cohort}</td>
                  <td className="text-right">{i.uses} / {i.maxUses}</td>
                  <td className="text-ink-2">{i.expiresAt ? date(i.expiresAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ErasureList() {
  const s = useAdmin<Erasures>("/api/admin/erasures");
  if (s === "loading" || s === "out" || s instanceof Error) return null;
  const pending = s.pending.filter((p) => !p.cancelledAt);
  return (
    <Card title="Permintaan hapus data">
      {pending.length === 0 && s.erased.length === 0 ? (
        <p className="text-sm text-ink-3">Tidak ada permintaan.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {pending.map((p) => (
            <li key={p.businessId}><b>{p.name}</b> — diminta {date(p.requestedAt)}, dihapus otomatis {date(p.scheduledFor)}</li>
          ))}
          {s.erased.map((e) => (
            <li key={e.businessId} className="text-ink-2">Bisnis {e.businessId.slice(0, 8)}… sudah dihapus {date(e.executedAt)}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function PilotPage() {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const s = useAdmin<Pilot>(`/api/admin/pilot?days=${days}`);
  if (s === "loading") return <p className="text-ink-3">Memuat…</p>;
  if (s === "out") return <AdminLoginHint />;
  if (s instanceof Error) return <Notice tone="error">{s.message}</Notice>;

  const t = s.total;
  const costTarget = BigInt(s.targets.costTargetIdr);
  // Cost per active business, scaled to a month for the target comparison.
  const perActiveMonth = t.costPerActiveIdr === null ? null : (BigInt(t.costPerActiveIdr) * 30n) / BigInt(s.days);
  const reply = (k: "text" | "photo") => s.replies.find((r) => r.kind === k) ?? null;
  const text = reply("text");
  const photo = reply("photo");

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Pilot</h1>
        <Segmented label="Periode" value={days} onChange={setDays} options={[["7", "7 hari"], ["30", "30 hari"], ["90", "90 hari"]]} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          label={`Retensi minggu ke-${s.targets.retentionWeek}`}
          value={pctText(t.retentionPct)}
          target="40%+"
          ok={t.retentionPct === null ? null : t.retentionPct >= 40}
          note={`${t.retained} dari ${t.retentionEligible} bisnis (≥${s.targets.retentionMinTx} transaksi)`}
        />
        <Kpi label="Transaksi / bisnis aktif / minggu" value={t.txPerActivePerWeek?.toLocaleString("id-ID") ?? "—"} target="15+" ok={t.txPerActivePerWeek === null ? null : t.txPerActivePerWeek >= 15} note={`${t.active} dari ${t.businesses} bisnis aktif 7 hari terakhir`} />
        <Kpi label="Tercatat tanpa koreksi" value={pctText(t.autoConfirmPct)} target="70%+" ok={t.autoConfirmPct === null ? null : t.autoConfirmPct >= 70} />
        <Kpi label="Biaya / bisnis aktif / bulan" value={perActiveMonth === null ? "—" : rp(perActiveMonth)} target={`< ${rp(costTarget)}`} ok={perActiveMonth === null ? null : perActiveMonth < costTarget} note="AI + template WhatsApp" />
        <Kpi
          label="Waktu balas (median)"
          value={`${secs(text?.medianMs ?? null)} · ${secs(photo?.medianMs ?? null)}`}
          target="< 4 dtk teks · < 12 dtk foto"
          ok={text?.medianMs == null && photo?.medianMs == null ? null : (text?.medianMs ?? 0) < 4000 && (photo?.medianMs ?? 0) < 12000}
          note={`teks n=${text?.n ?? 0}, foto n=${photo?.n ?? 0}`}
        />
      </div>

      <Card title="Per cohort">
        <div className="overflow-x-auto">
          <table className="num w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_th]:whitespace-nowrap">
            <thead className="text-left text-ink-3">
              <tr>
                <th className="py-2 font-normal">Cohort</th><th className="text-right font-normal">Bisnis</th><th className="text-right font-normal">Aktif</th>
                <th className="text-right font-normal">Retensi</th><th className="text-right font-normal">Transaksi/minggu</th>
                <th className="text-right font-normal">Tanpa koreksi</th><th className="text-right font-normal">Biaya {s.days} hari</th>
              </tr>
            </thead>
            <tbody>
              {[...s.cohorts, t].map((c) => (
                <tr key={c.cohort} className={`border-t border-line ${c === t ? "font-semibold" : ""}`}>
                  <td className="py-2">{c.cohort}</td>
                  <td className="text-right">{c.businesses}</td>
                  <td className="text-right">{c.active}</td>
                  <td className="text-right">{pctText(c.retentionPct)}</td>
                  <td className="text-right">{c.txPerActivePerWeek?.toLocaleString("id-ID") ?? "—"}</td>
                  <td className="text-right">{pctText(c.autoConfirmPct)}</td>
                  <td className="text-right">{rp(BigInt(c.costIdr))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Per bisnis">
        <div className="overflow-x-auto">
          <table className="num w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_th]:whitespace-nowrap">
            <thead className="text-left text-ink-3">
              <tr>
                <th className="py-2 font-normal">Bisnis</th><th className="font-normal">Cohort</th><th className="text-right font-normal">Minggu ke-</th>
                <th className="text-right font-normal">Transaksi 7 hari</th><th className="font-normal">Retensi</th>
                <th className="text-right font-normal">Tanpa koreksi</th><th className="text-right font-normal">Biaya {s.days} hari</th>
              </tr>
            </thead>
            <tbody>
              {s.businesses.map((b) => (
                <tr key={b.id} className="border-t border-line">
                  <td className="py-2 font-medium">{b.name}</td>
                  <td className="text-ink-2">{b.cohort}</td>
                  <td className="text-right">{b.weeksSinceJoin + 1}</td>
                  <td className="text-right">{b.tx7d}</td>
                  <td>{b.retained === null ? <span className="text-ink-3">—</span> : b.retained ? "✓ ya" : "✕ tidak"}</td>
                  <td className="text-right">{pctText(b.autoConfirmPct)}</td>
                  <td className="text-right">{rp(BigInt(b.costIdr))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Invites />
      <ErasureList />
    </>
  );
}
