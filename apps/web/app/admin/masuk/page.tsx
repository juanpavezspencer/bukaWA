"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AdminLoginHint } from "@/components/admin";
import { Notice } from "@/components/ui";
import { api, takeFragmentToken } from "@/lib/api";

export default function AdminMasuk() {
  const router = useRouter();
  const [state, setState] = useState<"working" | "none" | string>("working");
  useEffect(() => {
    const token = takeFragmentToken();
    if (!token) return setState("none");
    api("/api/admin/auth/exchange", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => router.replace("/admin"))
      .catch((e: Error) => setState(e.message));
  }, [router]);
  if (state === "working") return <p className="p-6 text-ink-3">Sedang masuk…</p>;
  if (state === "none") return <AdminLoginHint />;
  return <div className="mx-auto max-w-md px-4 py-16"><Notice tone="error">{state}</Notice></div>;
}
