import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ComingSoon } from "@/components/coming-soon";

export default async function AdminIcpsPage() {
  const session = await getSession();
  if (session?.role !== "ADMIN") {
    redirect("/dashboard");
  }

  return (
    <ComingSoon
      title="ICP definitions"
      description="Admins will define Ideal Customer Profiles (country, industry, positions, description) here."
      phase="Phase 4 — ICP / channel partner matching"
    />
  );
}
