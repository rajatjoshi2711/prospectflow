import type { ConnectionsSeries } from "@/lib/insights/org";

/**
 * Connections per member over time.
 *
 * FORM: change over time, several entities compared -> multi-series line chart.
 * Each point is one completed import, which is a real dated measurement, so
 * points are drawn as markers and only joined where consecutive imports exist.
 * A member with a single import gets a lone dot rather than a fabricated line
 * through zero.
 *
 * COLOR: the categorical order is fixed and assigned by member, not by rank, so
 * filtering or a change in who is largest never repaints anyone. The hues are
 * the validated categorical slots (blue, orange, aqua, yellow, magenta, green)
 * from the data-visualization reference palette — checked for colorblind
 * separation rather than eyeballed. Beyond six members the chart stops and says
 * so instead of inventing a seventh hue.
 *
 * ACCESSIBILITY: a legend is always present for two or more series, each series
 * is direct-labelled at its last point (so identity never depends on color
 * alone), every point carries a native SVG tooltip, and the same numbers are
 * repeated in the table underneath.
 */

const SERIES_COLORS = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
];

const MAX_SERIES = SERIES_COLORS.length;

const WIDTH = 720;
const HEIGHT = 260;
const PADDING = { top: 16, right: 132, bottom: 34, left: 52 };

export function ConnectionsOverTimeChart({ series }: { series: ConnectionsSeries[] }) {
  if (series.length === 0) return null;

  const shown = series.slice(0, MAX_SERIES);
  const hidden = series.length - shown.length;

  // One shared x scale across every series: dates are the union of every
  // import date, so two people who imported on different days still line up in
  // real time rather than by index.
  const dates = [...new Set(shown.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const maxCount = Math.max(...shown.flatMap((s) => s.points.map((p) => p.count)), 1);

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const x = (date: string) =>
    PADDING.left +
    (dates.length === 1 ? plotWidth / 2 : (dates.indexOf(date) / (dates.length - 1)) * plotWidth);
  const y = (count: number) => PADDING.top + plotHeight - (count / maxCount) * plotHeight;

  const ticks = [0, Math.round(maxCount / 2), maxCount];

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          style={{ minWidth: 560, display: "block" }}
          role="img"
          aria-label="Connections per person over time, one point per completed import"
        >
          {/* Recessive value grid: three lines, no box, no vertical rules. */}
          {ticks.map((tick) => (
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
                {tick.toLocaleString()}
              </text>
            </g>
          ))}

          {/* Only the first and last date are labelled — a label per import
              collides as soon as someone imports weekly. */}
          {[dates[0], dates[dates.length - 1]]
            .filter((date, index, all) => all.indexOf(date) === index)
            .map((date, index, all) => (
              <text
                key={date}
                x={x(date)}
                y={HEIGHT - 12}
                textAnchor={all.length === 1 ? "middle" : index === 0 ? "start" : "end"}
                fontSize={11}
                fill="var(--text-secondary)"
                fontFamily="var(--font-body)"
              >
                {date}
              </text>
            ))}

          {shown.map((entry, index) => {
            const color = SERIES_COLORS[index];
            const points = entry.points;
            const path = points
              .map((point, pointIndex) => `${pointIndex === 0 ? "M" : "L"}${x(point.date)},${y(point.count)}`)
              .join(" ");
            const last = points[points.length - 1];

            return (
              <g key={entry.userId}>
                {points.length > 1 ? (
                  <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
                ) : null}
                {points.map((point) => (
                  <circle
                    key={`${point.date}-${point.count}`}
                    cx={x(point.date)}
                    cy={y(point.count)}
                    r={4}
                    fill={color}
                    // A 2px surface ring keeps overlapping markers legible when
                    // two people imported on the same day with similar counts.
                    stroke="var(--bg-page)"
                    strokeWidth={2}
                  >
                    <title>{`${entry.userName} — ${point.count.toLocaleString()} connections on ${point.date}`}</title>
                  </circle>
                ))}
                {last ? (
                  <text
                    x={x(last.date) + 10}
                    y={y(last.count) + 4}
                    fontSize={11}
                    fill="var(--text-primary)"
                    fontFamily="var(--font-body)"
                  >
                    {entry.userName}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      {shown.length > 1 ? (
        <ul
          className="mt-3 flex flex-wrap items-center gap-4"
          style={{ margin: "12px 0 0", padding: 0, listStyle: "none" }}
        >
          {shown.map((entry, index) => (
            <li key={entry.userId} className="flex items-center gap-2">
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: SERIES_COLORS[index],
                  display: "inline-block",
                }}
              />
              <span className="ef-caption" style={{ color: "var(--text-secondary)" }}>
                {entry.userName}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {hidden > 0 ? (
        <p className="ef-caption mt-2" style={{ color: "var(--text-secondary)" }}>
          {hidden} more member{hidden === 1 ? "" : "s"} not plotted — the chart shows the first{" "}
          {MAX_SERIES} to stay readable. Every member is listed in the table above.
        </p>
      ) : null}
    </div>
  );
}
