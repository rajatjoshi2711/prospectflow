import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/guards";
import { leadStatusSchema } from "@/lib/campaigns/schemas";
import { firstIssue } from "@/lib/matching/schemas";

/**
 * Moves one lead through the outreach pipeline. This is the point of campaigns:
 * connection request pending -> accepted -> first message sent -> conversation
 * on-going.
 *
 * AUTHORIZATION
 * -------------
 * The ownership test is expressed as part of the WRITE, not as a separate read
 * beforehand:
 *
 *     updateMany({ where: { id: leadId, campaign: { id, userId } } })
 *
 * so there is no window between "checked" and "wrote", and a member who guesses
 * another member's lead id updates zero rows. `count === 0` is answered with a
 * 404 rather than a 403, so the route never confirms that a lead it will not
 * let you touch exists. Campaigns are personal — being signed in, or being an
 * org admin, grants nothing here.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; leadId: string }> },
) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { id, leadId } = await params;

  const json = await request.json().catch(() => null);
  const parsed = leadStatusSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const result = await prisma.campaignLead.updateMany({
    where: { id: leadId, campaign: { id, userId: guard.session.userId } },
    data: { status: parsed.data.status },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, status: parsed.data.status });
}
