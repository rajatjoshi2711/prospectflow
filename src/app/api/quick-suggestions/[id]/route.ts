import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/guards";
import { firstIssue } from "@/lib/matching/schemas";

/**
 * Dismiss (or restore) one quick suggestion.
 *
 * AUTHORIZATION
 * -------------
 * Quick suggestions are ORG-level: they are visible to every member, and any
 * member may dismiss one — a suggestion that says "Alice should approach Bob"
 * is the org's business, and Alice is not always the person who knows it is a
 * dead end. So the scope is the organization, not the source user.
 *
 * The org check is expressed as part of the WRITE rather than as a read
 * beforehand:
 *
 *     updateMany({ where: { id, organizationId } })
 *
 * so there is no gap between checking and writing, and a member who guesses
 * another org's suggestion id updates zero rows. `count === 0` answers 404
 * rather than 403, so the route never confirms that a row it will not let you
 * touch exists.
 *
 * A dismissal is durable by design: the regeneration job upserts on
 * (organizationId, sourceUserId, targetConnectionId) and never resets
 * `dismissed`, and pruning skips dismissed rows — so tonight's sweep will not
 * bring this suggestion back.
 */

const bodySchema = z.object({
  dismissed: z.boolean(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const result = await prisma.quickSuggestion.updateMany({
    where: { id, organizationId: guard.session.organizationId },
    data: {
      dismissed: parsed.data.dismissed,
      dismissedAt: parsed.data.dismissed ? new Date() : null,
    },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, dismissed: parsed.data.dismissed });
}
