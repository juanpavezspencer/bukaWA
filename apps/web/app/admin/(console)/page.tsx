"use client";

import Link from "next/link";
import { AdminLoginHint } from "@/components/admin";
import { Card, Notice } from "@/components/ui";
import { useAdmin } from "@/lib/use-admin";

interface Biz {
  id: string;
  name: string;
  type: string;
  plan: string;
  createdAt: string;
  messages7d: number;
  failedCaptures: number;
  entries: number;
  lastMessageAt: string | null;
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "—");

export default function AdminHome() {
  const s = useAdmin<{ businesses: Biz[] }>("/api/admin/businesses");
  if (s === "loading") return <p className="text-ink-3">Memuat…</p>;
  if (s === "out") return <AdminLoginHint />;
  if (s instanceof Error) return <Notice tone="error">{s.message}</Notice>;
  return (
    <Card title={`${s.businesses.length} bisnis`}>
      <div className="overflow-x-auto">
        <table className="num w-full text-sm [&_td]:px-2 [&_th]:px-2 [&_th]:whitespace-nowrap">
          <thead className="text-left text-ink-3">
            <tr>
              <th className="py-2 font-normal">Bisnis</th><th className="font-normal">Paket</th>
              <th className="text-right font-normal">Pesan 7 hari</th><th className="text-right font-normal">Transaksi</th>
              <th className="text-right font-normal">Gagal ekstrak</th><th className="font-normal">Pesan terakhir</th>
            </tr>
          </thead>
          <tbody>
            {s.businesses.map((b) => (
              <tr key={b.id} className="border-t border-line">
                <td className="py-2"><Link className="font-medium underline-offset-2 hover:underline" href={`/admin/bisnis/${b.id}`}>{b.name}</Link><div className="text-xs text-ink-3">{b.type}</div></td>
                <td>{b.plan}</td>
                <td className="text-right">{b.messages7d}</td>
                <td className="text-right">{b.entries}</td>
                <td className={`text-right ${b.failedCaptures ? "text-danger" : ""}`}>{b.failedCaptures}</td>
                <td className="text-ink-2">{when(b.lastMessageAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
