import { NextResponse } from "next/server";
import type { ConnectionMarkValue } from "@prisma/client";
import { requireSession } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

/**
 * Set or clear the signed-in user's thumbs up / thumbs down on one person.
 *
 * SCOPING
 *   `userId` comes from the session and is never read from the body, so there
 *   is no id to tamper with and no way to write (or read) another member's
 *   opinion. Marks are private per member, like `RelationshipStrengthScore`.
 *
 * WHY THE identityKey IS VERIFIED BEFORE WRITING
 *   `ConnectionMark.identityKey` is deliberately not a foreign key — the person
 *   it names outlives any single `Connection` row — so nothing in the database
 *   stops a hand-crafted request from inserting arbitrary strings. Checking the
 *   key against the caller's OWN connections AND their OWN campaign leads keeps
 *   the table to people they actually have in front of them, and means a junk
 *   key gets a 404 rather than a stored row. The connection check spans every
 *   batch the user owns, not just the current snapshot, so a mark placed on a
 *   person who drops out of a later export is still a legitimate write; the
 *   campaign arm is what lets a cold lead who matched nobody in the network be
 *   marked useful or not, which is the whole point of triaging a lead list.
 *
 *   Deliberately NOT widened to the whole org's connections: a mark is a
 *   private opinion about someone the user themselves has, and the prospect
 *   page renders the control for the viewer's own key either way.
 *
 * TOGGLE / CLEAR
 *   `value: "UP" | "DOWN"` upserts. `value: null` deletes the row, which is how
 *   the UI undoes a misclick (clicking the already-active thumb sends null).
 *   Deleting rather than storing a neutral third state keeps exactly one
 *   representation of "no opinion". Both are idempotent, so a double click is
 *   harmless.
 */

export const runtime = "nodejs";

function parseValue(raw: unknown): ConnectionMarkValue | null | undefined {
  if (raw === null) return null;
  if (raw === "UP" || raw === "DOWN") return raw;
  return undefined;
}

export async function POST(request: Request) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { userId } = guard.session;

  const body = (await request.json().catch(() => null)) as
    | { identityKey?: unknown; value?: unknown }
    | null;

  const identityKey = typeof body?.identityKey === "string" ? body.identityKey.trim() : "";
  if (!identityKey) {
    return NextResponse.json({ error: "identityKey is required." }, { status: 400 });
  }

  const value = parseValue(body?.value);
  if (value === undefined) {
    return NextResponse.json({ error: "value must be \"UP\", \"DOWN\" or null." }, { status: 400 });
  }

  const [connection, lead] = await Promise.all([
    prisma.connection.findFirst({
      where: { identityKey, importBatch: { userId } },
      select: { id: true },
    }),
    prisma.campaignLead.findFirst({
      where: { identityKey, campaign: { userId } },
      select: { id: true },
    }),
  ]);
  if (!connection && !lead) {
    return NextResponse.json(
      { error: "No such person in your network or lead lists." },
      { status: 404 },
    );
  }

  if (value === null) {
    // deleteMany, not delete: clearing a mark that is already absent is a
    // no-op rather than a "record not found" error.
    await prisma.connectionMark.deleteMany({ where: { userId, identityKey } });
    return NextResponse.json({ ok: true, value: null });
  }

  await prisma.connectionMark.upsert({
    where: { userId_identityKey: { userId, identityKey } },
    create: { userId, identityKey, value },
    update: { value },
  });

  return NextResponse.json({ ok: true, value });
}
