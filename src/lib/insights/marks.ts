import "server-only";

import type { ConnectionMarkValue } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Loads a user's thumbs up / thumbs down marks for one page of rows.
 *
 * One query for the whole page rather than one per row: prospect pages are 25
 * rows and the table is the busiest read path in the app, so an N+1 here would
 * be 25 round-trips per render for a decoration-sized piece of data.
 *
 * Marks are keyed on the stable `identityKey` (see the `ConnectionMark` note in
 * the schema), which is why this takes keys rather than connection ids — the
 * ids change with every import, the keys do not.
 */
export async function loadConnectionMarks(
  userId: string,
  identityKeys: string[],
): Promise<Map<string, ConnectionMarkValue>> {
  const keys = [...new Set(identityKeys.filter(Boolean))];
  if (keys.length === 0) return new Map();

  const marks = await prisma.connectionMark.findMany({
    where: { userId, identityKey: { in: keys } },
    select: { identityKey: true, value: true },
  });

  return new Map(marks.map((mark) => [mark.identityKey, mark.value]));
}
