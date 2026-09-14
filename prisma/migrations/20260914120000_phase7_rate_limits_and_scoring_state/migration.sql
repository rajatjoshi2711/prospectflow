-- Phase 7 (Polish).
--
-- 1. `AiUsageCounter` — the fixed-window counter behind the AI rate limiter
--    (src/lib/ai/rate-limit.ts). Postgres rather than KV/Redis deliberately:
--    serverless instances cannot hold a shared in-memory counter, and Postgres
--    is already a hard dependency of every route being protected, so this adds
--    no new infrastructure. See the model doc in schema.prisma.
-- 2. `User.relationshipScoreRequestedAt` / `relationshipScoreComputedAt` — the
--    pair that lets the UI say "relationship scoring is running" honestly.
--    Scoring happens in Inngest, out of band; without these the dashboard
--    cannot tell "the job is mid-flight" from "there is no interaction data".
--
-- MIGRATION SAFETY
-- ----------------
-- This file auto-applies on production deploys (`vercel-build`), so every
-- statement is written to be re-runnable and non-destructive: additive columns
-- only, all nullable with no backfill (NULL means "never requested" / "never
-- computed", which is exactly right for existing rows), and IF NOT EXISTS on
-- the new table and its indexes. Nothing is dropped and no existing row is
-- rewritten, so a partial application followed by a retry is safe.
--
-- The statements match `prisma migrate diff` for this schema change, with
-- IF NOT EXISTS added.

-- --------------------------------------------------------------------------
-- Relationship-scoring state on User
-- --------------------------------------------------------------------------

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "relationshipScoreComputedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "relationshipScoreRequestedAt" TIMESTAMP(3);

-- --------------------------------------------------------------------------
-- AI usage counters (rate limiting)
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AiUsageCounter" (
    "id" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "windowKind" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiUsageCounter_windowStart_idx" ON "AiUsageCounter"("windowStart");

-- CreateIndex
-- The limiter's upsert conflict target. Without this index the ON CONFLICT
-- clause in `consumeAiQuota` fails outright, so it must exist before any Phase 7
-- code serves a request — which is guaranteed here, since migrations run before
-- the build that ships that code.
CREATE UNIQUE INDEX IF NOT EXISTS "AiUsageCounter_subjectKey_bucket_windowKind_windowStart_key" ON "AiUsageCounter"("subjectKey", "bucket", "windowKind", "windowStart");
