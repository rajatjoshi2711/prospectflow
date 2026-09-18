"use client";

import { useId, useState } from "react";

/**
 * Usage by model / by use case.
 *
 * FORM: ranked magnitude across a single measure (tokens) -> horizontal bar
 * chart. One series, so no legend (the card title names it) and every bar
 * shares one hue; length carries the whole comparison. Values are direct-labelled at the bar end, so
 * there is no value axis to read against and no grid.
 *
 * Bars are ordered by size and the hue is fixed, never assigned by rank — a
 * filter that drops a category must not repaint the survivors.
 *
 * THE ⓘ DISCLOSURE: the rate card (for models) and the average cost per call
 * (for use cases) are reference numbers, not part of the comparison the chart
 * is making. Putting them permanently beside the bars would double the ink for
 * something read once a month, so they live behind a toggle — as a TABLE, since
 * they are exact figures to be read, not magnitudes to be compared.
 */

export type UsageBar = {
  key: string;
  label: string;
  /** Drives bar length. Tokens, not dollars: dollars are unknown for unpriced models. */
  value: number;
  /** Direct label at the end of the bar. */
  valueLabel: string;
  /** Extra line under the label, e.g. an under-reporting caveat. */
  note?: string;
};

export type UsageInfo = {
  /** Accessible name of the ⓘ button, e.g. "Show cost rates by model". */
  buttonLabel: string;
  heading: string;
  columns: string[];
  rows: string[][];
  /** Shown under the table — provenance, caveats. */
  footnote?: string;
};

export function AiUsageBarChart({
  title,
  description,
  bars,
  info,
  emptyMessage,
}: {
  title: string;
  description?: string;
  bars: UsageBar[];
  info: UsageInfo;
  emptyMessage: string;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const panelId = useId();

  const max = Math.max(...bars.map((bar) => bar.value), 1);

  return (
    <div className="ef-card">
      <div className="mb-1 flex items-start justify-between gap-3">
        <h2 className="ef-subhead" style={{ fontSize: 16 }}>
          {title}
        </h2>
        {/* A real button, not an icon-only div: it is the only way to reach the
            rate table, so it needs a name, focus and Enter/Space for free. */}
        <button
          type="button"
          className="ef-btn ef-btn-text"
          aria-expanded={showInfo}
          aria-controls={panelId}
          aria-label={info.buttonLabel}
          title={info.buttonLabel}
          onClick={() => setShowInfo((open) => !open)}
          style={{ padding: "2px 8px", lineHeight: 1.2 }}
        >
          <span aria-hidden style={{ fontSize: 15 }}>
            ⓘ
          </span>
        </button>
      </div>

      {description ? (
        <p className="ef-caption mb-4" style={{ color: "var(--text-secondary)" }}>
          {description}
        </p>
      ) : null}

      {bars.length === 0 ? (
        <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
          {emptyMessage}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {bars.map((bar) => {
            // A 2% floor keeps a tiny-but-nonzero category visible as a mark
            // rather than vanishing into the track.
            const pct = Math.max(2, (bar.value / max) * 100);
            return (
              <li key={bar.key} className="flex items-center gap-3">
                <span style={{ width: 170, flexShrink: 0 }}>
                  <span
                    className="ef-small block truncate"
                    style={{ color: "var(--text-secondary)" }}
                    title={bar.label}
                  >
                    {bar.label}
                  </span>
                  {bar.note ? (
                    <span className="ef-caption block" style={{ color: "var(--text-secondary)" }}>
                      {bar.note}
                    </span>
                  ) : null}
                </span>
                <span
                  aria-hidden
                  style={{
                    flex: 1,
                    height: 14,
                    background: "var(--neutral-50)",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      width: `${pct}%`,
                      height: "100%",
                      background: "var(--blue-500)",
                      borderRadius: "0 4px 4px 0",
                    }}
                  />
                </span>
                <span
                  className="ef-small"
                  style={{ width: 96, flexShrink: 0, textAlign: "right", fontWeight: 600 }}
                >
                  {bar.valueLabel}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {showInfo ? (
        <div
          id={panelId}
          className="mt-4 rounded-[10px] p-3"
          style={{ background: "var(--bg-subtle)" }}
        >
          <p className="ef-small mb-2" style={{ fontWeight: 700 }}>
            {info.heading}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr>
                  {info.columns.map((column) => (
                    <th
                      key={column}
                      className="ef-caption px-2 py-1"
                      style={{ fontWeight: 700, whiteSpace: "nowrap" }}
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {info.rows.map((row) => (
                  <tr key={row[0]} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                    {row.map((cell, index) => (
                      <td
                        key={index}
                        className="ef-caption px-2 py-1"
                        style={{
                          whiteSpace: "nowrap",
                          fontFamily: index === 0 ? undefined : "var(--font-mono)",
                        }}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {info.footnote ? (
            <p className="ef-caption mt-2" style={{ color: "var(--text-secondary)" }}>
              {info.footnote}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
