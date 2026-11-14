"use client";

import { useEffect, useRef, useState } from "react";
import type { PnlBucket } from "@/lib/api";
import { dateShort, monthLong, rp, rpShort } from "@/lib/format";

/*
 * Income vs expense per period: grouped bars on one axis, series 1 / 2 of the
 * categorical palette, legend + hover tooltip + a table view. Heights are
 * display geometry only (Number of a BigInt ratio); every printed value comes
 * from the API's integer strings.
 */

const H = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 52 };

function label(b: PnlBucket, unit: "day" | "week" | "month") {
  if (unit === "month") return monthLong(b.from.slice(0, 7)).replace(/ \d{4}$/, "").slice(0, 3);
  if (unit === "week") return dateShort(b.from);
  return dateShort(b.from).split(" ")[0]!;
}

function niceMax(max: bigint): bigint {
  if (max <= 0n) return 100_000n;
  const digits = max.toString().length;
  const step = 10n ** BigInt(Math.max(digits - 1, 0));
  for (const m of [1n, 2n, 5n, 10n]) if (step * m >= max) return step * m;
  return step * 10n;
}

export function PnlChart({ buckets, unit }: { buckets: PnlBucket[]; unit: "day" | "week" | "month" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = niceMax(buckets.reduce((m, b) => [BigInt(b.incomeIdr), BigInt(b.expenseIdr), m].reduce((x, y) => (y > x ? y : x)), 0n));
  const innerW = w - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(buckets.length, 1);
  const barW = Math.max(2, Math.min(18, (slot - 6) / 2 - 1));
  const y = (v: string) => PAD.top + innerH - (Number((BigInt(v) * 10_000n) / max) / 10_000) * innerH;
  const ticks = [0n, max / 2n, max];
  const every = Math.ceil(buckets.length / Math.max(1, Math.floor(innerW / 44)));

  const bar = (x: number, v: string, color: string) => {
    const top = y(v);
    const h = PAD.top + innerH - top;
    if (h <= 0) return null;
    const r = Math.min(4, barW / 2, h);
    // Rounded data end, square at the baseline.
    return (
      <path
        d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`}
        fill={color}
      />
    );
  };

  const hb = hover === null ? null : buckets[hover];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-sm text-ink-2">
        <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-series-1" />Pemasukan</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-series-2" />Pengeluaran</span>
        <button className="ml-auto text-sm text-ink-2 underline underline-offset-2" onClick={() => setTable(!table)}>
          {table ? "Lihat grafik" : "Lihat tabel"}
        </button>
      </div>
      {table ? (
        <div className="overflow-x-auto">
          <table className="num w-full text-sm">
            <thead className="text-left text-ink-3">
              <tr><th className="py-1.5 font-normal">Periode</th><th className="text-right font-normal">Pemasukan</th><th className="text-right font-normal">Pengeluaran</th><th className="text-right font-normal">Laba</th></tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.from} className="border-t border-line">
                  <td className="py-1.5">{b.from === b.to ? dateShort(b.from) : `${dateShort(b.from)} – ${dateShort(b.to)}`}</td>
                  <td className="text-right">{rp(b.incomeIdr)}</td>
                  <td className="text-right">{rp(b.expenseIdr)}</td>
                  <td className="text-right">{rp(b.profitIdr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative">
          <svg width={w} height={H} role="img" aria-label="Grafik pemasukan dan pengeluaran per periode" onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t.toString()}>
                <line x1={PAD.left} x2={w - PAD.right} y1={y(t.toString())} y2={y(t.toString())} stroke="var(--line)" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t.toString())} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--ink-3)">{rpShort(t)}</text>
              </g>
            ))}
            {buckets.map((b, i) => {
              const cx = PAD.left + slot * i + slot / 2;
              return (
                <g key={b.from}>
                  {hover === i && <rect x={cx - slot / 2} y={PAD.top} width={slot} height={innerH} fill="var(--ink)" opacity={0.05} />}
                  {bar(cx - barW - 1, b.incomeIdr, "var(--series-1)")}
                  {bar(cx + 1, b.expenseIdr, "var(--series-2)")}
                  {i % every === 0 && (
                    <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--ink-3)">{label(b, unit)}</text>
                  )}
                  <rect x={cx - slot / 2} y={PAD.top} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
          {hb && (
            <div
              className="num pointer-events-none absolute top-2 z-10 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-sm"
              style={{ left: Math.min(Math.max(PAD.left + slot * hover! + slot / 2 - 80, 0), w - 170), width: 170 }}
            >
              <div className="mb-1 font-medium text-ink">{hb.from === hb.to ? dateShort(hb.from) : `${dateShort(hb.from)} – ${dateShort(hb.to)}`}</div>
              <div className="flex justify-between text-ink-2"><span><i className="mr-1 inline-block size-2 rounded-sm bg-series-1" />Masuk</span><span className="text-ink">{rp(hb.incomeIdr)}</span></div>
              <div className="flex justify-between text-ink-2"><span><i className="mr-1 inline-block size-2 rounded-sm bg-series-2" />Keluar</span><span className="text-ink">{rp(hb.expenseIdr)}</span></div>
              <div className="mt-1 flex justify-between border-t border-line pt-1 text-ink-2"><span>Laba</span><span className="text-ink">{rp(hb.profitIdr)}</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
