import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { inngest } from "@/inngest/client";
import { requireSession } from "@/lib/auth/guards";
import { confirmColumnSchema } from "@/lib/campaigns/schemas";
import { firstIssue } from "@/lib/matching/schemas";

/**
 * Confirms which column holds LinkedIn profile URLs, then queues lead creation.
 *
 * This is the gate the whole two-step upload flow exists for. Detection only
 * ever PROPOSES a column; nothing is written to `CampaignLead` until a human
 * has seen the proposal next to real sample values and accepted it or picked a
 * different column. The chosen column drives every lead-to-connection match, so
 * a silent wrong guess would quietly produce a campaign that matches nobody.
 *
 * AUTHORIZATION: the ownership filter is inside the update, so a campaign id
 * belonging to another user updates zero rows and returns 404.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const json = await request.json().catch(() => null);
  const parsed = confirmColumnSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const campaign = await prisma.campaign.findFirst({
    where: { id, userId: guard.session.userId },
    select: { id: true, status: true, columnHeaders: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (campaign.status !== "AWAITING_CONFIRMATION" && campaign.status !== "FAILED") {
    return NextResponse.json(
      { error: "This campaign is not waiting for a column to be confirmed." },
      { status: 409 },
    );
  }
  // The override must be one of the file's real headers — otherwise the build
  // job would find no such column and fail after the user had left the page.
  if (!campaign.columnHeaders.includes(parsed.data.column)) {
    return NextResponse.json(
      { error: "That column is not in the uploaded file." },
      { status: 400 },
    );
  }

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { linkedinColumn: parsed.data.column, status: "PROCESSING", errorMessage: null },
  });

  await inngest.send({ name: "campaign/leads.requested", data: { campaignId: campaign.id } });

  return NextResponse.json({ ok: true, column: parsed.data.column });
}
