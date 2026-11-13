"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LoginHint } from "@/components/session";
import { Notice } from "@/components/ui";
import { api, takeFragmentToken } from "@/lib/api";

/** Magic-link landing: the token is in the #fragment so it never reaches logs or Referer headers. */
export default function MasukPage() {
  const router = useRouter();
  const [state, setState] = useState<"working" | "none" | string>("working");

  useEffect(() => {
    const token = takeFragmentToken();
    if (!token) return setState("none");
    api("/api/auth/exchange", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => router.replace("/"))
      .catch((e: Error) => setState(e.message));
  }, [router]);

  if (state === "working") return <p className="p-6 text-ink-3">Sedang masuk…</p>;
  if (state === "none") return <LoginHint />;
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Notice tone="error">{state}</Notice>
    </div>
  );
}
