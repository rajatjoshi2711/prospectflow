import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ComingSoon } from "@/components/coming-soon";

export default async function AdminChannelPartnersPage() {
  const session = await getSession();
  if (session?.role !== "ADMIN") {
    redirect("/dashboard");
  }

  return (
    <ComingSoon
      title="Channel partner definitions"
      description="Admins will define channel partners (name, industry, criteria) here."
      phase="Phase 4 — ICP / channel partner matching"
    />
  );
}
