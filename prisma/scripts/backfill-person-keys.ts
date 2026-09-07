/**
 * Optional, idempotent backfill for batches imported before the person-key fix.
 *
 * Run with:  npx tsx prisma/scripts/backfill-person-keys.ts
 * (or any TS runner; it only needs DATABASE_URL in the environment)
 *
 * This is deliberately NOT part of the migration. Migrations should not
 * silently rewrite user data, and this rewrite is lossy in one direction:
 * legacy `MessageRecord.identityKey` was derived from the `From` name, so for
 * messages the account owner sent it points at the owner rather than the
 * counterparty. There is no way to recover the counterparty from that key
 * alone — only from the raw `from`/`to` columns, which is what this script
 * re-reads.
 *
 * WHAT IT DOES
 *   1. Fills `ImportBatch.ownerName` / `ownerNameKey` from the batch's user
 *      name (Profile.csv is no longer available at this point — it lives in the
 *      uploaded zip, not in the database).
 *   2. Fills `Connection.nameKey` from the first/last name columns.
 *   3. Re-keys `MessageRecord` and `Invitation` to the counterparty and sets
 *      `senderIsUser`, using the stored `from`/`to`/`direction` columns.
 *
 * WHAT IT CANNOT DO
 *   - It cannot recover profile URLs for messages/invitations, because the
 *     original CSV columns were never stored. Re-keyed rows therefore get a
 *     name-derived `identityKey` and rely on the `nameKey` join.
 *   - It does not recompute JobChangeEvent. Events written by the old
 *     Position-based diff are meaningless and should be deleted; do that
 *     explicitly if you want to (see DELETE at the bottom, commented out).
 *
 * RE-UPLOADING the LinkedIn export is strictly better than running this: a
 * fresh import gets exact URL-based keys, a Profile.csv-derived owner name,
 * and a correct connection-diffed job-change pass.
 */
import { PrismaClient } from "@prisma/client";
import {
  computeIdentityKey,
  computeNameKey,
  computeNameKeyFromParts,
  normalizeDisplayName,
} from "../../src/lib/ingestion/identity-key";

const prisma = new PrismaClient();
const PAGE = 500;

async function main() {
  const batches = await prisma.importBatch.findMany({
    select: { id: true, ownerName: true, user: { select: { name: true } } },
  });

  for (const batch of batches) {
    const ownerName = batch.ownerName ?? batch.user.name ?? null;
    const ownerNormalized = normalizeDisplayName(ownerName);

    if (!batch.ownerName && ownerName) {
      await prisma.importBatch.update({
        where: { id: batch.id },
        data: { ownerName, ownerNameKey: computeNameKey(ownerName) },
      });
    }

    // --- Connections: nameKey only; identityKey was already correct. --------
    for (let skip = 0; ; skip += PAGE) {
      const rows = await prisma.connection.findMany({
        where: { importBatchId: batch.id, nameKey: null },
        select: { id: true, firstName: true, lastName: true },
        take: PAGE,
      });
      if (rows.length === 0) break;
      await Promise.all(
        rows.map((row) =>
          prisma.connection.update({
            where: { id: row.id },
            data: { nameKey: computeNameKeyFromParts(row.firstName, row.lastName) },
          }),
        ),
      );
      if (rows.length < PAGE) break;
    }

    // --- Messages: re-key to the counterparty, record direction. ------------
    for (;;) {
      const rows = await prisma.messageRecord.findMany({
        where: { importBatchId: batch.id, nameKey: null },
        select: { id: true, from: true, to: true },
        take: PAGE,
      });
      if (rows.length === 0) break;
      await Promise.all(
        rows.map((row) => {
          let counterpartyName = row.from ?? row.to;
          let senderIsUser: boolean | null = null;
          if (ownerNormalized) {
            if (normalizeDisplayName(row.from) === ownerNormalized) {
              counterpartyName = row.to;
              senderIsUser = true;
            } else if (normalizeDisplayName(row.to) === ownerNormalized) {
              counterpartyName = row.from;
              senderIsUser = false;
            }
          }
          return prisma.messageRecord.update({
            where: { id: row.id },
            data: {
              counterpartyName,
              senderIsUser,
              nameKey: computeNameKey(counterpartyName),
              identityKey: computeIdentityKey({ firstName: counterpartyName }),
            },
          });
        }),
      );
    }

    // --- Invitations: re-key to the counterparty. ---------------------------
    for (;;) {
      const rows = await prisma.invitation.findMany({
        where: { importBatchId: batch.id, nameKey: null },
        select: { id: true, from: true, to: true, direction: true },
        take: PAGE,
      });
      if (rows.length === 0) break;
      await Promise.all(
        rows.map((row) => {
          const direction = row.direction?.trim().toLowerCase();
          let counterpartyName =
            direction === "outgoing" ? row.to : direction === "incoming" ? row.from : null;
          if (!counterpartyName && ownerNormalized) {
            counterpartyName =
              normalizeDisplayName(row.from) === ownerNormalized ? row.to : row.from;
          }
          counterpartyName ??= row.from ?? row.to;
          return prisma.invitation.update({
            where: { id: row.id },
            data: {
              counterpartyName,
              nameKey: computeNameKey(counterpartyName),
              identityKey: computeIdentityKey({ firstName: counterpartyName }),
            },
          });
        }),
      );
    }

    console.log(`backfilled batch ${batch.id} (owner: ${ownerName ?? "unknown"})`);
  }

  // Uncomment to discard job-change events produced by the old, broken
  // Position-based diff. They are identified by a null personName.
  // await prisma.jobChangeEvent.deleteMany({ where: { personName: null } });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
