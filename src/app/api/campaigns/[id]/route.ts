import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/guards";

/**
 * One campaign's status, for the detail page to poll while detection or lead
 * building is still running.
 *
 * Ownership is part of the WHERE clause, so another user's id returns 404 —
 * the same answer a nonexistent id gives, which keeps the route from
 * confirming that someone else's campaign exists.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const campaign = await prisma.campaign.findFirst({
    where: { id, userId: guard.session.userId },
    select: {
      id: true,
      name: true,
      status: true,
      sourceFileName: true,
      linkedinColumn: true,
      detectedColumn: true,
      detectionConfidence: true,
      detectionMethod: true,
      leadCount: true,
      matchedLeadCount: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true,
    },
  });

  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ campaign });
}

/**
 * Deletes a campaign and everything attached to it.
 *
 * IRREVERSIBLE. `CampaignLead` cascades on the foreign key, so this also drops
 * every lead — including any outreach status the user set by hand, which is
 * the only part that cannot be reproduced by re-uploading the same file. The
 * UI therefore asks for a second, explicit confirmation naming the lead count
 * rather than deleting on a single click.
 *
 * Ownership is part of the WHERE clause, exactly as in GET: another user's id
 * returns 404 rather than deleting anything, and gives the same answer as a
 * nonexistent id so the route never confirms someone else's campaign exists.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const campaign = await prisma.campaign.findFirst({
    where: { id, userId: guard.session.userId },
    select: { id: true, name: true, blobUrl: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.campaign.delete({ where: { id: campaign.id } });

  // Best effort: drop the uploaded spreadsheet too, so deleting a campaign
  // does not silently leave the user's file in blob storage. A failure here
  // must not fail the request — the campaign is already gone, and reporting an
  // error would wrongly suggest it was not.
  if (campaign.blobUrl) {
    try {
      await del(campaign.blobUrl);
    } catch {
      // Orphaned blob; harmless, and not worth surfacing to the user.
    }
  }

  return NextResponse.json({ ok: true, name: campaign.name });
}
