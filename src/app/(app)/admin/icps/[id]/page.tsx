import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ComingSoon } from "@/components/coming-soon";

export default async function AdminIcpDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (session?.role !== "ADMIN") {
    redirect("/dashboard");
  }
  await params;

  return (
    <ComingSoon
      title="Edit ICP"
      description="ICP editing arrives with admin CRUD in Phase 4."
      phase="Phase 4 — ICP / channel partner matching"
    />
  );
}
