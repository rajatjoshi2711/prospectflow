import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { CampaignUploader } from "@/components/campaign-uploader";
import { isLLMConfigured } from "@/lib/ai";

export default async function NewCampaignPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  return (
    <div>
      <p className="ef-eyebrow mb-2">Phase 5 — campaigns</p>
      <h1 className="ef-page mb-2">New campaign</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 680 }}>
        Upload your lead list. The LinkedIn URL column is detected from the data
        itself — you confirm it before a single lead is created.
      </p>

      <CampaignUploader />

      <div className="ef-card mt-8" style={{ maxWidth: 620, background: "var(--bg-subtle)" }}>
        <p className="ef-small mb-1" style={{ fontWeight: 700 }}>
          How column detection works
        </p>
        <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
          Every column is checked against the first 20 rows for LinkedIn profile
          links. A column where most cells match is picked straight away, with
          no AI involved.{" "}
          {isLLMConfigured()
            ? "Only when no column is a clear winner is the header row sent to the model for a second opinion."
            : "AI is not configured on this deployment, so when no column is a clear winner you pick one yourself."}{" "}
          Either way you see the result and can change it.
        </p>
      </div>

      <p className="ef-caption mt-6">
        <Link href="/campaigns" style={{ color: "var(--blue-500)" }}>
          Back to campaigns
        </Link>
      </p>
    </div>
  );
}
