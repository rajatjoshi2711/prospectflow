import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

/**
 * Delete one note.
 *
 * AUTHORIZATION, ENFORCED IN THE QUERY
 *   A member may delete their OWN note. Org ADMINs may delete any note in their
 *   org, because a shared, org-visible surface needs someone able to remove
 *   something inappropriate; that is the only asymmetry, and it is documented on
 *   `ProspectNote` in the schema as well.
 *
 *   Both rules live in the WHERE clause of a single `deleteMany` rather than in
 *   a read-then-check-then-delete sequence. That keeps the check and the write
 *   atomic (no window between them), and means a hand-crafted request for
 *   someone else's note id deletes ZERO rows rather than relying on application
 *   flow control to stop it. `count === 0` is then reported as 404 for both "no
 *   such note" and "not yours" — a member has no business learning that a note
 *   they cannot touch exists.
 *
 *   `organizationId` is in the filter too, so an admin of one org can never
 *   reach another org's notes.
 *
 *   Hiding the delete button in the UI is not access control; this route is.
 */

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { userId, organizationId, role } = guard.session;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "A note id is required." }, { status: 400 });
  }

  const { count } = await prisma.prospectNote.deleteMany({
    where: {
      id,
      organizationId,
      // An ADMIN gets no author filter; everyone else is restricted to their own.
      ...(role === "ADMIN" ? {} : { authorId: userId }),
    },
  });

  if (count === 0) {
    return NextResponse.json({ error: "No such note." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
