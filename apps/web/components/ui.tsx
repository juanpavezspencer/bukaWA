"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-ink-2">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-accent text-accent-ink hover:opacity-90",
    ghost: "border border-line text-ink hover:bg-bg",
    danger: "border border-line text-danger hover:bg-bg",
  }[variant];
  return <button {...p} className={`rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50 ${styles} ${className}`} />;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-line bg-surface p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1.5 text-sm ${value === v ? "bg-ink text-surface" : "text-ink-2 hover:text-ink"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "error" }) {
  return <p className={`rounded-lg border border-line bg-surface p-3 text-sm ${tone === "error" ? "text-danger" : "text-ink-2"}`}>{children}</p>;
}

export const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3";
