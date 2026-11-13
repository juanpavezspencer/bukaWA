"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Business } from "@/lib/api";
import { Button, Notice } from "./ui";

const Ctx = createContext<{ business: Business; exportsEnabled: boolean } | null>(null);

export function useBusiness() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBusiness outside OwnerShell");
  return v;
}

const NAV: Array<[string, string]> = [
  ["/", "Ringkasan"],
  ["/transaksi", "Transaksi"],
  ["/kontak", "Piutang & utang"],
  ["/laporan", "Laporan"],
];

export function LoginHint() {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-xl font-semibold">Masuk ke BukuWA</h1>
      <p className="mt-3 text-ink-2">
        Buka chat BukuWA di WhatsApp lalu ketik <b className="text-ink">dashboard</b>. Kamu akan dapat link masuk yang berlaku 15 menit.
      </p>
      <p className="mt-3 text-sm text-ink-3">Nggak perlu password. Sesi di browser ini berlaku 7 hari.</p>
    </div>
  );
}

export function OwnerShell({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ business: Business; exportsEnabled: boolean } | "loading" | "out" | Error>("loading");
  const path = usePathname();

  useEffect(() => {
    api<{ business: Business; exportsEnabled: boolean }>("/api/me")
      .then(setState)
      .catch((e) => setState(e instanceof ApiError && e.status === 401 ? "out" : e));
  }, []);

  if (state === "loading") return <p className="p-6 text-ink-3">Memuat…</p>;
  if (state === "out") return <LoginHint />;
  if (state instanceof Error) return <div className="p-6"><Notice tone="error">{state.message}</Notice></div>;

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setState("out");
  };

  return (
    <Ctx.Provider value={state}>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="mr-auto">
            <div className="text-xs text-ink-3">BukuWA</div>
            <div className="font-semibold">{state.business.name}</div>
          </div>
          <Button variant="ghost" onClick={logout}>Keluar</Button>
          <nav className="flex w-full gap-1 overflow-x-auto text-sm">
            {NAV.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 ${path === href ? "bg-bg font-medium text-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-5">{children}</main>
    </Ctx.Provider>
  );
}
