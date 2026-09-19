import type { AcceptancePoint } from "@/lib/insights/outreach-performance";

/**
 * Inferred invitation acceptance rate, by month sent.
 *
 * FORM: one measure (a rate) changing over time -> line chart. A single series,
 * so there is no legend — the card title names it — and no rainbow: one hue
 * carries the whole line. The value axis is pinned to 0–100% because a rate has
 * fixed bounds; letting it auto-scale would make a 40%-to-44% wobble look like a
 * doubling. The x positions come from the real month number, so a month in which
 * nothing was sent leaves a real gap instead of being silently closed up.
 *
 * COLOR: EmergeFlow Blue (`--blue-500`), the single-series default, checked
 * against the chart surface for the 3:1 non-text contrast floor.
 *
 * LOW-VOLUME MONTHS: a month with a handful of invitations produces a rate that
 * swings on one accept. Those points are drawn hollow — a secondary encoding, so
 * the distinction does not depend on color — and the caption says what the
 * threshold is. The rate is still plotted, because hiding it would be its own
 * kind of lie; it is just marked as thin evidence.
 *
 * ACCESSIBILITY: every point carries a native SVG tooltip with the underlying
 * counts, the first and last months are labelled, and the same numbers are
 * repeated in the table underneath so nothing depends on reading the plot.
 */

const WIDTH = 720;
const HEIGHT = 230;
const PADDING = { top: 16, right: 20, bottom: 34, left: 46 };

/** Below this many invitations in a month, the rate is too thin to read. */
const LOW_VOLUME_SENT = 5;

const LINE_COLOR = "var(--blue-500)";

function monthIndex(date: Date): number {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function InvitationAcceptanceChart({ points }: { points: AcceptancePoint[] }) {
  if (points.length === 0) return null;

  const indexed = points.map((point) => ({
    ...point,
    index: monthIndex(point.month),
    rate: (point.accepted / point.sent) * 100,
  }));

  const firstIndex = indexed[0].index;
  const lastIndex = indexed[indexed.length - 1].index;
  const span = Math.max(1, lastIndex - firstIndex);

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const x = (index: number) =>
    PADDING.left + (indexed.length === 1 ? plotWidth / 2 : ((index - firstIndex) / span) * plotWidth);
  const y = (rate: number) => PADDING.top + plotHeight - (rate / 100) * plotHeight;

  const path = indexed
    .map((point, i) => `${i === 0 ? "M" : "L"}${x(point.index)},${y(point.rate)}`)
    .join(" ");

  const hasLowVolume = indexed.some((point) => point.sent < LOW_VOLUME_SENT);

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          style={{ minWidth: 520, display: "block" }}
          role="img"
          aria-label="Inferred invitation acceptance rate by month sent"
        >
          {/* Recessive value grid: 0 / 50 / 100%, no box, no vertical rules. */}
          {[0, 50, 100].map((tick) => (
            <g key={tick}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--border-subtle)"
                strokeWidth={1}
              />
              <text
                x={PADDING.left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                fontSize={11}
                fill="var(--text-secondary)"
                fontFamily="var(--font-body)"
              >
                {tick}%
              </text>
            </g>
          ))}

          {indexed.length > 1 ? (
            <path d={path} fill="none" stroke={LINE_COLOR} strokeWidth={2} strokeLinejoin="round" />
          ) : null}

          {indexed.map((point) => {
            const thin = point.sent < LOW_VOLUME_SENT;
            return (
              <circle
                key={point.index}
                cx={x(point.index)}
                cy={y(point.rate)}
                r={4.5}
                // Hollow = too few invitations that month to read a rate from.
                fill={thin ? "var(--bg-page)" : LINE_COLOR}
                stroke={thin ? LINE_COLOR : "var(--bg-page)"}
                strokeWidth={2}
              >
                <title>
                  {`${monthLabel(point.month)} — ${point.accepted} of ${point.sent} invitation${
                    point.sent === 1 ? "" : "s"
                  } inferred accepted (${Math.round(point.rate)}%)`}
                </title>
              </circle>
            );
          })}

          {/* Only the first and last month are labelled; a label per month
              collides as soon as the export covers a couple of years. */}
          {[indexed[0], indexed[indexed.length - 1]]
            .filter((point, i, all) => all.indexOf(point) === i)
            .map((point, i, all) => (
              <text
                key={point.index}
                x={x(point.index)}
                y={HEIGHT - 12}
                textAnchor={all.length === 1 ? "middle" : i === 0 ? "start" : "end"}
                fontSize={11}
                fill="var(--text-secondary)"
                fontFamily="var(--font-body)"
              >
                {monthLabel(point.month)}
              </text>
            ))}
        </svg>
      </div>

      {/* The same numbers as text. `<details>` keeps a multi-year export from
          burying the rest of the dashboard, and needs no client JavaScript. */}
      <details className="mt-3">
        <summary className="ef-caption" style={{ cursor: "pointer", color: "var(--blue-500)" }}>
          Show the monthly numbers
        </summary>
        <div className="mt-2" style={{ overflowX: "auto" }}>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {["Month", "Sent", "Inferred accepted", "Rate"].map((heading) => (
                  <th
                    key={heading}
                    className="ef-caption"
                    style={{
                      padding: "4px 8px 4px 0",
                      color: "var(--text-secondary)",
                      fontWeight: 600,
                    }}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...indexed].reverse().map((point) => (
                <tr key={point.index}>
                  <td className="ef-caption" style={{ padding: "4px 8px 4px 0" }}>
                    {monthLabel(point.month)}
                  </td>
                  <td className="ef-caption" style={{ padding: "4px 8px 4px 0" }}>
                    {point.sent.toLocaleString()}
                  </td>
                  <td className="ef-caption" style={{ padding: "4px 8px 4px 0" }}>
                    {point.accepted.toLocaleString()}
                  </td>
                  <td className="ef-caption" style={{ padding: "4px 8px 4px 0" }}>
                    {Math.round(point.rate)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {hasLowVolume ? (
        <p className="ef-caption mt-2" style={{ color: "var(--text-secondary)" }}>
          Hollow points are months with fewer than {LOW_VOLUME_SENT} invitations sent — one accept
          moves that rate a long way, so read them as a handful of events rather than a rate.
        </p>
      ) : null}
    </div>
  );
}
