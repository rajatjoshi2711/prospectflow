/**
 * Top countries by connection count.
 *
 * Form: ranked magnitude across a single measure -> horizontal bar chart.
 * One series, so no legend (the title names it) and every bar shares one hue;
 * length carries the comparison. Values are direct-labelled at the bar end so
 * there is no value axis to read against, and the grid is omitted entirely.
 */
export type CountryCount = { country: string; count: number };

export function CountryBarChart({ data }: { data: CountryCount[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <ul className="flex flex-col gap-3" style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {data.map((row) => {
        const pct = Math.max(2, (row.count / max) * 100);
        return (
          <li key={row.country} className="flex items-center gap-3">
            <span
              className="ef-small truncate"
              style={{ width: 132, flexShrink: 0, color: "var(--text-secondary)" }}
              title={row.country}
            >
              {row.country}
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
              style={{ width: 64, flexShrink: 0, textAlign: "right", fontWeight: 600 }}
            >
              {row.count.toLocaleString()}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
