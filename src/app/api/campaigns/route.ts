import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/guards";

/**
 * The caller's own campaigns.
 *
 * Campaigns are PERSONAL, not org-wide (unlike ICPs and channel partners), so
 * the filter is `userId`, never `organizationId`. There is no route that
 * returns someone else's campaigns.
 *
 * `?blobUrl=` narrows to the campaign created for one uploaded file. The
 * campaign row is created by the Blob completion webhook, so the browser does
 * not learn its id from the upload call; it polls this with the blob URL that
 * `uploadPresigned` returned. Still fully scoped — a blob URL belonging to
 * another user simply matches nothing.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { session } = guard;

  const blobUrl = request.nextUrl.searchParams.get("blobUrl");

  const campaigns = await prisma.campaign.findMany({
    where: { userId: session.userId, ...(blobUrl ? { blobUrl } : {}) },
    orderBy: { createdAt: "desc" },
    take: blobUrl ? 1 : 100,
    select: {
      id: true,
      name: true,
      status: true,
      sourceFileName: true,
      leadCount: true,
      matchedLeadCount: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true,
      _count: { select: { leads: true } },
    },
  });

  return NextResponse.json({
    campaigns: campaigns.map(({ _count, ...campaign }) => ({
      ...campaign,
      // `leadCount` is written once at completion; `_count` is live. Prefer the
      // live count while a campaign is still building so the list is honest.
      leadCount: campaign.leadCount ?? _count.leads,
    })),
  });
}
