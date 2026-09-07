-- Phase 4 (ICP / channel partner matching).
--
-- 1. `MatchType` makes "is this an ICP match or a channel-partner match?" a
--    single indexed column instead of a null-check across two FK columns.
-- 2. Unique constraints on (connectionId, icpId) and (connectionId,
--    channelPartnerId) make re-scoring IDEMPOTENT: the matching job upserts,
--    so re-running it (after a new import, or after an admin edits an ICP)
--    updates the existing row instead of appending a duplicate. Postgres
--    treats NULLs as distinct in a unique index, so a channel-partner row
--    (icpId IS NULL) never collides with another channel-partner row.
-- 3. Score is folded into the definition indexes, since every dashboard reads
--    "top matches for this ICP, highest score first".
--
-- Any pre-existing duplicate pairs are collapsed before the constraints are
-- added (highest score wins, newest as the tie-break) so this applies cleanly
-- to a database that already holds matches.

-- CreateEnum
CREATE TYPE "MatchType" AS ENUM ('ICP', 'CHANNEL_PARTNER');

-- AlterTable: add the column with a temporary default so existing rows are
-- valid, backfill from whichever FK is set, then drop the default.
ALTER TABLE "ProspectMatch" ADD COLUMN "matchType" "MatchType" NOT NULL DEFAULT 'ICP';

UPDATE "ProspectMatch"
SET "matchType" = 'CHANNEL_PARTNER'
WHERE "channelPartnerId" IS NOT NULL;

ALTER TABLE "ProspectMatch" ALTER COLUMN "matchType" DROP DEFAULT;

-- Collapse duplicates that predate the unique constraints.
DELETE FROM "ProspectMatch" a
USING "ProspectMatch" b
WHERE a."connectionId" = b."connectionId"
  AND a."icpId" IS NOT NULL
  AND a."icpId" = b."icpId"
  AND (a."score", a."createdAt", a."id") < (b."score", b."createdAt", b."id");

DELETE FROM "ProspectMatch" a
USING "ProspectMatch" b
WHERE a."connectionId" = b."connectionId"
  AND a."channelPartnerId" IS NOT NULL
  AND a."channelPartnerId" = b."channelPartnerId"
  AND (a."score", a."createdAt", a."id") < (b."score", b."createdAt", b."id");

-- DropIndex
DROP INDEX IF EXISTS "ProspectMatch_icpId_idx";
DROP INDEX IF EXISTS "ProspectMatch_channelPartnerId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "ProspectMatch_connectionId_icpId_key" ON "ProspectMatch"("connectionId", "icpId");
CREATE UNIQUE INDEX "ProspectMatch_connectionId_channelPartnerId_key" ON "ProspectMatch"("connectionId", "channelPartnerId");
CREATE INDEX "ProspectMatch_icpId_score_idx" ON "ProspectMatch"("icpId", "score");
CREATE INDEX "ProspectMatch_channelPartnerId_score_idx" ON "ProspectMatch"("channelPartnerId", "score");
CREATE INDEX "ProspectMatch_matchType_score_idx" ON "ProspectMatch"("matchType", "score");
