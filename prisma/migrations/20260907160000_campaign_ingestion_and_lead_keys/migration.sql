-- Phase 5 (Campaigns).
--
-- 1. `CampaignStatus` gives an uploaded lead list the same PENDING/PROCESSING/
--    COMPLETE/FAILED lifecycle `ImportBatch` has, plus DETECTING and
--    AWAITING_CONFIRMATION. Campaign ingestion deliberately pauses for a human:
--    the LinkedIn-URL column drives every downstream match, so it is confirmed
--    (or overridden) before a single lead row is written.
-- 2. `Campaign` gains the blob URL, the detection result (proposed column,
--    confidence, method), the header row + sampled rows for the confirmation
--    preview, the confirmed column, and completion counters.
-- 3. `CampaignLead` gains `identityKey` / `nameKey` — the SAME key design as
--    ingestion (src/lib/ingestion/identity-key.ts) — so leads link to
--    `Connection` rows by the exact `url:` key wherever the sheet carried a
--    profile URL, with the weak name key as a fallback. Storing the keys (as
--    opposed to recomputing them) lets leads be re-linked against a future
--    import without re-parsing the original spreadsheet.
--
-- Every added column is nullable or defaulted, so this applies cleanly to a
-- database that already holds campaigns. Existing campaigns land in PENDING
-- with no blobUrl, which the UI renders as an unfinished upload.

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('PENDING', 'DETECTING', 'AWAITING_CONFIRMATION', 'PROCESSING', 'COMPLETE', 'FAILED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "blobUrl" TEXT,
ADD COLUMN     "columnHeaders" TEXT[],
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "detectedColumn" TEXT,
ADD COLUMN     "detectionConfidence" DOUBLE PRECISION,
ADD COLUMN     "detectionMethod" TEXT,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "leadCount" INTEGER,
ADD COLUMN     "linkedinColumn" TEXT,
ADD COLUMN     "matchedLeadCount" INTEGER,
ADD COLUMN     "sampleRows" JSONB,
ADD COLUMN     "status" "CampaignStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "CampaignLead" ADD COLUMN     "identityKey" TEXT,
ADD COLUMN     "nameKey" TEXT,
ADD COLUMN     "position" TEXT;

-- CreateIndex
CREATE INDEX "Campaign_userId_createdAt_idx" ON "Campaign"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_blobUrl_idx" ON "Campaign"("blobUrl");

-- CreateIndex
CREATE INDEX "CampaignLead_campaignId_status_idx" ON "CampaignLead"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignLead_identityKey_idx" ON "CampaignLead"("identityKey");

-- CreateIndex
CREATE INDEX "CampaignLead_nameKey_idx" ON "CampaignLead"("nameKey");

