-- AlterTable
ALTER TABLE "CampaignLead" ADD COLUMN     "statusSetAt" TIMESTAMP(3);

-- Backfill: preserve statuses a user actually set before this column existed.
--
-- `status` is written exactly twice: at creation, always as REQUEST_PENDING,
-- and by the PATCH route when a user changes it. So any row sitting at a value
-- other than REQUEST_PENDING can only have got there by a deliberate edit, and
-- must keep outranking derived status. `updatedAt` is the best available
-- timestamp for when that happened.
--
-- Rows still at REQUEST_PENDING are deliberately left NULL. That value is
-- indistinguishable from the creation default, so treating it as a user
-- assertion is exactly the bug this migration exists to fix -- those rows fall
-- through to derivation, which is the intended behavior.
UPDATE "CampaignLead"
SET "statusSetAt" = "updatedAt"
WHERE "status" <> 'REQUEST_PENDING';
