"use client";

import { use } from "react";
import { AdminLoginHint } from "@/components/admin";
import { Card, Notice } from "@/components/ui";
import { useAdmin } from "@/lib/use-admin";

interface Msg {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  templateName: string | null;
  createdAt: string;
}

export default function BusinessMessages({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const s = useAdmin<{ business: { name: string }; messages: Msg[] }>(`/api/admin/businesses/${id}/messages`);
  if (s === "loading") return <p className="text-ink-3">Memuat…</p>;
  if (s === "out") return <AdminLoginHint />;
  if (s instanceof Error) return <Notice tone="error">{s.message}</Notice>;
  return (
    <Card title={`Log pesan: ${s.business.name}`} action={<span className="text-xs text-ink-3">NIK/NPWP dan nomor HP disamarkan · akses ini dicatat</span>}>
      <ul className="space-y-2">
        {s.messages.map((m) => (
          <li key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : ""}`}>
            <div className={`max-w-[85%] rounded-lg border border-line px-3 py-2 text-sm ${m.direction === "outbound" ? "bg-bg" : "bg-surface"}`}>
              <div className="whitespace-pre-wrap break-words">{m.body ?? <i className="text-ink-3">[{m.templateName ?? m.type}]</i>}</div>
              <div className="mt-1 text-[11px] text-ink-3">{m.direction === "inbound" ? "masuk" : "keluar"} · {m.type} · {new Date(m.createdAt).toLocaleString("id-ID")}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
