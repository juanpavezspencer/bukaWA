"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function AdminShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const nav: Array<[string, string]> = [["/admin", "Bisnis"], ["/admin/review", "Antrian review"]];
  return (
    <>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <span className="font-semibold">BukuWA admin</span>
          <nav className="flex gap-1 text-sm">
            {nav.map(([href, label]) => (
              <Link key={href} href={href} className={`rounded-md px-3 py-1.5 ${path === href ? "bg-bg font-medium" : "text-ink-2 hover:text-ink"}`}>{label}</Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-5">{children}</main>
    </>
  );
}

export function AdminLoginHint() {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-xl font-semibold">Admin BukuWA</h1>
      <p className="mt-3 text-ink-2">Dari nomor admin yang terdaftar, ketik <b className="text-ink">admin</b> ke BukuWA di WhatsApp untuk dapat link masuk (berlaku 10 menit).</p>
    </div>
  );
}
