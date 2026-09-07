import { NextResponse } from "next/server";
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
