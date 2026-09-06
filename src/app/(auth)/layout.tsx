export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-screen w-full items-center justify-center px-6 py-12"
      style={{ background: "var(--grad-brand-soft)" }}
    >
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center justify-center gap-2">
          <div
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-[10px]"
            style={{ background: "var(--grad-brand)" }}
          >
            <span className="ef-h3 text-white" style={{ fontSize: 18 }}>
              E
            </span>
          </div>
          <span className="ef-h3" style={{ fontSize: 20 }}>
            ProspectFlow
          </span>
        </div>
        <div className="ef-card ef-rise">{children}</div>
      </div>
    </div>
  );
}
