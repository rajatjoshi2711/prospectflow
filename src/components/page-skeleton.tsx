/**
 * Route-level loading placeholder.
 *
 * Every dashboard in ProspectFlow is a server component that runs several
 * database queries before it can render anything — counts, a page of rows,
 * interaction signals, stored scores. Without a `loading.tsx` the reader sits on
 * the previous page with no feedback for the whole of that, which reads as a
 * dead click.
 *
 * Deliberately plain grey blocks rather than a spinner: it shows WHERE content
 * will appear, and it is honest about the fact that nothing is known yet. No
 * pulse animation — the design system bans looping motion, and the global
 * `prefers-reduced-motion` rule would strip it for some readers anyway, leaving
 * an inconsistent experience.
 */
export function PageSkeleton({
  /** Roughly how many card-shaped blocks the real page renders. */
  cards = 3,
  /** Show the four-across stat row above the cards. */
  stats = false,
}: {
  cards?: number;
  stats?: boolean;
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <Block width="120px" height="12px" className="mb-3" />
      <Block width="min(420px, 80%)" height="36px" className="mb-3" />
      <Block width="min(620px, 95%)" height="20px" className="mb-8" />

      {stats ? (
        <div
          className="mb-8 grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
        >
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="ef-card">
              <Block width="60%" height="12px" className="mb-2" />
              <Block width="45%" height="24px" />
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        {Array.from({ length: cards }).map((_, index) => (
          <div key={index} className="ef-card">
            <Block width="35%" height="18px" className="mb-3" />
            <Block width="100%" height="12px" className="mb-2" />
            <Block width="90%" height="12px" className="mb-2" />
            <Block width="70%" height="12px" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Block({
  width,
  height,
  className,
}: {
  width: string;
  height: string;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={className}
      style={{
        width,
        height,
        borderRadius: 6,
        background: "var(--neutral-100)",
      }}
    />
  );
}
