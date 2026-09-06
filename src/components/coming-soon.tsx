export function ComingSoon({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase: string;
}) {
  return (
    <div>
      <p className="ef-eyebrow mb-2">{phase}</p>
      <h1 className="ef-page mb-2">{title}</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 640 }}>
        {description}
      </p>
      <div
        className="ef-card ef-rise flex flex-col items-start gap-3"
        style={{ maxWidth: 480 }}
      >
        <span className="ef-badge ef-badge-info">Coming soon</span>
        <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
          This part of ProspectFlow is scoped for a later phase of the build.
          The foundation (auth, org setup, and admin controls) is live today.
        </p>
      </div>
    </div>
  );
}
