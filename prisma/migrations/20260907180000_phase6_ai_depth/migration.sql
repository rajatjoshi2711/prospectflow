-- Phase 6 (AI depth).
--
-- 1. `RelationshipStrengthScore` becomes upsertable: unique on
--    (userId, connectionId) so a recompute updates in place instead of stacking
--    a new row per run. Gains `basis` ("ai" | "heuristic") so the UI never
--    passes a rules-only number off as an AI one, and `updatedAt`.
-- 2. `QuickSuggestion` is reshaped from the Phase 1 placeholder (title +
--    description + metadata) into the real thing: it now names WHO should reach
--    out (`sourceUserId`) to WHOM (`targetConnectionId`), carries the suggestion
--    body, and can be dismissed. Unique on
--    (organizationId, sourceUserId, targetConnectionId) so the nightly sweep
--    refreshes rows rather than duplicating them — and a dismissal survives
--    regeneration because the generator never resets `dismissed`.
-- 3. One composite index for ProspectAsk's conversation replay.
--
-- MIGRATION SAFETY
-- ----------------
-- `QuickSuggestion` has never been written by application code (Phase 1 created
-- the table; nothing populated it), so the new NOT NULL columns have no rows to
-- break. The DELETE below makes that explicit and unconditional rather than
-- relying on it: a placeholder row could not be mapped onto the new shape
-- anyway, since it names neither a source user nor a target connection.
--
-- `RelationshipStrengthScore` is backfilled properly instead: `updatedAt` is
-- added nullable, filled from `computedAt`, then tightened to NOT NULL, and any
-- pre-existing duplicate (userId, connectionId) rows are collapsed to the most
-- recent before the unique index is created. Migrations auto-apply on
-- production deploys, so nothing here may assume an empty table it can lose.

-- --------------------------------------------------------------------------
-- QuickSuggestion
-- --------------------------------------------------------------------------

-- Placeholder rows (if any) cannot be expressed in the new shape.
DELETE FROM "QuickSuggestion";

ALTER TABLE "QuickSuggestion" DROP COLUMN "description",
ADD COLUMN     "dismissed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dismissedAt" TIMESTAMP(3),
ADD COLUMN     "sourceUserId" TEXT NOT NULL,
ADD COLUMN     "suggestionText" TEXT NOT NULL,
ADD COLUMN     "targetConnectionId" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- --------------------------------------------------------------------------
-- RelationshipStrengthScore
-- --------------------------------------------------------------------------

ALTER TABLE "RelationshipStrengthScore" ADD COLUMN     "basis" TEXT NOT NULL DEFAULT 'ai',
ADD COLUMN     "updatedAt" TIMESTAMP(3);

UPDATE "RelationshipStrengthScore" SET "updatedAt" = "computedAt" WHERE "updatedAt" IS NULL;

ALTER TABLE "RelationshipStrengthScore" ALTER COLUMN "updatedAt" SET NOT NULL;

-- Collapse any duplicate (userId, connectionId) rows written before the unique
-- constraint existed, keeping the most recently computed one.
DELETE FROM "RelationshipStrengthScore" a
USING "RelationshipStrengthScore" b
WHERE a."userId" = b."userId"
  AND a."connectionId" = b."connectionId"
  AND (a."computedAt", a."id") < (b."computedAt", b."id");

-- --------------------------------------------------------------------------
-- Indexes and foreign keys
-- --------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "ChatMessage_userId_conversationId_createdAt_idx" ON "ChatMessage"("userId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "QuickSuggestion_organizationId_dismissed_createdAt_idx" ON "QuickSuggestion"("organizationId", "dismissed", "createdAt");

-- CreateIndex
CREATE INDEX "QuickSuggestion_sourceUserId_idx" ON "QuickSuggestion"("sourceUserId");

-- CreateIndex
CREATE INDEX "QuickSuggestion_targetConnectionId_idx" ON "QuickSuggestion"("targetConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickSuggestion_organizationId_sourceUserId_targetConnectio_key" ON "QuickSuggestion"("organizationId", "sourceUserId", "targetConnectionId");

-- CreateIndex
CREATE INDEX "RelationshipStrengthScore_userId_score_idx" ON "RelationshipStrengthScore"("userId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "RelationshipStrengthScore_userId_connectionId_key" ON "RelationshipStrengthScore"("userId", "connectionId");

-- AddForeignKey
ALTER TABLE "QuickSuggestion" ADD CONSTRAINT "QuickSuggestion_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickSuggestion" ADD CONSTRAINT "QuickSuggestion_targetConnectionId_fkey" FOREIGN KEY ("targetConnectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
