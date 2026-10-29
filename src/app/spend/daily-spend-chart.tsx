"use client";

import { useState } from "react";
import { formatUsd } from "@/lib/cost";
import { niceTicks, type DailySpend } from "@/lib/spend-series";

// Fixed drawing space; the SVG scales to its container.
const WIDTH = 720;
const HEIGHT = 240;
const MARGIN = { top: 12, right: 8, bottom: 28, left: 52 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

const dayLabel = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const fullDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const axisUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumSignificantDigits: 3,
});

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** Column with a rounded data end and a square base on the baseline. */
function barPath(x: number, top: number, width: number, height: number) {
  const r = Math.min(RADIUS, width / 2, height);
  const base = top + height;
  return [
    `M${x},${base}`,
    `V${top + r}`,
    `Q${x},${top} ${x + r},${top}`,
    `H${x + width - r}`,
    `Q${x + width},${top} ${x + width},${top + r}`,
    `V${base}`,
    "Z",
  ].join(" ");
}

/** Which days get an x-axis label: about six, always including the last. */
function labelledDays(count: number): Set<number> {
  const step = count <= 7 ? 1 : Math.ceil(count / 6);
  const indices = new Set<number>();
  for (let i = count - 1; i >= 0; i -= step) indices.add(i);
  return indices;
}

export function DailySpendChart({
  days,
  label,
}: {
  days: DailySpend[];
  /** Describes what's plotted, e.g. "Daily spend, last 30 days". */
  label: string;
}) {
  const [active, setActive] = useState<number | null>(null);

  const amounts = days.map((d) => Number(d.costUsd));
  const max = Math.max(0, ...amounts);
  const ticks = niceTicks(max);
  const top = ticks.at(-1) || 1;
  const slot = PLOT_W / days.length;
  const barWidth = Math.max(1, Math.min(MAX_BAR, slot - GAP));
  const y = (value: number) => MARGIN.top + PLOT_H - (value / top) * PLOT_H;
  const labelled = labelledDays(days.length);
  const activeDay = active === null ? null : days[active];

  return (
    <div className="viz relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${label}. Highest day ${formatUsd(max)}.`}
        onPointerLeave={() => setActive(null)}
      >
        {/* Gridlines and y-axis ticks */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? "var(--viz-baseline)" : "var(--viz-grid)"}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={MARGIN.left - 8}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
              fontSize={11}
              fill="var(--viz-text-muted)"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {axisUsd.format(tick)}
            </text>
          </g>
        ))}

        {days.map((day, i) => {
          const amount = amounts[i];
          const height = MARGIN.top + PLOT_H - y(amount);
          const slotX = MARGIN.left + i * slot;
          const barX = slotX + (slot - barWidth) / 2;
          return (
            <g key={day.day}>
              {amount > 0 && (
                <path
                  d={barPath(barX, y(amount), barWidth, height)}
                  fill={
                    active === i
                      ? "var(--viz-series-1-hover)"
                      : "var(--viz-series-1)"
                  }
                />
              )}
              {labelled.has(i) && (
                <text
                  // The last label ends at the plot edge so it isn't clipped.
                  x={
                    i === days.length - 1
                      ? WIDTH - MARGIN.right
                      : slotX + slot / 2
                  }
                  y={HEIGHT - 8}
                  textAnchor={i === days.length - 1 ? "end" : "middle"}
                  fontSize={11}
                  fill="var(--viz-text-muted)"
                >
                  {dayLabel.format(asDate(day.day))}
                </text>
              )}
              {/* Full-height hit target, larger than the bar itself */}
              <rect
                x={slotX}
                y={MARGIN.top}
                width={slot}
                height={PLOT_H}
                fill="transparent"
                tabIndex={0}
                aria-label={`${fullDay.format(asDate(day.day))}: ${formatUsd(amount)}`}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="outline-none focus-visible:stroke-[var(--viz-baseline)]"
              />
            </g>
          );
        })}
      </svg>

      {max === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-foreground/60">
          No spend in this range
        </p>
      )}

      {activeDay && active !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 rounded-md border px-3 py-2 text-sm shadow-sm"
          style={{
            left: `${((MARGIN.left + (active + 0.5) * slot) / WIDTH) * 100}%`,
            // Keep the tooltip inside the chart near its edges.
            transform: `translateX(${active < days.length * 0.15 ? "0" : active > days.length * 0.85 ? "-100%" : "-50%"})`,
            background: "var(--viz-tooltip-bg)",
            borderColor: "var(--viz-tooltip-border)",
          }}
        >
          <p className="font-semibold tabular-nums">
            {formatUsd(Number(activeDay.costUsd))}
          </p>
          <p className="whitespace-nowrap text-xs text-foreground/70">
            {fullDay.format(asDate(activeDay.day))}
          </p>
        </div>
      )}
    </div>
  );
}
