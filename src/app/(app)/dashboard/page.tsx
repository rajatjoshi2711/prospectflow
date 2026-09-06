import { getSession } from "@/lib/auth/session";
import { ComingSoon } from "@/components/coming-soon";

export default async function DashboardPage() {
  const session = await getSession();

  return (
    <div>
      <p className="ef-eyebrow mb-2">Dashboard</p>
      <h1 className="ef-page mb-2">Welcome back{session ? `, ${session.name.split(" ")[0]}` : ""}</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 640 }}>
        Your personal view of country analytics, job-change alerts, and import
        reminders will live here.
      </p>
      <ComingSoon
        title="User dashboard"
        description="Country analytics, the 15-day import reminder, and job-change alerts arrive in Phase 3 of the build."
        phase="Phase 3 — diffing & core dashboards"
      />
    </div>
  );
}
