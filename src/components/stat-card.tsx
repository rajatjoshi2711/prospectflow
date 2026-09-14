/**
 * The shared stat tile.
 *
 * One component so the dashboard and the org dashboard cannot drift apart, and
 * so the EmergeFlow rule about the brand gradient is enforced in one place: the
 * gradient treatment (`ef-card-stat`) is reserved for a SINGLE emphasised tile
 * per surface. A row of three gradient cards reads as decoration and, with
 * secondary-colored labels on it, fails contrast outright — which is what the
 * org dashboard was doing.
 *
 * Numbers use the 24px step of the type scale rather than an invented size.
 */
export function StatCard({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  /** At most one per surface. Paints the brand gradient behind the tile. */
  emphasis?: boolean;
}) {
  return (
    <div className={emphasis ? "ef-card-stat" : "ef-card"} style={{ minWidth: 0 }}>
      <p
        className="ef-caption mb-1"
        style={emphasis ? { color: "rgba(255,255,255,0.82)" } : undefined}
      >
        {label}
      </p>
      <p
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: "var(--fs-h3)",
          lineHeight: "var(--lh-h3)",
          color: emphasis ? "#fff" : undefined,
        }}
      >
        {value}
      </p>
    </div>
  );
}
